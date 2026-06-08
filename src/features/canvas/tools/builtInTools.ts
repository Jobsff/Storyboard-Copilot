import {
  NODE_TOOL_TYPES,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type CanvasNode,
} from '../domain/canvasNodes';
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

export const builtInToolPlugins: CanvasToolPlugin[] = [
  cropToolPlugin,
  annotateToolPlugin,
  splitStoryboardToolPlugin,
  scaleToolPlugin,
];
