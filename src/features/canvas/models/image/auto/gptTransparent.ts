import type { ImageModelDefinition } from '../../types';
import {
  AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID,
  AUTO_IMAGE_ASPECT_RATIOS,
  AUTO_IMAGE_RESOLUTIONS,
  AUTO_PROVIDER_ID,
} from './autoCapabilities';

/**
 * 智能出图 · GPT 透明底（虚拟模型）：grsai gpt-image-2 原生透明参数打头，
 * 666api / juyouapi gpt-image-2 提示词式透明兜底（hop 级 overlay 自动标
 * transparent_background，Rust 侧合并进 extra_params）。
 * requestModel 是占位 id：链模式下由 Rust build_chain 替换为实际 hop 模型。
 */
export const imageModel: ImageModelDefinition = {
  id: AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID,
  mediaType: 'image',
  displayName: '智能出图 · GPT 透明底',
  providerId: AUTO_PROVIDER_ID,
  description: '透明背景 PNG 档位：gpt-image-2 跨渠道降级链，自动追加透明底要求',
  eta: '1-3min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: AUTO_IMAGE_ASPECT_RATIOS,
  resolutions: AUTO_IMAGE_RESOLUTIONS,
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
