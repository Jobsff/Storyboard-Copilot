import type { ImageModelDefinition } from '../../types';
import { createGrsaiPointsPricing } from '@/features/canvas/pricing';

export const GRSAI_GPT_IMAGE_2_MODEL_ID = 'grsai/gpt-image-2';
export const GRSAI_GPT_IMAGE_2_TRANSPARENT_BACKGROUND_KEY = 'transparent_background';

/**
 * GRSAI gpt-image-2：透明底专用（真 RGBA 直出，约 1254² 上限，仅 1K 档）。
 * 与 666api/gpt-image-2 的提示词式透明底不同——grsai 网关透传真 API 参数
 * `background:"transparent"`（POST /v1/api/generate）。
 * 情报源：image-studio 技能 2026-09-10 实测（¥0.03/张 = 600 点）。
 */
export const imageModel: ImageModelDefinition = {
  id: GRSAI_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2 · 透明底',
  providerId: 'grsai',
  description: 'GRSAI gpt-image-2 透明底直出（真 RGBA，约 1254² 上限）',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  extraParamsSchema: [
    {
      key: GRSAI_GPT_IMAGE_2_TRANSPARENT_BACKGROUND_KEY,
      label: '透明背景',
      labelKey: 'modelParams.transparentBackground',
      type: 'boolean',
      description: '向 GRSAI 网关透传 background=transparent API 参数，直出真 RGBA 透明底。',
      descriptionKey: 'modelParams.grsaiTransparentBackgroundDesc',
      defaultValue: false,
    },
  ],
  defaultExtraParams: {
    [GRSAI_GPT_IMAGE_2_TRANSPARENT_BACKGROUND_KEY]: false,
  },
  aspectRatios: [
    { value: '1:1', label: '1:1' },
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '4:3', label: '4:3' },
    { value: '3:4', label: '3:4' },
    { value: '3:2', label: '3:2' },
    { value: '2:3', label: '2:3' },
    { value: '5:4', label: '5:4' },
    { value: '4:5', label: '4:5' },
    { value: '21:9', label: '21:9' },
  ],
  resolutions: [
    { value: '1K', label: '1K' },
  ],
  pricing: createGrsaiPointsPricing(() => 600),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
