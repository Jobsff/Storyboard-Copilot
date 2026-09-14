import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crosshair, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { Group, Image as KonvaImage, Layer, Rect, Stage } from 'react-konva';
import type Konva from 'konva';

import type { ToolOptions } from '@/features/canvas/tools';
import {
  appendPoint,
  clearPoints,
  decodeMaskWithRecovery,
  fillMaskHoles,
  featherMask,
  generateAutoPoints,
  maskForegroundRatio,
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

type HealthState = 'checking' | 'ok' | 'error';
type BusyState = '' | 'embedding' | 'decoding';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 模型档 → 人话名：vit_t 整体（快）/ vit_b 细节（HQ）/ vit_l 高召回（大模型）；未知档显示原始 id。 */
function modelDisplayName(model: string, t: (key: string) => string): string {
  switch (model) {
    case 'vit_t':
      return t('aiMatting.modelFast');
    case 'vit_b':
      return t('aiMatting.modelFine');
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

  const stageRef = useRef<Konva.Stage | null>(null);
  const contentGroupRef = useRef<Konva.Group | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const embedIdRef = useRef('');
  const requestIdRef = useRef(0);
  const guideRef = useRef<{ width: number; height: number; data: Uint8ClampedArray } | null>(null);

  const checkerPattern = useMemo(() => createCheckerPatternCanvas(), []);

  const { stageWidth, stageHeight, scale } = useMemo(() => {
    if (!image) {
      return { stageWidth: 820, stageHeight: 480, scale: 1 };
    }
    const maxWidth = Math.max(VIEWPORT_MIN_WIDTH_PX, viewportSize.width - VIEWPORT_PADDING_PX * 2);
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    return {
      stageWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
      stageHeight: Math.max(1, Math.round(image.naturalHeight * ratio)),
      scale: ratio,
    };
  }, [image, viewportSize.width, viewportSize.height]);

  const runDecode = useCallback(
    async (currentPoints: AiMattingPoint[], currentModel: AiMattingModel) => {
      const imageElement = imageRef.current;
      if (!imageElement || currentPoints.length === 0 || !embedIdRef.current) {
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setBusy('decoding');
      setErrorMessage('');
      try {
        const { width: originalWidth, height: originalHeight } = imageElement;
        const { embedId: finalEmbedId, mask, maskWidth, maskHeight } = await decodeMaskWithRecovery({
          points: currentPoints,
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
        // 客户端蒙版增强链：孔洞填充 → 引导滤波上采样（guide=原图亮度）→ 1px 羽化
        // 蒙版宽高取 PNG 实际尺寸（旧服务 256 / 升级后 1024 均适配）
        const holed = fillMaskHoles(mask, maskWidth, maskHeight);
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
          maskWidth,
          maskHeight,
          guideRef.current.data,
          originalWidth,
          originalHeight
        );
        const feathered = featherMask(enhanced, originalWidth, originalHeight);
        const foregroundRatio = maskForegroundRatio(feathered);
        const dataUrl = composeCutoutDataUrl(imageElement, feathered, originalWidth, originalHeight);
        const preview = new window.Image();
        preview.onload = () => setPreviewImage(preview);
        preview.src = dataUrl;
        onOptionsChange({ ...options, aiMattingResultDataUrl: dataUrl } as ToolOptions);
        if (foregroundRatio <= 0.001) {
          setErrorMessage(t('aiMatting.maskEmpty'));
        }
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
    [aiMattingBaseUrl, onOptionsChange, options, t]
  );

  const runEmbed = useCallback(
    async (currentModel: AiMattingModel, currentPoints: AiMattingPoint[]) => {
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
        if (currentPoints.length > 0) {
          await runDecode(currentPoints, currentModel);
        }
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
    // runDecode 依赖 options/onOptionsChange（写结果），保持引用最新即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aiMattingBaseUrl, runDecode, t]
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
        await runEmbed(effectiveModel, []);
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

  // 点变更自动 decode
  useEffect(() => {
    if (points.length === 0 || !embedId || busy !== '') {
      return;
    }
    void runDecode(points, model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, embedId]);

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
      // 换模型 = 重新 embed（两模型编码不通用）；已有点保留，embed 完自动重 decode
      void runEmbed(next, points);
    },
    [busy, model, points, runEmbed]
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
        className="relative h-[min(62vh,640px)] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85"
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
        <div className="relative flex h-full w-full items-center justify-center p-2 outline-none">
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={stageHeight}
            onMouseDown={() => addPointAt(1)}
            onContextMenu={() => addPointAt(0)}
            className="cursor-crosshair"
          >
            <Layer>
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
                {previewImage && image && (
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
                {points.map((point, index) => (
                  <Group key={`${index}-${Math.round(point.x)}-${Math.round(point.y)}`} listening={false}>
                    <Rect
                      x={point.x - 6}
                      y={point.y - 6}
                      width={12}
                      height={12}
                      stroke={point.label === 1 ? '#34d399' : '#f87171'}
                      strokeWidth={2}
                      fill="rgba(0,0,0,0.35)"
                    />
                    {point.label === 0 ? (
                      <Rect
                        x={point.x - 4.2}
                        y={point.y - 0.9}
                        width={8.4}
                        height={1.8}
                        fill="#f87171"
                        listening={false}
                      />
                    ) : (
                      <Rect
                        x={point.x - 0.9}
                        y={point.y - 4.2}
                        width={1.8}
                        height={8.4}
                        fill="#34d399"
                        listening={false}
                      />
                    )}
                  </Group>
                ))}
              </Group>
            </Layer>
          </Stage>
        </div>
      </div>
    </div>
  );
}
