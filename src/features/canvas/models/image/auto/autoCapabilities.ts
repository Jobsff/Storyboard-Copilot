import type { AspectRatioOption, ResolutionOption } from '../../types';

/** 虚拟供应商 id：不绑定真实渠道，提交时由 application 层注入降级链 fallback。 */
export const AUTO_PROVIDER_ID = 'auto';

export const AUTO_STANDARD_IMAGE_MODEL_ID = 'auto/standard';
export const AUTO_PRO_IMAGE_MODEL_ID = 'auto/pro';

/** 智能出图质量档位（与 Rust 侧 chain.rs 的 QUALITY_STANDARD / QUALITY_PRO 对齐）。 */
export type ImageAutoQuality = 'standard' | 'pro';

/** 链成员能力并集 · 比例（对齐 registry.ts RUNTIME_DEFAULT_ASPECT_RATIOS）。 */
export const AUTO_IMAGE_ASPECT_RATIOS: AspectRatioOption[] = [
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '2:3', label: '2:3' },
  { value: '3:2', label: '3:2' },
];

/** 链成员能力并集 · 分辨率。 */
export const AUTO_IMAGE_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

/** 由 auto 模型 id 推导链质量档位（非 pro 一律按 standard）。 */
export function resolveAutoImageQuality(modelId: string): ImageAutoQuality {
  return modelId === AUTO_PRO_IMAGE_MODEL_ID ? 'pro' : 'standard';
}

/** 是否为智能出图虚拟模型（按 providerId 判定，兼容自定义 id 场景）。 */
export function isAutoImageModelId(modelId: string): boolean {
  return modelId === AUTO_STANDARD_IMAGE_MODEL_ID || modelId === AUTO_PRO_IMAGE_MODEL_ID;
}
