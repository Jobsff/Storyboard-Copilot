import type { ImageModelDefinition } from '../../types';
import {
  AUTO_GPT_PRO_IMAGE_MODEL_ID,
  AUTO_IMAGE_ASPECT_RATIOS,
  AUTO_IMAGE_RESOLUTIONS,
  AUTO_PROVIDER_ID,
} from './autoCapabilities';

/**
 * 智能出图 · GPT 高质量（虚拟模型）：grsai gpt-image-2.5-sunburst 单档链。
 * requestModel 是占位 id：链模式下由 Rust build_chain 替换为实际 hop 模型。
 */
export const imageModel: ImageModelDefinition = {
  id: AUTO_GPT_PRO_IMAGE_MODEL_ID,
  mediaType: 'image',
  displayName: '智能出图 · GPT 高质量',
  providerId: AUTO_PROVIDER_ID,
  description: 'GPT 系高质量档位：gpt-image-2.5-sunburst 打头，失败按链自动降级重试',
  eta: '2-4min',
  expectedDurationMs: 150000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: AUTO_IMAGE_ASPECT_RATIOS,
  resolutions: AUTO_IMAGE_RESOLUTIONS,
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: AUTO_GPT_PRO_IMAGE_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
