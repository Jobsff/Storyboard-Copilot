import type { ImageModelDefinition } from '../../types';
import {
  AUTO_IMAGE_ASPECT_RATIOS,
  AUTO_IMAGE_RESOLUTIONS,
  AUTO_PROVIDER_ID,
  AUTO_STANDARD_IMAGE_MODEL_ID,
} from './autoCapabilities';

/**
 * 智能出图 · 标准（虚拟模型）。
 * requestModel 是占位 id：链模式下由 Rust build_chain 替换为实际 hop 模型；
 * 绝不能在没有 fallback 的情况下把该 id 直接发给 Rust（空链由前端拦截）。
 */
export const imageModel: ImageModelDefinition = {
  id: AUTO_STANDARD_IMAGE_MODEL_ID,
  mediaType: 'image',
  displayName: '智能出图 · 标准',
  providerId: AUTO_PROVIDER_ID,
  description: '自动路由可用生图渠道，失败按价格优先自动降级重试',
  eta: '1-3min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: AUTO_IMAGE_ASPECT_RATIOS,
  resolutions: AUTO_IMAGE_RESOLUTIONS,
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: AUTO_STANDARD_IMAGE_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
