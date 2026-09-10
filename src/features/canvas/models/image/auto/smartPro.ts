import type { ImageModelDefinition } from '../../types';
import {
  AUTO_IMAGE_ASPECT_RATIOS,
  AUTO_IMAGE_RESOLUTIONS,
  AUTO_PRO_IMAGE_MODEL_ID,
  AUTO_PROVIDER_ID,
} from './autoCapabilities';

/**
 * 智能出图 · 高质量（虚拟模型）：Pro 模型打头的降级链。
 * requestModel 是占位 id：链模式下由 Rust build_chain 替换为实际 hop 模型。
 */
export const imageModel: ImageModelDefinition = {
  id: AUTO_PRO_IMAGE_MODEL_ID,
  mediaType: 'image',
  displayName: '智能出图 · 高质量',
  providerId: AUTO_PROVIDER_ID,
  description: '高质量链路：Pro 模型打头，失败自动降级到标准链重试',
  eta: '2-4min',
  expectedDurationMs: 150000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: AUTO_IMAGE_ASPECT_RATIOS,
  resolutions: AUTO_IMAGE_RESOLUTIONS,
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: AUTO_PRO_IMAGE_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
