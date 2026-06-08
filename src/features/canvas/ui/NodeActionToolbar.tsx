import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import {
  Copy,
  Crop,
  Download,
  FolderOpen,
  Info,
  PenLine,
  RefreshCw,
  Scissors,
  Trash2,
  Unlink2,
  ZoomIn,
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
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { getNodeToolPlugins } from '@/features/canvas/tools';
import type { ToolIconKey } from '@/features/canvas/tools';
import { UiButton, UiChipButton, UiModal, UiPanel } from '@/components/ui';
import {
  copyImageSourceToClipboard,
  saveImageSourceToDirectory,
  saveImageSourceToPath,
} from '@/commands/image';
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
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
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
    return '';
  }, [isSequenceFrameGridOutput, t]);

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
