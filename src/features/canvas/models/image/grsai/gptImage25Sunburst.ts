import type { ImageModelDefinition } from '../../types';
import { createGrsaiPointsPricing } from '@/features/canvas/pricing';
import { GRSAI_GPT25_QUALITY_KEY } from './gptImage25Flare';

export const GRSAI_GPT_25_SUNBURST_MODEL_ID = 'grsai/gpt-image-2.5-sunburst';

const GPT25_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
  '9:21',
  '2:1',
  '1:2',
] as const;

const GPT25_RESOLUTIONS = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

/**
 * GRSAI gpt-image-2.5-sunburst：i2i 精修线（4K 直出 ~38s，质量更细，¥0.15/张 1K-4K 同价）。
 * 走 GRSAI /v1/api/generate 端点，aspectRatio 以像素串下发的 gpt 系模型。
 * 情报源：image-studio 技能 2026-09-10 实测。
 */
export const imageModel: ImageModelDefinition = {
  id: GRSAI_GPT_25_SUNBURST_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2.5 Sunburst',
  providerId: 'grsai',
  description: 'GRSAI gpt-image-2.5-sunburst：i2i 精修，4K 直出约 38s，质量更细',
  eta: '1min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  extraParamsSchema: [
    {
      key: GRSAI_GPT25_QUALITY_KEY,
      label: '质量档',
      type: 'enum',
      options: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
      defaultValue: 'auto',
    },
  ],
  defaultExtraParams: {
    [GRSAI_GPT25_QUALITY_KEY]: 'auto',
  },
  aspectRatios: GPT25_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: GPT25_RESOLUTIONS,
  pricing: createGrsaiPointsPricing(() => 3000),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_25_SUNBURST_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
