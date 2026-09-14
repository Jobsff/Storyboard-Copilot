import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import {
  CloudUpload,
  Copy,
  Crop,
  Download,
  Eraser,
  FolderOpen,
  Info,
  PenLine,
  RefreshCw,
  Scissors,
  Trash2,
  Unlink2,
  Wand2,
  ZoomIn,
  Scan,
} from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

import {
  NODE_TOOL_TYPES,
  isExportImageNode,
  isGroupNode,
  isImageEditNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
  isUploadNode,
  type CanvasNode,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus, canvasToolProcessor } from '@/features/canvas/application/canvasServices';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import { getNodeToolPlugins } from '@/features/canvas/tools';
import type { ToolIconKey } from '@/features/canvas/tools';
import { UiButton, UiChipButton, UiModal, UiPanel } from '@/components/ui';
import {
  copyImageSourceToClipboard,
  saveImageSourceToDirectory,
  saveImageSourceToPath,
} from '@/commands/image';
import { archiveImageManual } from '@/commands/ai';
import { showErrorDialog, resolveErrorContent } from '@/features/canvas/application/errorDialog';
import { useProjectStore } from '@/stores/projectStore';
import { resolveOssProjectParam } from '@/features/canvas/infrastructure/ossProjectName';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import { sanitizeStoryboardText } from '@/features/canvas/application/storyboardText';
import { buildGenerationErrorReport } from '@/features/canvas/application/generationErrorReport';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeActionToolbarProps {
  node: CanvasNode;
}

const toolIconMap: Record<ToolIconKey, typeof Crop> = {
  crop: Crop,
  annotate: PenLine,
  split: Scissors,
  scale: ZoomIn,
  matting: Wand2,
  aiMatting: Scan,
  aiBirefMatting: Eraser,
};

const TOOLBAR_BUTTON_RADIUS_CLASS = 'rounded-full';
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[rgba(255,255,255,0.18)] bg-bg-dark/70 text-text-dark hover:border-[rgba(255,255,255,0.32)] hover:bg-bg-dark';

export const NodeActionToolbar = memo(({ node }: NodeActionToolbarProps) => {
  const { t, i18n } = useTranslation();
  const isImageEdit = isImageEditNode(node);
  const isStoryboardGen = isStoryboardGenNode(node);
  const isStoryboardSplit = isStoryboardSplitNode(node);
  const isSequenceFrameGridOutput =
    isExportImageNode(node) &&
    node.data.resultKind === 'storyboardGenOutput' &&
    Boolean(node.data.imageUrl);
  const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
  const tools = useMemo(() => getNodeToolPlugins(node), [node]);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  /** immediate 工具（AI 去底）执行中状态：非空 = 该工具类型正在跑。 */
  const [immediateToolBusy, setImmediateToolBusy] = useState('');
  const canReupload = isUploadNode(node) && Boolean(node.data.imageUrl);
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
  const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
    (state) => state.ignoreAtTagWhenCopyingAndGenerating
  );
  const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDownloadMenuVisible, setIsDownloadMenuVisible] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(
    null
  );
  const [isCopySuccess, setIsCopySuccess] = useState(false);
  const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
  const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
  const [isCopyPromptSuccess, setIsCopyPromptSuccess] = useState(false);
  const [archiveState, setArchiveState] = useState<'idle' | 'loading' | 'success'>('idle');
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const archiveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTextFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyErrorFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPromptFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageSource = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl || node.data.previewImageUrl || null;
    }
    return null;
  }, [node]);
  const canHandleImage = Boolean(imageSource);
  // 手动补传归档（补丁2）：生成/导出图与上传图节点且有图才出按钮；已归档节点点击=复制链接。
  // ossUrl 存储按节点类型分字段：exportImage 在 generationMeta.ossUrl，upload 在 ossArchiveUrl。
  const canArchiveImage =
    (isExportImageNode(node) || isUploadNode(node)) && Boolean(node.data.imageUrl);
  const generationMeta = isExportImageNode(node) ? node.data.generationMeta ?? null : null;
  const existingOssUrl = isExportImageNode(node)
    ? node.data.generationMeta?.ossUrl ?? null
    : isUploadNode(node)
      ? node.data.ossArchiveUrl ?? null
      : null;
  const infoPayload = useMemo(() => {
    const data = node.data as Record<string, unknown>;
    const context = data.generationDebugContext as
      | {
          providerId?: string;
          requestModel?: string;
          requestSize?: string;
          requestAspectRatio?: string;
          prompt?: string;
        }
      | undefined;

    const providerId = typeof context?.providerId === 'string'
      ? context.providerId
      : typeof data.generationProviderId === 'string'
        ? (data.generationProviderId as string)
        : '';
    const model = typeof context?.requestModel === 'string'
      ? context.requestModel
      : typeof data.model === 'string'
        ? (data.model as string)
        : '';
    const size = typeof context?.requestSize === 'string'
      ? context.requestSize
      : typeof data.size === 'string'
        ? (data.size as string)
        : '';
    const aspectRatio = typeof context?.requestAspectRatio === 'string'
      ? context.requestAspectRatio
      : typeof data.requestAspectRatio === 'string'
        ? (data.requestAspectRatio as string)
        : typeof data.aspectRatio === 'string'
          ? (data.aspectRatio as string)
          : '';
    const prompt = typeof context?.prompt === 'string'
      ? context.prompt
      : typeof data.prompt === 'string'
        ? (data.prompt as string)
        : '';

    return {
      providerId: providerId.trim(),
      model: model.trim(),
      size: size.trim(),
      aspectRatio: aspectRatio.trim(),
      prompt: prompt.trim(),
    };
  }, [node.data]);
  const canShowInfo = canHandleImage;
  const generationError =
    isExportImageNode(node)
    && typeof (node.data as { generationError?: unknown }).generationError === 'string'
      ? ((node.data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const generationErrorDetails =
    isExportImageNode(node)
    && typeof (node.data as { generationErrorDetails?: unknown }).generationErrorDetails === 'string'
      ? ((node.data as { generationErrorDetails?: string }).generationErrorDetails ?? '').trim()
      : '';
  const canCopyGenerationError = isExportImageNode(node) && generationError.length > 0;
  const generationErrorReport = useMemo(
    () =>
      buildGenerationErrorReport({
        errorMessage: generationError || t('ai.error'),
        errorDetails: generationErrorDetails || undefined,
        context: (node.data as { generationDebugContext?: unknown }).generationDebugContext,
      }),
    [generationError, generationErrorDetails, node.data, t]
  );

  const closeDownloadMenu = useCallback(() => {
    setIsDownloadMenuVisible(false);
    if (downloadMenuCloseTimerRef.current) {
      clearTimeout(downloadMenuCloseTimerRef.current);
    }
    downloadMenuCloseTimerRef.current = setTimeout(() => {
      setDownloadMenu(null);
      downloadMenuCloseTimerRef.current = null;
    }, UI_POPOVER_TRANSITION_MS);
  }, []);

  const resolveToolLabel = useCallback((toolType: NodeToolType) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      if (isSequenceFrameGridOutput) {
        return t('tool.splitAnimation');
      }
      return t('tool.split');
    }
    if (toolType === NODE_TOOL_TYPES.scale) {
      return t('tool.scale');
    }
    if (toolType === NODE_TOOL_TYPES.matting) {
      return t('tool.matting');
    }
    if (toolType === NODE_TOOL_TYPES.aiMatting) {
      return t('tool.aiMatting');
    }
    if (toolType === NODE_TOOL_TYPES.aiBirefMatting) {
      return t('tool.aiBirefMatting');
    }
    return '';
  }, [isSequenceFrameGridOutput, t]);

  /** immediate 工具（AI 去底）：点击即执行——loading 转圈，结果落新节点+连线，失败弹错误对话框。 */
  const handleImmediateTool = useCallback(
    async (toolType: NodeToolType) => {
      const sourceImageUrl =
        isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)
          ? node.data.imageUrl
          : null;
      if (!sourceImageUrl || immediateToolBusy) {
        return;
      }
      setImmediateToolBusy(toolType);
      try {
        const result = await canvasToolProcessor.process(toolType, sourceImageUrl, {});
        if (!result.outputImageUrl) {
          throw new Error(t('toolDialog.processFailed'));
        }
        const prepared = await prepareNodeImage(result.outputImageUrl);
        const createdNodeId = addDerivedExportNode(
          node.id,
          prepared.imageUrl,
          prepared.aspectRatio,
          prepared.previewImageUrl,
          {
            defaultTitle:
              toolType === NODE_TOOL_TYPES.aiBirefMatting
                ? t('toolDialog.aiBirefMattingResultTitle')
                : EXPORT_RESULT_DISPLAY_NAME.generic,
            resultKind: 'generic',
            aspectRatioStrategy: 'provided',
            sizeStrategy: 'autoMinEdge',
          }
        );
        if (createdNodeId) {
          addEdge(node.id, createdNodeId);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('toolDialog.processFailed');
        void showErrorDialog(
          `${t('aiBirefMatting.failed')}：${message}`,
          t('tool.aiBirefMatting')
        );
      } finally {
        setImmediateToolBusy('');
      }
    },
    [addDerivedExportNode, addEdge, immediateToolBusy, node, t]
  );

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const menuElement = downloadMenuRef.current;
      if (!menuElement) {
        closeDownloadMenu();
        return;
      }
      if (menuElement.contains(event.target as Node)) {
        return;
      }
      closeDownloadMenu();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [closeDownloadMenu, downloadMenu]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      setIsDownloadMenuVisible(true);
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [downloadMenu]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
      if (copyPromptFeedbackTimerRef.current) {
        clearTimeout(copyPromptFeedbackTimerRef.current);
      }
      if (archiveFeedbackTimerRef.current) {
        clearTimeout(archiveFeedbackTimerRef.current);
      }
      if (downloadMenuCloseTimerRef.current) {
        clearTimeout(downloadMenuCloseTimerRef.current);
      }
    };
  }, []);

  const handleCopyImage = useCallback(async () => {
    if (!imageSource) {
      return;
    }

    setIsCopySuccess(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setIsCopySuccess(false);
      copyFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await copyImageSourceToClipboard(imageSource);
    } catch (error) {
      console.error('Failed to copy image to clipboard', error);
    }
  }, [imageSource]);

  // 手动补传归档（补丁2）：未归档 → 解析真实源调 archive_image_manual，成功写回
  // generationMeta.ossUrl 并自动复制桶直链；已归档 → 直接复制链接（同按钮复用）。
  const handleArchiveImage = useCallback(async () => {
    if (!canArchiveImage || archiveState === 'loading') {
      return;
    }

    const flashSuccess = () => {
      setArchiveState('success');
      if (archiveFeedbackTimerRef.current) {
        clearTimeout(archiveFeedbackTimerRef.current);
      }
      archiveFeedbackTimerRef.current = setTimeout(() => {
        setArchiveState('idle');
        archiveFeedbackTimerRef.current = null;
      }, 1100);
    };

    if (existingOssUrl) {
      try {
        await navigator.clipboard.writeText(existingOssUrl);
        flashSuccess();
      } catch (error) {
        console.error('Failed to copy oss archive url', error);
      }
      return;
    }

    // 内存节点 imageUrl 即真实源（调查实证：__img_ref__ 池化编码只存在于持久化
    // JSON —— projectStore encode/decodeImageReference 仅在存取 DB 时成对生效，
    // 内存 Project 类型上无 imagePool 字段）。若真出现 __img_ref__，Rust 侧会
    // 返回「图片源不可读」人话错误，属可接受的软失败。
    const source = imageSource;
    if (!source) {
      void showErrorDialog(
        t('nodeToolbar.uploadArchiveSourceMissing'),
        t('nodeToolbar.uploadArchiveFailedTitle')
      );
      return;
    }

    setArchiveState('loading');
    try {
      const url = await archiveImageManual({
        source,
        ossProject: resolveOssProjectParam(useProjectStore.getState().currentProject?.name),
        providerId: generationMeta?.providerId ?? undefined,
        model: generationMeta?.model ?? undefined,
      });
      const nextMeta = { ...(generationMeta ?? {}), ossUrl: url };
      if (isExportImageNode(node)) {
        updateNodeData(node.id, { generationMeta: nextMeta });
      } else {
        updateNodeData(node.id, { ossArchiveUrl: url });
      }
      try {
        await navigator.clipboard.writeText(url);
      } catch (copyError) {
        console.error('Failed to copy archived url', copyError);
      }
      flashSuccess();
    } catch (error) {
      setArchiveState('idle');
      const content = resolveErrorContent(error, t('nodeToolbar.uploadArchiveFailed'));
      void showErrorDialog(
        content.message,
        t('nodeToolbar.uploadArchiveFailedTitle'),
        content.details
      );
    }
  }, [
    archiveState,
    canArchiveImage,
    existingOssUrl,
    generationMeta,
    imageSource,
    node,
    t,
    updateNodeData,
  ]);

  const storyboardText = useMemo(() => {
    if (isStoryboardGen) {
      return node.data.frames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(
            frame.description ?? '',
            ignoreAtTagWhenCopyingAndGenerating
          ),
        }))
        .join('\n');
    }
    if (isStoryboardSplit) {
      const orderedFrames = [...node.data.frames].sort((a, b) => a.order - b.order);
      return orderedFrames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(frame.note ?? '', ignoreAtTagWhenCopyingAndGenerating),
        }))
        .join('\n');
    }
    return '';
  }, [ignoreAtTagWhenCopyingAndGenerating, isStoryboardGen, isStoryboardSplit, node, t, i18n.language]);

  const handleCopyStoryboardText = useCallback(async () => {
    if (!storyboardText) {
      return;
    }

    setIsCopyTextSuccess(true);
    if (copyTextFeedbackTimerRef.current) {
      clearTimeout(copyTextFeedbackTimerRef.current);
    }
    copyTextFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyTextSuccess(false);
      copyTextFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(storyboardText);
    } catch (error) {
      console.error('Failed to copy storyboard text', error);
    }
  }, [storyboardText]);

  const handleCopyGenerationError = useCallback(async () => {
    if (!canCopyGenerationError) {
      return;
    }

    setIsCopyErrorSuccess(true);
    if (copyErrorFeedbackTimerRef.current) {
      clearTimeout(copyErrorFeedbackTimerRef.current);
    }
    copyErrorFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyErrorSuccess(false);
      copyErrorFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(generationErrorReport);
    } catch (error) {
      console.error('Failed to copy generation error report', error);
    }
  }, [canCopyGenerationError, generationErrorReport]);

  const canCopyPrompt = Boolean(infoPayload.prompt);
  const handleCopyPrompt = useCallback(async () => {
    if (!infoPayload.prompt) {
      return;
    }

    setIsCopyPromptSuccess(true);
    if (copyPromptFeedbackTimerRef.current) {
      clearTimeout(copyPromptFeedbackTimerRef.current);
    }
    copyPromptFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyPromptSuccess(false);
      copyPromptFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(infoPayload.prompt);
    } catch (error) {
      console.error('Failed to copy prompt', error);
    }
  }, [infoPayload.prompt]);

  const handleDownloadSaveAs = useCallback(async () => {
    if (!imageSource) {
      return;
    }

    try {
      const selectedPath = await save({
        defaultPath: `node-${node.id}.png`,
      });
      if (!selectedPath || Array.isArray(selectedPath)) {
        return;
      }
      await saveImageSourceToPath(imageSource, selectedPath);
      closeDownloadMenu();
    } catch (error) {
      console.error('Failed to save image with save-as', error);
    }
  }, [closeDownloadMenu, imageSource, node.id]);

  useEffect(() => {
    if (!isInfoOpen || !imageSource) {
      setImageDimensions(null);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) {
        return;
      }
      const width = img.naturalWidth ?? 0;
      const height = img.naturalHeight ?? 0;
      if (width > 0 && height > 0) {
        setImageDimensions({ width, height });
      } else {
        setImageDimensions(null);
      }
    };
    img.onerror = () => {
      if (!cancelled) {
        setImageDimensions(null);
      }
    };
    img.src = imageSource;
    return () => {
      cancelled = true;
    };
  }, [imageSource, isInfoOpen]);

  const requestResolutionText = useMemo(() => {
    const sizeToPixels: Record<string, number> = {
      '0.5K': 512,
      '1K': 1024,
      '2K': 2048,
      '4K': 4096,
    };
    const pixels = sizeToPixels[infoPayload.size] ?? null;
    if (!pixels || !infoPayload.aspectRatio) {
      return infoPayload.size;
    }
    const [wText, hText] = infoPayload.aspectRatio.split(':');
    const w = Number.parseFloat(wText);
    const h = Number.parseFloat(hText);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return infoPayload.size;
    }
    const height = Math.max(1, Math.round(pixels * (h / w)));
    return `${infoPayload.size} (${pixels}x${height})`;
  }, [infoPayload.aspectRatio, infoPayload.size]);

  const handleDownloadToPreset = useCallback(
    async (targetDir: string) => {
      if (!imageSource) {
        return;
      }
      try {
        await saveImageSourceToDirectory(imageSource, targetDir, `node-${node.id}`);
        closeDownloadMenu();
      } catch (error) {
        console.error('Failed to save image to preset dir', error);
      }
    },
    [closeDownloadMenu, imageSource, node.id]
  );

  return (
    <ReactFlowNodeToolbar
      nodeId={node.id}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="flex items-center gap-1 rounded-full p-1">
        {!isImageEdit && tools.map((tool) => {
          const Icon = toolIconMap[tool.icon] ?? Crop;

          // immediate 工具（AI 去底）：点击即执行，不开工具对话框
          if (tool.immediate) {
            const isBusy = immediateToolBusy === tool.type;
            return (
              <UiChipButton
                key={tool.type}
                className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
                disabled={immediateToolBusy !== ''}
                title={
                  tool.type === NODE_TOOL_TYPES.aiBirefMatting
                    ? t('aiBirefMatting.buttonTitle')
                    : undefined
                }
                onClick={() => void handleImmediateTool(tool.type)}
              >
                {isBusy ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                {resolveToolLabel(tool.type)}
              </UiChipButton>
            );
          }

          return (
            <UiChipButton
              key={tool.type}
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              onClick={() =>
                canvasEventBus.publish('tool-dialog/open', {
                  nodeId: node.id,
                  toolType: tool.type,
                })
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {resolveToolLabel(tool.type)}
            </UiChipButton>
          );
        })}
        {!isImageEdit && canReupload && (
          <UiChipButton
            key="upload-reupload"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={() =>
              canvasEventBus.publish('upload-node/reupload', {
                nodeId: node.id,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('nodeToolbar.reupload')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopySuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyImage();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copy')}
          </UiChipButton>
        )}
        {!isImageEdit && canArchiveImage && (
          <UiChipButton
            key="image-archive"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              archiveState === 'success'
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            disabled={archiveState === 'loading'}
            title={
              existingOssUrl
                ? t('nodeToolbar.uploadArchiveCopyTitle')
                : t('nodeToolbar.uploadArchiveTitle')
            }
            onClick={(event) => {
              event.stopPropagation();
              void handleArchiveImage();
            }}
          >
            {archiveState === 'loading' ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudUpload className="h-3.5 w-3.5" />
            )}
            {archiveState === 'success'
              ? t('nodeToolbar.archivedCopied')
              : t('nodeToolbar.uploadArchive')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyStoryboardText && (
          <UiChipButton
            key="storyboard-text-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyTextSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyStoryboardText();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copyText')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyGenerationError && (
          <UiChipButton
            key="generation-error-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyErrorSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : '!border-red-500/45 !bg-red-500/15 !text-red-200 hover:!bg-red-500/25'
            }`}
            onClick={() => {
              void handleCopyGenerationError();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {isCopyErrorSuccess ? t('nodeToolbar.copied') : t('nodeToolbar.copyErrorReport')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-download"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              if (downloadPresetPaths.length === 0) {
                void handleDownloadSaveAs();
                return;
              }
              setDownloadMenu({
                x: event.clientX,
                y: event.clientY,
              });
              setIsDownloadMenuVisible(false);
            }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('nodeToolbar.download')}
          </UiChipButton>
        )}
        {!isImageEdit && canShowInfo && (
          <UiChipButton
            key="image-info"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              closeDownloadMenu();
              setIsInfoOpen(true);
            }}
          >
            <Info className="h-3.5 w-3.5" />
            {t('nodeToolbar.info')}
          </UiChipButton>
        )}
        {!isImageEdit && isGroupNode(node) && (
          <UiChipButton
            key="group-ungroup"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} hover:!border-amber-400/60 hover:!bg-amber-500/20 hover:!text-amber-200`}
            onClick={(event) => {
              event.stopPropagation();
              closeDownloadMenu();
              ungroupNode(node.id);
            }}
          >
            <Unlink2 className="h-3.5 w-3.5" />
            {t('nodeToolbar.ungroup')}
          </UiChipButton>
        )}
        <UiChipButton
          key="node-delete"
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25`}
          onClick={(event) => {
            event.stopPropagation();
            closeDownloadMenu();
            deleteNode(node.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>

      <UiModal
        isOpen={isInfoOpen}
        title={t('nodeToolbar.infoTitle')}
        onClose={() => setIsInfoOpen(false)}
        widthClassName="max-w-3xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <UiButton
              type="button"
              variant="primary"
              disabled={!canCopyPrompt}
              onClick={() => {
                void handleCopyPrompt();
              }}
            >
              {isCopyPromptSuccess ? t('nodeToolbar.copied') : t('nodeToolbar.copyPrompt')}
            </UiButton>
            <UiButton type="button" variant="muted" onClick={() => setIsInfoOpen(false)}>
              {t('common.close')}
            </UiButton>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-text-dark">
          {infoPayload.providerId ? (
            <div className="flex items-start justify-between gap-4">
              <div className="text-text-muted">{t('nodeToolbar.infoProvider')}</div>
              <div className="text-right break-all">{infoPayload.providerId}</div>
            </div>
          ) : null}
          <div className="flex items-start justify-between gap-4">
            <div className="text-text-muted">{t('nodeToolbar.infoModel')}</div>
            <div className="text-right break-all">{infoPayload.model || '-'}</div>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="text-text-muted">{t('nodeToolbar.infoAspectRatio')}</div>
            <div className="text-right break-all">{infoPayload.aspectRatio || '-'}</div>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="text-text-muted">{t('nodeToolbar.infoResolution')}</div>
            <div className="text-right break-all">
              {imageDimensions ? `${imageDimensions.width}x${imageDimensions.height}` : '-'}
            </div>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="text-text-muted">{t('nodeToolbar.infoRequestSize')}</div>
            <div className="text-right break-all">{requestResolutionText || '-'}</div>
          </div>
          <div className="space-y-2">
            <div className="text-text-muted">{t('nodeToolbar.infoPrompt')}</div>
            <UiPanel className="rounded-lg bg-bg-dark/50 px-3 py-2">
              <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-text-dark">
                {infoPayload.prompt || '-'}
              </pre>
            </UiPanel>
          </div>
        </div>
      </UiModal>

      {!isImageEdit && downloadMenu && (
        <div
          ref={downloadMenuRef}
          className={`fixed z-[120] min-w-[280px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-sm transition-opacity duration-150 ${isDownloadMenuVisible ? 'opacity-100' : 'opacity-0'}`}
          style={{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }}
        >
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
            onClick={() => {
              void handleDownloadSaveAs();
            }}
          >
            <Download className="h-4 w-4" />
            {t('nodeToolbar.saveAs')}
          </button>

          {downloadPresetPaths.length > 0 ? (
            <div className="mt-1 space-y-1 border-t border-[rgba(255,255,255,0.1)] pt-2">
              {downloadPresetPaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
                  onClick={() => {
                    void handleDownloadToPreset(path);
                  }}
                  title={path}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1 border-t border-[rgba(255,255,255,0.1)] px-2.5 pt-2 text-xs text-text-muted">
              {t('nodeToolbar.noDownloadPresetPathsHint')}
            </div>
          )}
        </div>
      )}
    </ReactFlowNodeToolbar>
  );
});

NodeActionToolbar.displayName = 'NodeActionToolbar';
