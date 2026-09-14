import {
  NODE_TOOL_TYPES,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type CanvasNode,
} from '../domain/canvasNodes';
import { readMattingKeyColorsFromOptions } from '../application/matting';
import { stringifyAnnotationItems } from './annotation';
import type { CanvasToolPlugin } from './types';

function supportsImageSourceNode(node: CanvasNode): boolean {
  return isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node);
}

export const cropToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.crop,
  label: '裁剪',
  icon: 'crop',
  editor: 'crop',
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  createInitialOptions: () => ({
    aspectRatio: 'free',
    customAspectRatio: '',
  }),
  fields: [
    {
      key: 'aspectRatio',
      label: '目标比例',
      type: 'select',
      options: [
        { label: '自由', value: 'free' },
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
      ],
    },
  ],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.crop, sourceImageUrl, options),
};

export const annotateToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.annotate,
  label: '标注',
  icon: 'annotate',
  editor: 'annotate',
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  createInitialOptions: () => ({
    color: '#ff4d4f',
    lineWidthPercent: 0.4,
    fontSizePercent: 10,
    annotations: stringifyAnnotationItems([]),
  }),
  fields: [],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.annotate, sourceImageUrl, options),
};

export const splitStoryboardToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.splitStoryboard,
  label: '切割',
  icon: 'split',
  editor: 'split',
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  createInitialOptions: (node) => {
    const isSequenceFrameGridOutput =
      isExportImageNode(node) && node.data.resultKind === 'storyboardGenOutput';
    return {
      rows: 3,
      cols: 3,
      lineThicknessPercent: isSequenceFrameGridOutput ? 0 : 0.5,
      selectedFrameIndices: '',
      sequenceAnimationMode: isSequenceFrameGridOutput,
      transparentBackgroundMode: isSequenceFrameGridOutput ? 'auto' : 'none',
      normalizeSequenceFrames: isSequenceFrameGridOutput,
      animationFps: 6,
    };
  },
  fields: [],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.splitStoryboard, sourceImageUrl, options),
};

export const scaleToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.scale,
  label: 'Scale',
  icon: 'scale',
  editor: 'form',
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  createInitialOptions: () => ({
    scalePercent: 100,
  }),
  fields: [
    {
      key: 'scalePercent',
      label: 'Scale (%)',
      labelKey: 'toolFields.scale.scalePercent',
      type: 'number',
      min: 10,
      max: 400,
      step: 5,
    },
  ],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.scale, sourceImageUrl, options),
};

export const mattingToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.matting,
  label: '抠图',
  icon: 'matting',
  editor: 'matting',
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  // options 形态 `{ keyColors?: RgbTuple[] }`（批次15 多键；兼容旧单键 keyColor）：
  // 编辑器写入（"r,g,b|r,g,b" 字符串落盘）、execute 读
  createInitialOptions: () => ({}),
  fields: [],
  isApplyEnabled: (options) => readMattingKeyColorsFromOptions(options) !== null,
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.matting, sourceImageUrl, options),
};

export const aiMattingToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.aiMatting,
  label: 'AI 抠图',
  icon: 'aiMatting',
  editor: 'aiMatting',
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  // options 形态 `{ aiMattingResultDataUrl?: string }`：编辑器每次 decode 后写入合成结果，
  // 应用时直接作为产物落新节点（无蒙版时 isApplyEnabled 禁用应用）
  createInitialOptions: () => ({}),
  fields: [],
  isApplyEnabled: (options) =>
    typeof options.aiMattingResultDataUrl === 'string' &&
    options.aiMattingResultDataUrl.startsWith('data:image/'),
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.aiMatting, sourceImageUrl, options),
};

export const aiBirefMattingToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.aiBirefMatting,
  label: 'AI 去底',
  icon: 'aiBirefMatting',
  // 零交互工具：无编辑器插槽，工具条点击即执行（immediate），结果直接落新节点
  immediate: true,
  supportsNode: (node) => supportsImageSourceNode(node) && Boolean(node.data.imageUrl),
  createInitialOptions: () => ({}),
  fields: [],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.aiBirefMatting, sourceImageUrl, options),
};

export const builtInToolPlugins: CanvasToolPlugin[] = [
  cropToolPlugin,
  annotateToolPlugin,
  splitStoryboardToolPlugin,
  scaleToolPlugin,
  mattingToolPlugin,
  aiMattingToolPlugin,
  aiBirefMattingToolPlugin,
];
