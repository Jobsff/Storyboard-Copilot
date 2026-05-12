import { createPortal } from 'react-dom';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { LoaderCircle, Sparkles, Video as VideoIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  VIDEO_ASPECT_RATIOS,
  VIDEO_QUALITIES,
  type VideoEditNodeData,
  type VideoQuality,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { canvasAiGateway, graphImageResolver } from '@/features/canvas/application/canvasServices';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import {
  CURRENT_RUNTIME_SESSION_ID,
  buildGenerationErrorReport,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { sanitizeStoryboardPromptText } from '@/features/canvas/application/storyboardText';
import { findReferenceTokens, insertReferenceToken, removeTextRange, resolveReferenceAwareDeleteRange } from '@/features/canvas/application/referenceTokenEditing';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_MODEL_CHIP_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton } from '@/components/ui';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import { resolve666ApiKey } from '@/features/canvas/models/providers/api666';

type VideoEditNodeProps = NodeProps & {
  id: string;
  data: VideoEditNodeData;
  selected?: boolean;
};

const VIDEO_EDIT_NODE_MIN_WIDTH = 420;
const VIDEO_EDIT_NODE_MIN_HEIGHT = 220;
const VIDEO_EDIT_NODE_DEFAULT_WIDTH = 560;
const VIDEO_EDIT_NODE_DEFAULT_HEIGHT = 360;
type PanelType = 'model' | 'params' | null;

interface PickerAnchor {
  left: number;
  top: number;
}

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;

const VIDEO_MODEL_CHOICES: Array<{ id: string; label: string }> = [
  { id: '666api/wan2.6-i2v-flash', label: 'wan2.6-i2v-flash' },
];

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function buildResultTitle(prompt: string, fallback: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
}

function buildVideoPrompt(basePrompt: string, opts: { aspectRatio: string; quality: string; durationSeconds: number }): string {
  const trimmed = basePrompt.trim();
  const specLine = `视频参数：比例 ${opts.aspectRatio}，清晰度 ${opts.quality}，时长 ${opts.durationSeconds} 秒。`;
  return trimmed ? `${trimmed}\n\n${specLine}` : specLine;
}

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

function renderPromptWithHighlights(prompt: string, maxImageCount: number): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, maxImageCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    segments.push(
      <span
        key={`ref-${matchStart}`}
        className="relative z-0 text-white [text-shadow:0.24px_0_currentColor,-0.24px_0_currentColor] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/55 before:content-['']"
      >
        {matchText}
      </span>
    );

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

export const VideoEditNode = memo(({ id, data, selected, width, height }: VideoEditNodeProps) => {
  const { t } = useTranslation();
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptDraftRef = useRef(promptDraft);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const promptContainerRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const promptHighlightRef = useRef<HTMLDivElement | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const paramsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelPanelRef = useRef<HTMLDivElement | null>(null);
  const paramsPanelRef = useRef<HTMLDivElement | null>(null);
  const [openPanel, setOpenPanel] = useState<PanelType>(null);
  const [renderPanel, setRenderPanel] = useState<PanelType>(null);
  const [isPanelVisible, setIsPanelVisible] = useState(false);
  const [modelPanelAnchor, setModelPanelAnchor] = useState<{ left: number; top: number } | null>(null);
  const [paramsPanelAnchor, setParamsPanelAnchor] = useState<{ left: number; top: number } | null>(null);

  const providerId = useMemo(() => (data.model.split('/', 1)[0] ?? '').trim(), [data.model]);
  const providerApiKey = providerId === '666api'
    ? (resolve666ApiKey(data.model, apiKeys) ?? '')
    : (providerId ? (apiKeys[providerId] ?? '') : '');
  const resolvedTitle = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.videoEdit, data), [data]);

  const incomingImages = useMemo(() => graphImageResolver.collectInputImages(id, nodes, edges), [edges, id, nodes]);
  const autoSwitchedModelName = useMemo(() => {
    return null;
  }, []);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  const commitPromptDraft = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    updateNodeData(id, { prompt: nextPrompt });
  }, [id, updateNodeData]);

  const resolvedWidth = useMemo(() => {
    if (typeof width === 'number' && Number.isFinite(width) && width > 1) {
      return Math.max(VIDEO_EDIT_NODE_MIN_WIDTH, Math.round(width));
    }
    return VIDEO_EDIT_NODE_DEFAULT_WIDTH;
  }, [width]);

  const resolvedHeight = useMemo(() => {
    if (typeof height === 'number' && Number.isFinite(height) && height > 1) {
      return Math.max(VIDEO_EDIT_NODE_MIN_HEIGHT, Math.round(height));
    }
    return VIDEO_EDIT_NODE_DEFAULT_HEIGHT;
  }, [height]);

  const selectedModelLabel = useMemo(() => {
    const hit = VIDEO_MODEL_CHOICES.find((item) => item.id === data.model);
    if (hit) {
      return hit.label;
    }
    const [, modelName] = data.model.split('/', 2);
    return modelName ?? data.model;
  }, [data.model]);

  const paramsSummaryText = useMemo(() => {
    const ratio = typeof data.aspectRatio === 'string' && data.aspectRatio.trim() ? data.aspectRatio.trim() : '16:9';
    const quality = (VIDEO_QUALITIES.includes(data.quality as VideoQuality) ? data.quality : '720p') as string;
    const durationSeconds = clampNumber(Number(data.durationSeconds), 1, 30);
    return `${ratio} · ${quality} · ${durationSeconds}s`;
  }, [data.aspectRatio, data.durationSeconds, data.quality]);

  const closePanel = useCallback(() => {
    setIsPanelVisible(false);
    const timer = window.setTimeout(() => {
      setOpenPanel(null);
      setRenderPanel(null);
    }, UI_POPOVER_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const openPanelAt = useCallback((type: Exclude<PanelType, null>) => {
    const trigger = type === 'model' ? modelTriggerRef.current : paramsTriggerRef.current;
    if (!trigger) {
      setOpenPanel(type);
      setRenderPanel(type);
      setIsPanelVisible(true);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const panelWidth = type === 'model' ? 360 : 420;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, Math.round(rect.left)),
      Math.max(margin, Math.round(window.innerWidth - panelWidth - margin))
    );
    const top = Math.max(margin, Math.round(rect.bottom + margin));
    if (type === 'model') {
      setModelPanelAnchor({ left, top });
    } else {
      setParamsPanelAnchor({ left, top });
    }
    setOpenPanel(type);
    setRenderPanel(type);
    requestAnimationFrame(() => setIsPanelVisible(true));
  }, []);

  useEffect(() => {
    if (!openPanel) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root?.contains(event.target as globalThis.Node)) {
        return;
      }
      const panelEl = openPanel === 'model' ? modelPanelRef.current : paramsPanelRef.current;
      if (panelEl?.contains(event.target as globalThis.Node)) {
        return;
      }
      closePanel();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [closePanel, openPanel]);

  const incomingImageItems = useMemo(() => {
    return incomingImages.map((imageUrl, index) => ({
      imageUrl,
      displayUrl: resolveImageDisplayUrl(imageUrl),
      label: `图${index + 1}`,
    }));
  }, [incomingImages]);

  const syncPromptHighlightScroll = useCallback(() => {
    const promptEl = promptRef.current;
    const highlightEl = promptHighlightRef.current;
    if (!promptEl || !highlightEl) {
      return;
    }
    highlightEl.scrollTop = promptEl.scrollTop;
    highlightEl.scrollLeft = promptEl.scrollLeft;
  }, []);

  const insertImageReference = useCallback((imageIndex: number) => {
    if (incomingImages.length === 0) {
      return;
    }
    const cursor = pickerCursor ?? promptDraftRef.current.length;
    const marker = `@图${imageIndex + 1}`;
    const currentPrompt = promptDraftRef.current;
    const { nextText: nextPrompt, nextCursor } = insertReferenceToken(currentPrompt, cursor, marker);

    setPromptDraft(nextPrompt);
    commitPromptDraft(nextPrompt);
    setShowImagePicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);

    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [commitPromptDraft, incomingImages.length, pickerCursor, syncPromptHighlightScroll]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const currentPrompt = promptDraftRef.current;
      const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const deletionDirection = event.key === 'Backspace' ? 'backward' : 'forward';
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        deletionDirection,
        incomingImages.length
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
        setPromptDraft(nextText);
        commitPromptDraft(nextText);
        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncPromptHighlightScroll();
        });
        return;
      }
    }

    if (showImagePicker && incomingImages.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous === 0 ? incomingImages.length - 1 : previous - 1));
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        insertImageReference(pickerActiveIndex);
        return;
      }
    }

    if (event.key === '@' && incomingImages.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      setPickerAnchor(resolvePickerAnchor(promptContainerRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setShowImagePicker(true);
      setPickerActiveIndex(0);
      return;
    }

    if (event.key === 'Escape' && showImagePicker) {
      event.preventDefault();
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }
  }, [commitPromptDraft, incomingImages.length, insertImageReference, pickerActiveIndex, showImagePicker, syncPromptHighlightScroll]);

  useEffect(() => {
    if (!showImagePicker) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const container = promptContainerRef.current;
      if (container?.contains(event.target as globalThis.Node)) {
        return;
      }
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [showImagePicker]);

  const handleGenerate = useCallback(async () => {
    if (isSubmitting) {
      return;
    }
    const basePromptRaw = promptDraftRef.current;
    const sanitizedBasePrompt = sanitizeStoryboardPromptText(basePromptRaw);
    if (!sanitizedBasePrompt) {
      const message = t('node.videoEdit.promptRequired');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }

    if (!providerApiKey) {
      const message = t('node.videoEdit.apiKeyRequired');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }

    if (incomingImages.length === 0) {
      const message = t('node.videoEdit.referenceRequired');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }

    setIsSubmitting(true);
    const durationSeconds = clampNumber(Number(data.durationSeconds), 1, 30);
    const quality = (VIDEO_QUALITIES.includes(data.quality as VideoQuality) ? data.quality : '720p') as string;
    const aspectRatio = typeof data.aspectRatio === 'string' && data.aspectRatio.trim() ? data.aspectRatio.trim() : '16:9';
    const prompt = buildVideoPrompt(sanitizedBasePrompt, { aspectRatio, quality, durationSeconds });
    const requestModel = data.model;
    const generationStartedAt = Date.now();
    const generationDurationMs = 120000;
    const runtimeDiagnostics = await getRuntimeDiagnostics();
    setError(null);

    const referenceTokens = findReferenceTokens(basePromptRaw, incomingImages.length);
    const referencedIndex = referenceTokens.length > 0 ? referenceTokens[0].value - 1 : 0;
    const resolvedReferenceIndex = clampNumber(referencedIndex, 0, Math.max(0, incomingImages.length - 1));
    const resolvedReferenceImage = incomingImages[resolvedReferenceIndex] ?? incomingImages[0] ?? '';
    const resolvedReferenceImages = resolvedReferenceImage ? [resolvedReferenceImage] : [];

    const newNodePosition = findNodePosition(
      id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    const resultNodeTitle = buildResultTitle(sanitizedBasePrompt, t('node.videoEdit.resultTitle'));
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.exportVideo,
      newNodePosition,
      {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        aspectRatio,
        displayName: resultNodeTitle,
      }
    );
    addEdge(id, newNodeId);

    try {
      await canvasAiGateway.setApiKey(providerId, providerApiKey);
      const jobId = await canvasAiGateway.submitGenerateVideoJob({
        prompt,
        model: requestModel,
        aspectRatio,
        quality,
        durationSeconds,
        referenceImages: resolvedReferenceImages,
        extraParams: {
          durationSeconds,
          quality,
        },
      });
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'videoEdit',
        providerId,
        requestModel,
        requestSize: quality,
        requestAspectRatio: aspectRatio,
        prompt,
        extraParams: {
          durationSeconds,
          quality,
        },
        referenceImageCount: resolvedReferenceImages.length,
        referenceImagePlaceholders: createReferenceImagePlaceholders(resolvedReferenceImages.length),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'videoEdit',
        generationProviderId: providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationDebugContext,
      });
    } catch (generationError) {
      const resolvedError = resolveErrorContent(generationError, t('ai.error'));
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'videoEdit',
        providerId,
        requestModel: data.model,
        requestSize: data.quality,
        requestAspectRatio: data.aspectRatio,
        prompt,
        extraParams: {
          durationSeconds: data.durationSeconds,
          quality: data.quality,
        },
      };
      const reportText = buildGenerationErrorReport({
        errorMessage: resolvedError.message,
        errorDetails: resolvedError.details,
        context: generationDebugContext,
      });
      setError(resolvedError.message);
      void showErrorDialog(
        resolvedError.message,
        t('common.error'),
        resolvedError.details,
        reportText
      );
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        generationError: resolvedError.message,
        generationErrorDetails: resolvedError.details ?? null,
        generationDebugContext,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    addEdge,
    addNode,
    data,
    findNodePosition,
    id,
    incomingImages,
    isSubmitting,
    providerApiKey,
    providerId,
    t,
    updateNodeData,
  ]);

  return (
    <div
      ref={rootRef}
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/85 p-0 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<VideoIcon className="h-4 w-4" />}
        titleText={resolvedTitle}
        titleClassName="inline-block max-w-[260px] truncate whitespace-nowrap align-bottom"
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="flex h-full w-full flex-col gap-3 rounded-[var(--node-radius)] bg-bg-dark p-4 pt-12">
        <div className="flex flex-1 flex-col gap-2">
          <div
            ref={promptContainerRef}
            className="relative h-full min-h-[140px] w-full rounded-md border border-border-dark bg-surface-dark/70 focus-within:border-accent/70"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div
              ref={promptHighlightRef}
              aria-hidden="true"
              className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-[12px] leading-6 text-text-dark"
              style={{ scrollbarGutter: 'stable' }}
            >
              <div className="min-h-full whitespace-pre-wrap break-words px-3 py-2">
                {renderPromptWithHighlights(promptDraft, incomingImages.length)}
              </div>
            </div>

            <textarea
              ref={promptRef}
              value={promptDraft}
              onChange={(event) => {
                const nextValue = event.target.value;
                setPromptDraft(nextValue);
                commitPromptDraft(nextValue);
              }}
              onKeyDown={handlePromptKeyDown}
              onScroll={syncPromptHighlightScroll}
              placeholder={t('node.videoEdit.promptPlaceholder')}
              className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-3 py-2 text-[12px] leading-6 text-transparent caret-text-dark outline-none placeholder:text-text-muted/70 whitespace-pre-wrap break-words"
              style={{ scrollbarGutter: 'stable' }}
            />

            {showImagePicker && incomingImageItems.length > 0 && (
              <div
                className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
                style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
                onMouseDown={(event) => event.stopPropagation()}
                onWheelCapture={(event) => event.stopPropagation()}
              >
                <div
                  className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
                  onWheelCapture={(event) => event.stopPropagation()}
                >
                  {incomingImageItems.map((item, index) => (
                    <button
                      key={`${item.imageUrl}-${index}`}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        insertImageReference(index);
                      }}
                      onMouseEnter={() => setPickerActiveIndex(index)}
                      className={`flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${pickerActiveIndex === index
                        ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark'
                        : ''
                      }`}
                    >
                      <CanvasNodeImage
                        src={item.displayUrl}
                        alt={item.label}
                        className="h-8 w-8 rounded object-cover"
                        draggable={false}
                        disableViewer
                      />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {error ? (
            <div className="text-[11px] leading-5 text-red-300">{error}</div>
          ) : (
            <div className="text-[11px] leading-5 text-text-muted">
              {t('node.videoEdit.tip')}
              {incomingImages.length > 0
                ? ` · ${t('node.videoEdit.referenceImagesHint', { count: incomingImages.length })}`
                : ''}
              {autoSwitchedModelName
                ? ` · ${t('node.videoEdit.autoSwitchHint', { model: autoSwitchedModelName })}`
                : ''}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            ref={modelTriggerRef}
            type="button"
            className={`${NODE_CONTROL_CHIP_CLASS} ${NODE_CONTROL_MODEL_CHIP_CLASS}`}
            onClick={() => {
              if (openPanel === 'model') {
                closePanel();
                return;
              }
              openPanelAt('model');
            }}
          >
            <Sparkles className={NODE_CONTROL_ICON_CLASS} />
            <span className="max-w-[210px] truncate text-[11px] text-text-dark">{selectedModelLabel}</span>
          </button>

          <button
            ref={paramsTriggerRef}
            type="button"
            className={NODE_CONTROL_CHIP_CLASS}
            onClick={() => {
              if (openPanel === 'params') {
                closePanel();
                return;
              }
              openPanelAt('params');
            }}
          >
            <span className="text-[10px] text-text-muted">{t('modelParams.aspectRatio')}</span>
            <span className="truncate text-[11px] text-text-dark">{paramsSummaryText}</span>
          </button>
        </div>

        <div className="flex items-center justify-end">
          <UiButton
            className={NODE_CONTROL_PRIMARY_BUTTON_CLASS}
            disabled={isSubmitting}
            onClick={() => void handleGenerate()}
          >
            {isSubmitting ? (
              <>
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                {t('node.videoEdit.generating')}
              </>
            ) : (
              t('node.videoEdit.generate')
            )}
          </UiButton>
        </div>
      </div>

      {renderPanel && createPortal(
        <div
          className={`fixed inset-0 z-[80] ${isPanelVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}
        >
          {renderPanel === 'model' && (
            <div
              ref={modelPanelRef}
              className={`
                absolute w-[360px] max-w-[calc(100vw-16px)] rounded-lg border border-border-dark bg-surface-dark shadow-xl
                transition-opacity duration-150
                ${isPanelVisible ? 'opacity-100' : 'opacity-0'}
              `}
              style={{
                left: modelPanelAnchor?.left ?? 8,
                top: modelPanelAnchor?.top ?? 8,
              }}
            >
              <div className="grid grid-cols-1 gap-1 p-2">
                {VIDEO_MODEL_CHOICES.map((item) => {
                  const active = item.id === data.model;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[12px] transition-colors ${active ? 'bg-accent/15 text-text-dark' : 'text-text-dark hover:bg-bg-dark'}`}
                      onClick={() => {
                        updateNodeData(id, { model: item.id });
                        closePanel();
                      }}
                    >
                      <span className="truncate">{item.label}</span>
                      {active ? <span className="text-[10px] text-accent">{t('common.confirm')}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {renderPanel === 'params' && (
            <div
              ref={paramsPanelRef}
              className={`
                absolute w-[420px] max-w-[calc(100vw-16px)] rounded-lg border border-border-dark bg-surface-dark shadow-xl
                transition-opacity duration-150
                ${isPanelVisible ? 'opacity-100' : 'opacity-0'}
              `}
              style={{
                left: paramsPanelAnchor?.left ?? 8,
                top: paramsPanelAnchor?.top ?? 8,
              }}
            >
              <div className="flex flex-col gap-3 p-3">
                <div>
                  <div className="mb-2 text-[11px] font-medium text-text-muted">{t('node.videoEdit.aspectRatio')}</div>
                  <div className="flex flex-wrap gap-2">
                    {Array.from(VIDEO_ASPECT_RATIOS).map((ratio) => {
                      const active = data.aspectRatio === ratio;
                      return (
                        <button
                          key={ratio}
                          type="button"
                          className={`h-8 rounded-md border px-3 text-[11px] transition-colors ${active ? 'border-accent/60 bg-accent/15 text-text-dark' : 'border-border-dark bg-bg-dark/50 text-text-dark hover:bg-bg-dark'}`}
                          onClick={() => updateNodeData(id, { aspectRatio: ratio })}
                        >
                          {ratio}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[11px] font-medium text-text-muted">{t('node.videoEdit.quality')}</div>
                  <div className="flex flex-wrap gap-2">
                    {Array.from(VIDEO_QUALITIES).map((q) => {
                      const active = data.quality === q;
                      return (
                        <button
                          key={q}
                          type="button"
                          className={`h-8 rounded-md border px-3 text-[11px] transition-colors ${active ? 'border-accent/60 bg-accent/15 text-text-dark' : 'border-border-dark bg-bg-dark/50 text-text-dark hover:bg-bg-dark'}`}
                          onClick={() => updateNodeData(id, { quality: q })}
                        >
                          {q}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[11px] font-medium text-text-muted">{t('node.videoEdit.duration')}</div>
                  <div className="flex flex-wrap gap-2">
                    {[2, 3, 4, 5, 6, 8, 10, 12].map((sec) => {
                      const active = Number(data.durationSeconds) === sec;
                      return (
                        <button
                          key={sec}
                          type="button"
                          className={`h-8 rounded-md border px-3 text-[11px] transition-colors ${active ? 'border-accent/60 bg-accent/15 text-text-dark' : 'border-border-dark bg-bg-dark/50 text-text-dark hover:bg-bg-dark'}`}
                          onClick={() => updateNodeData(id, { durationSeconds: sec })}
                        >
                          {sec}s
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    className="h-8 rounded-md px-3 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                    onClick={() => closePanel()}
                  >
                    {t('common.close')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={VIDEO_EDIT_NODE_MIN_WIDTH}
        minHeight={VIDEO_EDIT_NODE_MIN_HEIGHT}
        maxWidth={1400}
        maxHeight={1000}
      />
    </div>
  );
});

VideoEditNode.displayName = 'VideoEditNode';
