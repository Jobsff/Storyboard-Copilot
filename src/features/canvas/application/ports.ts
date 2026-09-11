import type { XYPosition } from '@xyflow/react';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
} from '../domain/canvasNodes';
import type { CanvasNodeDefinition } from '../domain/nodeRegistry';

export interface IdGenerator {
  next: () => string;
}

export interface NodeCatalog {
  getDefinition: (type: CanvasNodeType) => CanvasNodeDefinition;
  getMenuDefinitions: () => CanvasNodeDefinition[];
}

export interface NodeFactory {
  createNode: (
    type: CanvasNodeType,
    position: XYPosition,
    data?: Partial<CanvasNodeData>
  ) => CanvasNode;
}

export interface GraphImageResolver {
  collectInputImages: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
}

/** 自动降级链选项（仅智能出图虚拟模型注入；不带 = 单点直连）。 */
export interface GenerateImageFallback {
  quality: 'standard' | 'pro';
  availableProviders: string[];
  /** NEWAPI 接口 / aifast 追加档（批次8，可选；缺省空 = 行为与 v0.3.0 一致）。 */
  extraHops?: Array<{ provider_id: string; model: string; display_name: string }>;
}

export interface GenerateImagePayload {
  prompt: string;
  model: string;
  size: string;
  aspectRatio: string;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
  fallback?: GenerateImageFallback;
}

export interface GenerateVideoPayload {
  prompt: string;
  model: string;
  aspectRatio: string;
  quality: string;
  durationSeconds: number;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
}

export interface ReversePromptPayload {
  image: string;
  language?: string;
  format?: 'text' | 'json';
  model?: string;
}

export interface AiGateway {
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  generateImage: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJob: (payload: GenerateImagePayload) => Promise<string>;
  getGenerateImageJob: (jobId: string) => Promise<{
    job_id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';
    result?: string | null;
    error?: string | null;
    error_class?: string | null;
    provider_id?: string | null;
    model?: string | null;
    attempts?: Array<{
      provider_id: string;
      model: string;
      error_class?: string | null;
      error?: string | null;
    }>;
    /** 公司 OSS 归档直链（批次11）；成功且已归档才有。 */
    ossUrl?: string | null;
  }>;
  submitGenerateVideoJob: (payload: GenerateVideoPayload) => Promise<string>;
  getGenerateVideoJob: (jobId: string) => Promise<{
    job_id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';
    result?: string | null;
    error?: string | null;
    error_class?: string | null;
    provider_id?: string | null;
    model?: string | null;
    attempts?: Array<{
      provider_id: string;
      model: string;
      error_class?: string | null;
      error?: string | null;
    }>;
    /** 公司 OSS 归档直链（批次11）；成功且已归档才有。 */
    ossUrl?: string | null;
  }>;
  reversePrompt: (provider: string, payload: ReversePromptPayload) => Promise<string>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number
  ) => Promise<string[]>;
}

export interface ToolProcessorResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface ToolProcessor {
  process: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  'tool-dialog/open': {
    nodeId: string;
    toolType: NodeToolType;
  };
  'tool-dialog/close': undefined;
  'upload-node/reupload': {
    nodeId: string;
  };
  'upload-node/paste-image': {
    nodeId: string;
    file: File;
  };
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ) => void;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ) => () => void;
}
