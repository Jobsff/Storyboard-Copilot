import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Loader2, Play, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { craftImagePrompt } from '@/commands/ai';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  type ImageSize,
  type SequenceFrameGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasAiGateway,
  graphImageResolver,
} from '@/features/canvas/application/canvasServices';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { persistImageLocally } from '@/features/canvas/application/imageData';
import { embedStoryboardImageMetadata } from '@/commands/image';
import { TRANSPARENT_BACKGROUND_EXTRA_PARAM_KEY } from '@/features/canvas/application/transparentBackground';
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  listImageModels,
  resolveImageModelResolution,
  resolveImageModelResolutions,
} from '@/features/canvas/models';
import { resolve666ApiKey } from '@/features/canvas/models/providers/api666';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_MODEL_CHIP_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton, UiSelect } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type SequenceFrameGenNodeProps = NodeProps & {
  id: string;
  data: SequenceFrameGenNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 330;
const NODE_MIN_HEIGHT = 420;
const GRID_ROWS = 3;
const GRID_COLS = 3;
const GRID_FRAME_COUNT = GRID_ROWS * GRID_COLS;
const IMAGE_JOB_POLL_INTERVAL_MS = 1800;
const IMAGE_JOB_TIMEOUT_MS = 8 * 60 * 1000;
const STRICT_TRANSPARENT_BACKGROUND_REQUIREMENT =
  'Background must be transparent: real PNG, RGBA mode, real valid Alpha channel, background area alpha value must be 0. Do not use checkerboard, white background, gray background, fake transparent background, shadows on a solid canvas, or any painted backdrop.';

function resolveProviderApiKey(providerId: string, apiKeys: Record<string, string>, modelId: string): string {
  if (providerId === '666api') {
    return resolve666ApiKey(modelId, apiKeys) ?? '';
  }
  return apiKeys[providerId] ?? '';
}

function resolveAssistantApiKey(
  providerId: string,
  apiKeys: Record<string, string>,
  assistantModel: string,
  fallbackKey: string
): string {
  if (providerId === '666api') {
    return resolve666ApiKey(assistantModel || 'gemini-3.1-flash-image-preview', apiKeys) ?? fallbackKey;
  }
  return apiKeys[providerId] || fallbackKey;
}

function buildFrameNotes(action: string): string[] {
  const normalized = action.trim() || '角色待机循环动作';
  const stages = resolveActionStages(normalized);
  return stages.map((stage) => `${normalized} - ${stage}`);
}

function resolveActionStages(action: string): string[] {
  const normalized = action.toLowerCase();
  const isWalk = /走|步行|walk|walking|left|right|向左|向右/.test(normalized);
  const isRun = /跑|奔跑|run|running|冲刺|dash/.test(normalized);
  const isJump = /跳|jump|leap/.test(normalized);
  const isAttack = /攻击|挥砍|战斗|打击|attack|slash|strike|fight|combat/.test(normalized);
  const isMagic = /魔法|施法|法术|magic|spell|cast/.test(normalized);

  if (isWalk || isRun) {
    const speed = isRun ? 'run' : 'walk';
    return [
      `${speed} contact pose, left foot forward, right foot back`,
      `${speed} down pose, body weight lowered`,
      `${speed} passing pose, rear foot passing under body`,
      `${speed} up pose, body lifted, opposite arm swing`,
      `${speed} contact pose, right foot forward, left foot back`,
      `${speed} down pose on opposite side`,
      `${speed} passing pose on opposite side`,
      `${speed} up pose on opposite side`,
      `${speed} loop return pose, ready to connect to frame 1`,
    ];
  }

  if (isJump) {
    return [
      'idle ready pose before jump',
      'deep crouch anticipation, knees bent',
      'takeoff pose, feet leaving ground',
      'rising pose, body stretched upward',
      'apex pose at highest point',
      'falling pose, body preparing to land',
      'landing contact pose, feet touch ground',
      'landing squash pose, knees bent absorbing impact',
      'recovery pose returning to idle',
    ];
  }

  if (isMagic) {
    return [
      'ready stance, hands preparing magic',
      'anticipation pose, body twists and gathers energy',
      'charging pose, magical glow begins',
      'strong casting pose, arm thrust forward',
      'impact release pose, spell energy bursts out',
      'follow-through pose, robe and hair trailing',
      'recoil pose after casting',
      'settling pose, magic fading',
      'return to ready stance',
    ];
  }

  if (isAttack) {
    return [
      'combat idle ready stance',
      'anticipation wind-up, body pulls back',
      'attack startup, weapon or arm begins swing',
      'fast swing pose, strong motion arc',
      'impact key pose, maximum extension',
      'follow-through pose, body momentum continues',
      'recovery recoil pose',
      'settling back to guard',
      'return to combat idle ready stance',
    ];
  }

  return [
    'starting pose',
    'anticipation pose',
    'early action pose',
    'middle action pose',
    'strong key pose',
    'follow-through pose',
    'recovery pose',
    'settling pose',
    'loop return pose',
  ];
}

function buildLocalSequencePrompt(action: string, hasReferenceImage: boolean): string {
  const normalizedAction = action.trim() || '角色跑动循环';
  const stages = resolveActionStages(normalizedAction);
  const referenceHint = hasReferenceImage
    ? 'Use the provided character reference image as the identity source. Preserve the same character identity, costume, colors, body proportions, face, hairstyle, silhouette, and art style in every cell.'
    : 'Create one consistent game character design and keep it identical in every cell.';

  return [
    'Create a 3x3 nine-frame sprite animation sheet for a 2D game character animation.',
    referenceHint,
    `Animation action: ${normalizedAction}.`,
    'The 9 cells must be sequential animation keyframes ordered left to right, top to bottom. Every cell must show a different pose and a clear time progression.',
    'Do NOT repeat the same standing pose. Do NOT create nine duplicate characters. Treat each cell as one frame of the same character over time.',
    ...stages.map((stage, index) => `Frame ${index + 1}: ${stage}.`),
    'Keep one full-body character in each cell, centered, same scale, same camera angle, same lighting, same style, but with clearly different limb positions, weight shift, hair/cloth movement, and silhouette.',
    'Critical layout rule: the complete character must stay fully inside each cell with generous safe margins. No head, hair, feet, weapon, hand, or clothing may cross cell borders or be cropped.',
    'Critical anchor rule: align every frame to the same ground baseline and the same center pivot. Feet should land on a consistent invisible floor line; body center should stay near the center of each cell.',
    'Use strong animation principles: anticipation, contact, passing, impact, follow-through, recovery, and loop continuity.',
    'Use visible motion arcs or subtle ghost-free pose changes only; no text, no labels, no numbers, no speech bubbles, no UI, no watermark.',
    STRICT_TRANSPARENT_BACKGROUND_REQUIREMENT,
    'If the upstream model cannot produce true alpha, keep the background absolutely plain pure white with no gradients, no texture, no drop shadow, and no contact shadow so the app can extract alpha cleanly.',
    'Ensure the grid can be cropped evenly into 9 independent frames.',
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForGeneratedImage(jobId: string): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < IMAGE_JOB_TIMEOUT_MS) {
    const status = await canvasAiGateway.getGenerateImageJob(jobId);
    if (status.status === 'succeeded') {
      const result = status.result?.trim();
      if (!result) {
        throw new Error('图片生成任务已完成，但没有返回图片结果');
      }
      return result;
    }

    if (status.status === 'failed' || status.status === 'not_found') {
      throw new Error(status.error || '图片生成任务失败');
    }

    await sleep(IMAGE_JOB_POLL_INTERVAL_MS);
  }

  throw new Error('图片生成等待超时，请稍后在供应商侧确认任务状态');
}

export const SequenceFrameGenNode = memo(function SequenceFrameGenNode({
  id,
  data,
  selected,
  width,
  height,
}: SequenceFrameGenNodeProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const aiAssistantProvider = useSettingsStore((state) => state.aiAssistantProvider);
  const aiAssistantModel = useSettingsStore((state) => state.aiAssistantModel);
  const setLastUsedImageModel = useSettingsStore((state) => state.setLastUsedImageModel);
  const [error, setError] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState(() => data.action ?? '');
  const actionDraftRef = useRef(actionDraft);

  const imageModels = useMemo(() => listImageModels(), []);
  const selectedModel = useMemo(() => getImageModel(data.model || DEFAULT_IMAGE_MODEL_ID), [data.model]);
  const resolutionOptions = useMemo(
    () => resolveImageModelResolutions(selectedModel, { extraParams: data.extraParams }),
    [data.extraParams, selectedModel]
  );
  const selectedResolution = useMemo(
    () => resolveImageModelResolution(selectedModel, data.size, { extraParams: data.extraParams }),
    [data.extraParams, data.size, selectedModel]
  );
  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [edges, id, nodes]
  );
  const title = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.sequenceFrameGen, data),
    [data]
  );
  const resolvedWidth = Math.max(NODE_WIDTH, Math.round(width ?? NODE_WIDTH));
  const resolvedHeight = Math.max(NODE_MIN_HEIGHT, Math.round(height ?? NODE_MIN_HEIGHT));
  const modelApiKey = useMemo(
    () => resolveProviderApiKey(selectedModel.providerId, apiKeys, selectedModel.id),
    [apiKeys, selectedModel.id, selectedModel.providerId]
  );
  const promptPreview = data.generatedPrompt || data.prompt || buildLocalSequencePrompt(actionDraft, incomingImages.length > 0);

  useEffect(() => {
    const externalAction = data.action ?? '';
    if (externalAction !== actionDraftRef.current) {
      actionDraftRef.current = externalAction;
      setActionDraft(externalAction);
    }
  }, [data.action]);

  const commitActionDraft = useCallback(
    (nextAction = actionDraftRef.current) => {
      if ((data.action ?? '') === nextAction) {
        return;
      }
      updateNodeData(id, {
        action: nextAction,
        generatedPrompt: null,
        prompt: '',
      });
    },
    [data.action, id, updateNodeData]
  );

  const updateActionDraft = useCallback(
    (action: string) => {
      actionDraftRef.current = action;
      setActionDraft(action);
    },
    []
  );

  const updateModel = useCallback(
    (modelId: string) => {
      const nextModel = getImageModel(modelId);
      const nextResolutionOptions = resolveImageModelResolutions(nextModel, {
        extraParams: nextModel.defaultExtraParams,
      });
      const nextResolution =
        nextResolutionOptions.find((option) => option.value === '1K') ??
        resolveImageModelResolution(nextModel, undefined, {
          extraParams: nextModel.defaultExtraParams,
        });
      updateNodeData(id, {
        model: nextModel.id,
        size: nextResolution.value as ImageSize,
        extraParams: nextModel.defaultExtraParams ?? {},
      });
      setLastUsedImageModel(nextModel.id);
    },
    [id, setLastUsedImageModel, updateNodeData]
  );

  const craftSequencePrompt = useCallback(async (): Promise<string> => {
    const currentAction = actionDraftRef.current;
    const localPrompt = buildLocalSequencePrompt(currentAction, incomingImages.length > 0);
    const provider = aiAssistantProvider || selectedModel.providerId;
    const assistantKey = resolveAssistantApiKey(
      provider,
      apiKeys,
      aiAssistantModel,
      provider === selectedModel.providerId ? modelApiKey : ''
    );
    if (!assistantKey && provider !== 'ollama') {
      return localPrompt;
    }

    const userInput = [
      '请把下面的动画需求改写成适合 AI 生图模型的一张 3x3 九宫格序列帧提示词。',
      '要求：角色一致、动作连续、从左到右从上到下阅读、无文字无编号、每格可等分裁切、适合 2D 游戏角色动画/Spine 序列帧使用。',
      '强制要求：每一格角色完整身体必须在格子正中间，脚底在同一条隐形地面基线，头发/脚/武器/衣服不能越出格子边界。每格姿态必须不同，不能复制同一个站姿。',
      `背景强制要求：${STRICT_TRANSPARENT_BACKGROUND_REQUIREMENT}`,
      '如果模型无法生成真实 Alpha，则必须使用绝对纯白、无纹理、无渐变、无阴影、无接触投影的空背景，方便后处理抠成透明。',
      incomingImages.length > 0 ? '用户会提供角色参考图，请强调严格保持参考图角色身份、服装、比例、画风。' : '如果没有参考图，请要求创建并保持同一个角色设计。',
      `动作关键词：${currentAction.trim() || '角色跑动循环'}`,
      `帧数：${GRID_FRAME_COUNT}，布局：${GRID_ROWS}x${GRID_COLS}，FPS：${data.fps || 6}`,
      '输出只要最终英文提示词，不要解释。',
    ].join('\n');

    try {
      const crafted = await craftImagePrompt({
        provider,
        apiKey: assistantKey,
        userInput,
        category: 'gameAsset',
        model: aiAssistantModel || undefined,
        language: 'en',
      });
      return [
        crafted,
        '',
        'STRICT SEQUENCE REQUIREMENTS:',
        localPrompt,
        '',
        'STRICT TRANSPARENCY REQUIREMENTS:',
        STRICT_TRANSPARENT_BACKGROUND_REQUIREMENT,
      ].join('\n');
    } catch {
      return localPrompt;
    }
  }, [
    aiAssistantModel,
    aiAssistantProvider,
    apiKeys,
    data.fps,
    incomingImages.length,
    modelApiKey,
    selectedModel.providerId,
  ]);

  const handleGenerate = useCallback(async () => {
    if (!modelApiKey && selectedModel.providerId !== 'ollama') {
      const message = t('node.sequenceFrameGen.apiKeyRequired');
      setError(message);
      await showErrorDialog(message, t('common.error'));
      return;
    }

    setError(null);
    const currentAction = actionDraftRef.current;
    commitActionDraft(currentAction);
    updateNodeData(id, {
      isGenerating: true,
      generationStatus: t('node.sequenceFrameGen.statusCraftingPrompt'),
    });

    try {
      const craftedPrompt = await craftSequencePrompt();
      updateNodeData(id, {
        prompt: craftedPrompt,
        generatedPrompt: craftedPrompt,
        generationStatus: t('node.sequenceFrameGen.statusGeneratingImage'),
      });

      await canvasAiGateway.setApiKey(selectedModel.providerId, modelApiKey);
      const requestResolution = selectedModel.resolveRequest({
        referenceImageCount: incomingImages.length,
      });
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt: craftedPrompt,
        model: requestResolution.requestModel,
        size: selectedResolution.value,
        aspectRatio: DEFAULT_ASPECT_RATIO,
        referenceImages: incomingImages,
        extraParams: {
          ...(data.extraParams ?? {}),
          [TRANSPARENT_BACKGROUND_EXTRA_PARAM_KEY]: true,
        },
      });
      updateNodeData(id, {
        generationStatus: t('node.sequenceFrameGen.statusWaitingImage'),
      });
      const imageSource = await waitForGeneratedImage(jobId);
      const persistedGridImage = await persistImageLocally(imageSource);
      const frameNotes = buildFrameNotes(currentAction);
      const gridImageWithMetadata = await embedStoryboardImageMetadata(persistedGridImage, {
        gridRows: GRID_ROWS,
        gridCols: GRID_COLS,
        frameNotes,
      }).catch(() => persistedGridImage);

      updateNodeData(id, {
        generationStatus: t('node.sequenceFrameGen.statusCreatingGrid'),
      });
      const gridNodeId = addDerivedExportNode(
        id,
        gridImageWithMetadata,
        DEFAULT_ASPECT_RATIO,
        gridImageWithMetadata,
        {
          defaultTitle: t('node.sequenceFrameGen.gridResultTitle'),
          resultKind: 'storyboardGenOutput',
          sizeStrategy: 'generated',
        }
      );
      if (gridNodeId) {
        addEdge(id, gridNodeId);
        updateNodeData(gridNodeId, {
          animationFps: data.fps || 6,
          generationStoryboardMetadata: {
            gridRows: GRID_ROWS,
            gridCols: GRID_COLS,
            frameNotes,
          },
        });
      }

      updateNodeData(id, {
        isGenerating: false,
        generationStatus: t('node.sequenceFrameGen.statusDone'),
      });
      setSelectedNode(gridNodeId ?? null);
    } catch (generationError) {
      const resolved = resolveErrorContent(generationError, t('node.sequenceFrameGen.generateFailed'));
      setError(resolved.message);
      updateNodeData(id, {
        isGenerating: false,
        generationStatus: resolved.message,
      });
      await showErrorDialog(resolved.message, t('common.error'), resolved.details);
    }
  }, [
    addDerivedExportNode,
    addEdge,
    commitActionDraft,
    craftSequencePrompt,
    data.extraParams,
    data.fps,
    id,
    incomingImages,
    modelApiKey,
    selectedModel,
    selectedResolution.value,
    setSelectedNode,
    t,
    updateNodeData,
  ]);

  return (
    <div
      className={`
        group relative flex h-full w-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        titleText={title}
        titleClassName="inline-block max-w-[220px] truncate whitespace-nowrap align-bottom"
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <Handle type="target" position={Position.Left} id="target" />
      <Handle type="source" position={Position.Right} id="source" />

      <div className="nodrag flex flex-1 flex-col gap-3 p-4 pt-10">
        <div className="rounded-2xl border border-amber-300/25 bg-[linear-gradient(135deg,rgba(245,158,11,0.16),rgba(20,184,166,0.10))] p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-dark">
            <Sparkles className="h-3.5 w-3.5 text-amber-300" />
            {t('node.sequenceFrameGen.assistantTitle')}
          </div>
          <div className="text-[11px] leading-relaxed text-text-muted">
            {t('node.sequenceFrameGen.assistantHint')}
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-text-muted">{t('node.sequenceFrameGen.actionLabel')}</span>
          <textarea
            value={actionDraft}
            onChange={(event) => updateActionDraft(event.target.value)}
            onBlur={() => commitActionDraft()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
            placeholder={t('node.sequenceFrameGen.actionPlaceholder')}
            className="ui-scrollbar nowheel h-20 resize-none rounded-2xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/70 px-3 py-2 text-sm text-text-dark outline-none transition focus:border-accent"
          />
        </label>

        <div className="flex items-center gap-2">
          <span className={NODE_CONTROL_MODEL_CHIP_CLASS}>
            <UiSelect
              value={selectedModel.id}
              onChange={(event) => updateModel(event.target.value)}
              className="h-7 max-w-[168px] border-0 bg-transparent px-1 text-[11px]"
            >
              {imageModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </UiSelect>
          </span>
          <span className={NODE_CONTROL_CHIP_CLASS}>
            <UiSelect
              value={selectedResolution.value}
              onChange={(event) => updateNodeData(id, { size: event.target.value as ImageSize })}
              className="h-7 border-0 bg-transparent px-1 text-[11px]"
            >
              {resolutionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </UiSelect>
          </span>
          <span className={NODE_CONTROL_CHIP_CLASS}>
            <UiSelect
              value={String(data.fps || 6)}
              onChange={(event) => updateNodeData(id, { fps: Number(event.target.value) })}
              className="h-7 border-0 bg-transparent px-1 text-[11px]"
            >
              {[4, 6, 8, 10, 12, 15, 24].map((fps) => (
                <option key={fps} value={fps}>
                  {fps} FPS
                </option>
              ))}
            </UiSelect>
          </span>
        </div>

        <div className="min-h-0 flex-1 rounded-2xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/45 p-3">
          <div className="mb-1 text-[11px] font-medium text-text-muted">
            {t('node.sequenceFrameGen.promptPreview')}
          </div>
          <div className="ui-scrollbar max-h-28 overflow-y-auto whitespace-pre-wrap text-[10px] leading-relaxed text-text-dark/80">
            {promptPreview}
          </div>
        </div>

        {data.generationStatus ? (
          <div className="text-[11px] text-text-muted">{data.generationStatus}</div>
        ) : null}
        {error ? <div className="text-[11px] text-red-300">{error}</div> : null}

        <UiButton
          type="button"
          className={`${NODE_CONTROL_PRIMARY_BUTTON_CLASS} h-9 w-full justify-center gap-2 rounded-2xl`}
          onClick={(event) => {
            event.stopPropagation();
            void handleGenerate();
          }}
          disabled={Boolean(data.isGenerating)}
        >
          {data.isGenerating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {data.isGenerating
            ? t('node.sequenceFrameGen.generating')
            : t('node.sequenceFrameGen.generate')}
        </UiButton>
      </div>

      <NodeResizeHandle minWidth={NODE_WIDTH} minHeight={NODE_MIN_HEIGHT} />
    </div>
  );
});
