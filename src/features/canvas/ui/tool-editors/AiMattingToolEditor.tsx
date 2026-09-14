import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crosshair, Loader2, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react';
import { Circle, Group, Image as KonvaImage, Layer, Rect, Stage } from 'react-konva';
import type Konva from 'konva';

import type { ToolOptions } from '@/features/canvas/tools';
import {
  applyNegativeClears,
  appendPoint,
  clearPoints,
  decodeMaskWithRecovery,
  fillMaskHoles,
  featherMask,
  generateAutoPoints,
  maskForegroundRatio,
  negativeClearRadius,
  pickEffectiveModel,
  pointsToTriples,
  removePointAt,
  resolveAvailableModels,
  rgbaToGrayLuminance,
  upsampleMaskGuided,
  type AiMattingModel,
  type AiMattingPoint,
} from '@/features/canvas/application/aiMatting';
import {
  samDecode,
  samEmbed,
  samHealth,
  SamServiceError,
} from '@/commands/sam';
import { loadImageElement } from '@/features/canvas/application/imageData';
import { useSettingsStore } from '@/stores/settingsStore';
import type { VisualToolEditorProps } from './types';

const VIEWPORT_PADDING_PX = 16;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;
/** 超大图（长边 > 4096）embed 前先降采样上传，蒙版放大回原尺寸合成（服务端上限 50MB）。 */
const EMBED_MAX_DIMENSION = 4096;
const CHECKER_CELL_PX = 16;
/** 双面板：左右 50% + gap-3，顶部标签行 h-6；面板边框与取整余量让 Stage 略缩于面板内。 */
const PANEL_GAP_PX = 12;
const PANEL_LABEL_ROW_PX = 24;
const PANEL_BORDER_ALLOWANCE_PX = 4;
/** 滚轮缩放：步进 1.1，上限 8×，下限为面板内 fit 缩放。 */
const VIEW_SCALE_STEP = 1.1;
const VIEW_SCALE_MAX = 8;

type HealthState = 'checking' | 'ok' | 'error';
type BusyState = '' | 'embedding' | 'decoding';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 模型档 → 人话名：vit_t 整体（快）/ vit_l 高召回（大模型）；未知档显示原始 id。
 *  vit_b（细节 HQ）已下线（resolveAvailableModels 过滤），不出现在界面。 */
function modelDisplayName(model: string, t: (key: string) => string): string {
  switch (model) {
    case 'vit_t':
      return t('aiMatting.modelFast');
    case 'vit_l':
      return t('aiMatting.modelLarge');
    default:
      return model;
  }
}

/** 棋盘格底（模拟透明背景），Konva fillPatternImage 用。 */
function createCheckerPatternCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_CELL_PX * 2;
  canvas.height = CHECKER_CELL_PX * 2;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#c4c4c4';
  context.fillRect(0, 0, CHECKER_CELL_PX, CHECKER_CELL_PX);
  context.fillRect(CHECKER_CELL_PX, CHECKER_CELL_PX, CHECKER_CELL_PX, CHECKER_CELL_PX);
  return canvas;
}

/** 原图 → PNG base64（长边 > maxDimension 时等比降采样上传）。 */
function imageToPngBase64(
  image: HTMLImageElement,
  maxDimension: number
): { base64: string; width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('canvas unavailable');
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
}

/** 蒙版 PNG base64 → 灰度数组 + 实际宽高（浏览器原生解码，luminance 取灰度；尺寸随服务端版本 256/1024）。 */
function decodeMaskPng(
  maskPngBase64: string
): Promise<{ gray: Uint8Array; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        reject(new Error('canvas unavailable'));
        return;
      }
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.naturalWidth, image.naturalHeight);
      resolve({
        gray: rgbaToGrayLuminance(data),
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = () => reject(new Error('mask png decode failed'));
    image.src = `data:image/png;base64,${maskPngBase64}`;
  });
}

/** 合成抠图（原图 + 羽化蒙版 alpha）→ PNG dataURL。 */
function composeCutoutDataUrl(
  source: HTMLImageElement,
  feathered: Uint8Array,
  width: number,
  height: number
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return '';
  }
  context.drawImage(source, 0, 0, width, height);
  const maskImageData = context.createImageData(width, height);
  for (let i = 0; i < feathered.length; i += 1) {
    maskImageData.data[i * 4 + 3] = feathered[i];
  }
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  maskCanvas.getContext('2d')?.putImageData(maskImageData, 0, 0);
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(maskCanvas, 0, 0);
  context.globalCompositeOperation = 'source-over';
  return canvas.toDataURL('image/png');
}

export function AiMattingToolEditor({
  options,
  onOptionsChange,
  sourceImageUrl,
}: VisualToolEditorProps) {
  const { t } = useTranslation();
  const aiMattingBaseUrl = useSettingsStore((state) => state.aiMattingBaseUrl);
  const [healthState, setHealthState] = useState<HealthState>('checking');
  const [healthMessage, setHealthMessage] = useState('');
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [model, setModel] = useState<AiMattingModel>('vit_t');
  /** 服务实际支持的模型档（health.models 驱动；未连通前按旧服务兜底两档）。 */
  const [availableModels, setAvailableModels] = useState<AiMattingModel[]>(() =>
    resolveAvailableModels(undefined)
  );
  const [points, setPoints] = useState<AiMattingPoint[]>([]);
  const [embedId, setEmbedId] = useState('');
  const [busy, setBusy] = useState<BusyState>('');
  const [errorMessage, setErrorMessage] = useState('');
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  /** 左面板视图变换（绝对显示缩放，域 [fitScale, 8]）与平移位置；右面板只读镜像同一变换保证对比对齐。 */
  const [viewScale, setViewScale] = useState(1);
  const [viewPos, setViewPos] = useState({ x: 0, y: 0 });

  const stageRef = useRef<Konva.Stage | null>(null);
  const contentGroupRef = useRef<Konva.Group | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const embedIdRef = useRef('');
  const requestIdRef = useRef(0);
  const guideRef = useRef<{ width: number; height: number; data: Uint8ClampedArray } | null>(null);
  /** 最近一次 decode 成功的服务端原生蒙版（负点变更时免网络、本地重合成）。 */
  const serverMaskRef = useRef<{ mask: Uint8Array; width: number; height: number } | null>(null);
  /** 最近一次已发起（decode 或本地重合成）的点集签名，防 busy 竞争丢点 + 失败死循环。 */
  const lastAttemptSigRef = useRef('');
  /** 最近一次 decode 成功时的正点签名（含 embedId），用于区分「正点变了」与「仅负点变了」。 */
  const lastDecodedPositiveSigRef = useRef('');

  const checkerPattern = useMemo(() => createCheckerPatternCanvas(), []);

  /** 左右面板各占一半（flex-1 + gap-3），Stage 数值尺寸 = viewport 扣 padding/gap/标签行/边框。 */
  const panelSize = useMemo(
    () => ({
      width: Math.max(
        VIEWPORT_MIN_WIDTH_PX,
        Math.round((viewportSize.width - VIEWPORT_PADDING_PX * 2 - PANEL_GAP_PX) / 2)
          - PANEL_BORDER_ALLOWANCE_PX
      ),
      height: Math.max(
        VIEWPORT_MIN_HEIGHT_PX,
        viewportSize.height - VIEWPORT_PADDING_PX * 2 - PANEL_LABEL_ROW_PX - PANEL_BORDER_ALLOWANCE_PX
      ),
    }),
    [viewportSize.width, viewportSize.height]
  );

  const { stageWidth, stageHeight, scale } = useMemo(() => {
    if (!image) {
      return { stageWidth: 820, stageHeight: 480, scale: 1 };
    }
    const maxWidth = Math.max(VIEWPORT_MIN_WIDTH_PX, panelSize.width);
    const maxHeight = Math.max(VIEWPORT_MIN_HEIGHT_PX, panelSize.height);
    const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    return {
      stageWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
      stageHeight: Math.max(1, Math.round(image.naturalHeight * ratio)),
      scale: ratio,
    };
  }, [image, panelSize.width, panelSize.height]);

  /** 图 fit 后在面板内居中的偏移（= 复位视图的 viewPos）。 */
  const fitCenter = useMemo(
    () => ({
      x: Math.round((panelSize.width - stageWidth) / 2),
      y: Math.round((panelSize.height - stageHeight) / 2),
    }),
    [panelSize.width, panelSize.height, stageWidth, stageHeight]
  );

  /** 后处理链：孔洞填充 → 引导滤波上采样（guide=原图亮度）→ 1px 羽化 → 负点硬清除 → 合成预览。
   *  蒙版宽高取 decode PNG 实际尺寸（旧服务 256 / 升级后 1024 均适配）；纯本地计算，负点变更时直接重跑。 */
  const postProcess = useCallback(
    (allPoints: AiMattingPoint[]) => {
      const imageElement = imageRef.current;
      const cached = serverMaskRef.current;
      if (!imageElement || !cached) {
        return;
      }
      const { width: originalWidth, height: originalHeight } = imageElement;
      const holed = fillMaskHoles(cached.mask, cached.width, cached.height);
      if (
        !guideRef.current
        || guideRef.current.width !== originalWidth
        || guideRef.current.height !== originalHeight
      ) {
        const guideCanvas = document.createElement('canvas');
        guideCanvas.width = originalWidth;
        guideCanvas.height = originalHeight;
        const guideContext = guideCanvas.getContext('2d', { willReadFrequently: true });
        if (!guideContext) {
          return;
        }
        guideContext.drawImage(imageElement, 0, 0, originalWidth, originalHeight);
        guideRef.current = {
          width: originalWidth,
          height: originalHeight,
          data: guideContext.getImageData(0, 0, originalWidth, originalHeight).data,
        };
      }
      const enhanced = upsampleMaskGuided(
        holed,
        cached.width,
        cached.height,
        guideRef.current.data,
        originalWidth,
        originalHeight
      );
      const feathered = featherMask(enhanced, originalWidth, originalHeight);
      const cleared = applyNegativeClears(feathered, originalWidth, originalHeight, allPoints);
      const foregroundRatio = maskForegroundRatio(cleared);
      const dataUrl = composeCutoutDataUrl(imageElement, cleared, originalWidth, originalHeight);
      const preview = new window.Image();
      preview.onload = () => setPreviewImage(preview);
      preview.src = dataUrl;
      onOptionsChange({ ...options, aiMattingResultDataUrl: dataUrl } as ToolOptions);
      if (foregroundRatio <= 0.001) {
        setErrorMessage(t('aiMatting.maskEmpty'));
      }
    },
    [onOptionsChange, options, t]
  );

  const runDecode = useCallback(
    async (currentPoints: AiMattingPoint[], currentModel: AiMattingModel) => {
      const imageElement = imageRef.current;
      // 负点是客户端橡皮擦（applyNegativeClears），不参与 SAM decode——
      // 实测软负点在白底/透明底 sprite 上几乎无效，点多了还会让蒙版整体崩塌
      const positives = currentPoints.filter((point) => point.label === 1);
      if (!imageElement || positives.length === 0 || !embedIdRef.current) {
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setBusy('decoding');
      setErrorMessage('');
      try {
        const { embedId: finalEmbedId, mask, maskWidth, maskHeight } = await decodeMaskWithRecovery({
          points: positives,
          embedId: embedIdRef.current,
          model: currentModel,
          decode: async (id, pts) => {
            const result = await samDecode(aiMattingBaseUrl, id, currentModel, pointsToTriples(pts));
            const decoded = await decodeMaskPng(result.maskPngBase64);
            return { mask: decoded.gray, width: decoded.width, height: decoded.height };
          },
          embed: async (embedModel) => {
            const upload = imageToPngBase64(imageElement, EMBED_MAX_DIMENSION);
            const embedResult = await samEmbed(aiMattingBaseUrl, upload.base64, embedModel);
            embedIdRef.current = embedResult.embedId;
            setEmbedId(embedResult.embedId);
            return embedResult.embedId;
          },
          isEmbedExpired: (error) =>
            error instanceof SamServiceError && error.kind === 'embed_expired',
        });
        if (requestId !== requestIdRef.current) {
          return;
        }
        embedIdRef.current = finalEmbedId;
        setEmbedId(finalEmbedId);
        serverMaskRef.current = { mask, width: maskWidth, height: maskHeight };
        lastDecodedPositiveSigRef.current = `${finalEmbedId}::${pointsToTriples(positives)
          .map((triple) => triple.join(','))
          .join(';')}`;
        postProcess(currentPoints);
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setErrorMessage(
          error instanceof SamServiceError
            ? `${t('aiMatting.decodeFailed')}：${error.message}`
            : t('aiMatting.decodeFailed')
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setBusy('');
        }
      }
    },
    [aiMattingBaseUrl, postProcess, t]
  );

  const runEmbed = useCallback(
    async (currentModel: AiMattingModel) => {
      const imageElement = imageRef.current;
      if (!imageElement) {
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setBusy('embedding');
      setErrorMessage('');
      try {
        const upload = imageToPngBase64(imageElement, EMBED_MAX_DIMENSION);
        const result = await samEmbed(aiMattingBaseUrl, upload.base64, currentModel);
        if (requestId !== requestIdRef.current) {
          return;
        }
        embedIdRef.current = result.embedId;
        setEmbedId(result.embedId);
        // embedId 变化会触发点变更 effect 重 decode（已有点保留），此处不再显式 decode
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setErrorMessage(
          error instanceof SamServiceError
            ? `${t('aiMatting.embedFailed')}：${error.message}`
            : t('aiMatting.embedFailed')
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setBusy('');
        }
      }
    },
    [aiMattingBaseUrl, t]
  );

  const checkHealth = useCallback(async () => {
    setHealthState('checking');
    setErrorMessage('');
    try {
      const health = await samHealth(aiMattingBaseUrl);
      if (!health.ok) {
        setHealthState('error');
        setHealthMessage(t('aiMatting.healthOffline'));
        return;
      }
      // 模型档自适应：以 health.models 为唯一真相源（旧服务只回 vit_t/vit_b 时行为零变化）；
      // 当前选中档服务端不支持时自动落到可用档首项并重 embed。
      const models = resolveAvailableModels(health.models);
      setAvailableModels(models);
      const effectiveModel = pickEffectiveModel(model, models);
      if (effectiveModel !== model) {
        setModel(effectiveModel);
      }
      setHealthState('ok');
      if (imageRef.current) {
        await runEmbed(effectiveModel);
      }
    } catch (error) {
      setHealthState('error');
      setHealthMessage(
        error instanceof SamServiceError
          ? `${t('aiMatting.healthOffline')} · ${error.message}`
          : t('aiMatting.healthOffline')
      );
    }
  }, [aiMattingBaseUrl, model, runEmbed, t]);

  // 加载原图
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const img = await loadImageElement(sourceImageUrl);
        if (cancelled) {
          return;
        }
        imageRef.current = img;
        setImage(img);
      } catch {
        if (!cancelled) {
          imageRef.current = null;
          setImage(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceImageUrl]);

  // 进入先 health：通→自动 embed（vit_t）
  useEffect(() => {
    void checkHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceImageUrl, aiMattingBaseUrl]);

  // 点变更自动驱动：正点变化 → 重新 decode；仅负点变化 → 用缓存蒙版本地重合成（免网络）。
  // busy 中点的新点在本 effect 于 busy 结束后补跑（busy 在依赖里）；lastAttemptSig 防 decode 失败后死循环重试。
  useEffect(() => {
    if (!embedId || busy !== '' || points.length === 0) {
      return;
    }
    const positives = points.filter((point) => point.label === 1);
    const positiveSig = `${embedId}::${pointsToTriples(positives)
      .map((triple) => triple.join(','))
      .join(';')}`;
    const negativeSig = pointsToTriples(points.filter((point) => point.label === 0))
      .map((triple) => triple.join(','))
      .join(';');
    const sig = `${positiveSig}##${negativeSig}`;
    if (sig === lastAttemptSigRef.current) {
      return;
    }
    lastAttemptSigRef.current = sig;
    if (positives.length === 0) {
      return;
    }
    if (serverMaskRef.current && positiveSig === lastDecodedPositiveSigRef.current) {
      postProcess(points);
      return;
    }
    void runDecode(points, model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, embedId, busy]);

  // viewport 自适应
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }
    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** 复位视图：回到面板内 fit + 居中（image/面板尺寸变化时经 fitCenter/scale 变化自动触发复位）。 */
  const resetView = useCallback(() => {
    setViewScale(scale);
    setViewPos(fitCenter);
  }, [fitCenter, scale]);

  useEffect(() => {
    setViewScale(scale);
    setViewPos(fitCenter);
  }, [scale, fitCenter]);

  /** 指针锚点缩放：pointTo=(pointer-groupPos)/oldScale; groupPos=pointer-pointTo*newScale。
   *  viewScale 为绝对显示缩放（钳 [fitScale, 8]），外层 Group 实际 scale=viewScale/fitScale
   *  与内层 fit Group 复合；ctrlKey（触控板 pinch）同样按 wheel deltaY 处理。 */
  const handleWheel = useCallback(
    (event: Konva.KonvaEventObject<WheelEvent>) => {
      event.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) {
        return;
      }
      const pointer = stage.getPointerPosition();
      if (!pointer) {
        return;
      }
      const direction = event.evt.deltaY < 0 ? VIEW_SCALE_STEP : 1 / VIEW_SCALE_STEP;
      const nextScale = clamp(viewScale * direction, scale, VIEW_SCALE_MAX);
      const oldOuter = viewScale / scale;
      const newOuter = nextScale / scale;
      const pointTo = {
        x: (pointer.x - viewPos.x) / oldOuter,
        y: (pointer.y - viewPos.y) / oldOuter,
      };
      setViewScale(nextScale);
      setViewPos({
        x: pointer.x - pointTo.x * newOuter,
        y: pointer.y - pointTo.y * newOuter,
      });
    },
    [scale, viewPos.x, viewPos.y, viewScale]
  );

  const getImagePoint = useCallback(() => {
    const stage = stageRef.current;
    const group = contentGroupRef.current;
    if (!stage || !group || !image) {
      return null;
    }
    const pointer = stage.getPointerPosition();
    if (!pointer) {
      return null;
    }
    const transform = group.getAbsoluteTransform().copy();
    transform.invert();
    const imagePoint = transform.point(pointer);
    return {
      x: clamp(imagePoint.x, 0, image.naturalWidth),
      y: clamp(imagePoint.y, 0, image.naturalHeight),
    };
  }, [image]);

  const addPointAt = useCallback(
    (label: 0 | 1) => {
      const point = getImagePoint();
      if (!point || healthState !== 'ok' || busy !== '') {
        return;
      }
      setPoints((current) => appendPoint(current, { x: point.x, y: point.y, label }));
    },
    [busy, getImagePoint, healthState]
  );

  /** 整体模式自动布点：中心 + 3×2 网格质心（与既有正点去重），点变更 effect 自动 decode */
  const handleAutoPlace = useCallback(() => {
    const imageElement = imageRef.current;
    if (!imageElement || healthState !== 'ok' || busy !== '') {
      return;
    }
    const added = generateAutoPoints(
      imageElement.naturalWidth,
      imageElement.naturalHeight,
      points
    );
    if (added.length > 0) {
      setPoints((current) => [...current, ...added]);
    }
  }, [busy, healthState, points]);

  const handleClearPoints = useCallback(() => {
    setPoints(clearPoints());
    setPreviewImage(null);
    setErrorMessage('');
    serverMaskRef.current = null;
    lastAttemptSigRef.current = '';
    lastDecodedPositiveSigRef.current = '';
    const rest = { ...options };
    delete (rest as { aiMattingResultDataUrl?: unknown }).aiMattingResultDataUrl;
    onOptionsChange(rest as ToolOptions);
  }, [onOptionsChange, options]);

  const handleModelSwitch = useCallback(
    (next: AiMattingModel) => {
      if (next === model || busy !== '') {
        return;
      }
      setModel(next);
      // 换模型 = 重新 embed（模型档编码不通用）；embed 完成 embedId 变化，点变更 effect 自动重 decode
      void runEmbed(next);
    },
    [busy, model, runEmbed]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-xs text-text-muted">{t('aiMatting.hint')}</span>
        {healthState === 'error' && (
          <>
            <span className="text-xs text-red-400">{healthMessage}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.14)] px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-dark"
              onClick={() => void checkHealth()}
            >
              <RefreshCw className="h-3 w-3" />
              {t('aiMatting.retry')}
            </button>
          </>
        )}
        {busy === 'embedding' && (
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('aiMatting.embedding')}
          </span>
        )}
        {busy === 'decoding' && (
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('aiMatting.decoding')}
          </span>
        )}
        {errorMessage && (
          <span className="text-xs text-amber-400">{errorMessage}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-muted">{t('aiMatting.modelLabel')}</span>
        {availableModels.map((option) => (
          <button
            key={option}
            type="button"
            className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              model === option
                ? 'border-[rgba(255,255,255,0.4)] bg-bg-dark text-text-dark'
                : 'border-[rgba(255,255,255,0.14)] text-text-muted hover:bg-bg-dark'
            }`}
            onClick={() => handleModelSwitch(option)}
            disabled={busy !== '' || healthState !== 'ok'}
          >
            {modelDisplayName(option, t)}
          </button>
        ))}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.14)] px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-dark"
          onClick={handleAutoPlace}
          disabled={busy !== '' || healthState !== 'ok'}
        >
          <Crosshair className="h-3 w-3" />
          {t('aiMatting.autoPlace')}
        </button>
        {points.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.14)] px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-dark"
            onClick={handleClearPoints}
          >
            {t('aiMatting.clearPoints')}
          </button>
        )}
        {points.map((point, index) => (
          <span
            key={`${index}-${Math.round(point.x)}-${Math.round(point.y)}`}
            className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.14)] px-2 py-1 text-xs text-text-muted"
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                point.label === 1 ? 'bg-emerald-400' : 'bg-red-400'
              }`}
            />
            {point.label === 1 ? t('aiMatting.positive') : t('aiMatting.negative')}
            {Math.round(point.x)},{Math.round(point.y)}
            <button
              type="button"
              className="opacity-50 transition-opacity hover:opacity-100"
              onClick={() => setPoints((current) => removePointAt(current, index))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      <div
        ref={viewportRef}
        className="relative h-[min(62vh,640px)] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85 p-2"
        onContextMenu={(event) => event.preventDefault()}
      >
        {healthState === 'checking' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-bg-dark/60 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('aiMatting.healthChecking')}
          </div>
        )}
        {healthState === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg-dark/60 text-sm text-text-muted">
            <span className="text-red-400">{healthMessage || t('aiMatting.healthOffline')}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.18)] px-3 py-1.5 text-xs text-text-dark transition-colors hover:bg-bg-dark"
              onClick={() => void checkHealth()}
            >
              <RefreshCw className="h-3 w-3" />
              {t('aiMatting.retry')}
            </button>
          </div>
        )}
        <div className="flex h-full w-full gap-3">
          {/* 左面板：原图 + 点选交互（滚轮缩放 / 拖拽平移 / 复位视图） */}
          <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85">
            <div className="flex h-6 shrink-0 items-center justify-between px-2">
              <span className="text-xs text-text-muted">{t('aiMatting.originalLabel')}</span>
              <button
                type="button"
                title={t('aiMatting.resetView')}
                aria-label={t('aiMatting.resetView')}
                className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-dark/60 hover:text-text-dark"
                onClick={resetView}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              <Stage
                ref={stageRef}
                width={panelSize.width}
                height={panelSize.height}
                onClick={() => addPointAt(1)}
                onContextMenu={() => addPointAt(0)}
                onWheel={handleWheel}
                className="cursor-crosshair"
              >
                <Layer>
                  {/* 外层 = 视图变换（缩放平移 + 拖拽），内层保持 fit Group——getImagePoint 的
                      getAbsoluteTransform 自动复合两层变换，零改动。 */}
                  <Group
                    x={viewPos.x}
                    y={viewPos.y}
                    scaleX={viewScale / scale}
                    scaleY={viewScale / scale}
                    draggable
                    onDragEnd={(event) => setViewPos({ x: event.target.x(), y: event.target.y() })}
                  >
                    <Group
                      ref={contentGroupRef}
                      x={0}
                      y={0}
                      scaleX={scale}
                      scaleY={scale}
                    >
                      {image && (
                        <KonvaImage
                          image={image}
                          x={0}
                          y={0}
                          width={image.naturalWidth}
                          height={image.naturalHeight}
                        />
                      )}
                      {/* 负点 = 橡皮擦：清除范围圈（radius 保持原图域真实清除范围；描边 ÷ viewScale 视觉恒定） */}
                      {image
                        && points.map((point, index) => (
                          point.label === 0 ? (
                            <Circle
                              key={`neg-${index}-${Math.round(point.x)}-${Math.round(point.y)}`}
                              x={point.x}
                              y={point.y}
                              radius={negativeClearRadius(image.naturalWidth, image.naturalHeight)}
                              fill="rgba(248,113,113,0.14)"
                              stroke="#f87171"
                              strokeWidth={1.5 / viewScale}
                              listening={false}
                            />
                          ) : null
                        ))}
                      {/* 点标记：尺寸/描边 ÷ viewScale，放大 8× 时视觉大小恒定 */}
                      {points.map((point, index) => (
                        <Group key={`${index}-${Math.round(point.x)}-${Math.round(point.y)}`} listening={false}>
                          <Rect
                            x={point.x - 6 / viewScale}
                            y={point.y - 6 / viewScale}
                            width={12 / viewScale}
                            height={12 / viewScale}
                            stroke={point.label === 1 ? '#34d399' : '#f87171'}
                            strokeWidth={2 / viewScale}
                            fill="rgba(0,0,0,0.35)"
                          />
                          {point.label === 0 ? (
                            <Rect
                              x={point.x - 4.2 / viewScale}
                              y={point.y - 0.9 / viewScale}
                              width={8.4 / viewScale}
                              height={1.8 / viewScale}
                              fill="#f87171"
                              listening={false}
                            />
                          ) : (
                            <Rect
                              x={point.x - 0.9 / viewScale}
                              y={point.y - 4.2 / viewScale}
                              width={1.8 / viewScale}
                              height={8.4 / viewScale}
                              fill="#34d399"
                              listening={false}
                            />
                          )}
                        </Group>
                      ))}
                    </Group>
                  </Group>
                </Layer>
              </Stage>
            </div>
          </div>
          {/* 右面板：抠图预览只读镜像（同一视图变换 → 与左图逐像素对齐） */}
          <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85">
            <div className="flex h-6 shrink-0 items-center px-2">
              <span className="text-xs text-text-muted">{t('aiMatting.previewLabel')}</span>
            </div>
            <div className="relative min-h-0 flex-1">
              <Stage width={panelSize.width} height={panelSize.height} listening={false}>
                <Layer>
                  <Group
                    x={viewPos.x}
                    y={viewPos.y}
                    scaleX={viewScale / scale}
                    scaleY={viewScale / scale}
                  >
                    <Group x={0} y={0} scaleX={scale} scaleY={scale}>
                      {image && previewImage && (
                        <>
                          <Rect
                            x={0}
                            y={0}
                            width={image.naturalWidth}
                            height={image.naturalHeight}
                            // Konva 运行时支持 canvas 作 fillPatternImage，但类型只标了 HTMLImageElement
                            fillPatternImage={checkerPattern as unknown as HTMLImageElement}
                            listening={false}
                          />
                          <KonvaImage
                            image={previewImage}
                            x={0}
                            y={0}
                            width={image.naturalWidth}
                            height={image.naturalHeight}
                            listening={false}
                          />
                        </>
                      )}
                    </Group>
                  </Group>
                </Layer>
              </Stage>
              {!previewImage && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-text-muted">
                  {t('aiMatting.previewEmpty')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
