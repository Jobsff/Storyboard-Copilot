import type { ImageModelDefinition } from '../../types';
import { GRSAI_GPT25_QUALITY_KEY } from './gptImage25Flare';

export const GRSAI_GPT_25_MODEL_ID = 'grsai/gpt-image-2.5';

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
 * gpt-2.5 系质量透传档（image-studio 技能口径）：auto = 不透传（上游默认），
 * 其余五档透传 body.quality（网关按张平价，与价格无关）。
 */
const GPT25_QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const GRSAI_GPT25_TRANSPARENT_BACKGROUND_KEY = 'transparent_background';

/**
 * GRSAI gpt-image-2.5（裸模型）：与 flare/sunburst 同走 /v1/api/generate 同步路径，
 * 13 比例 × 1K/2K/4K 像素表，质量五档透传；上游维护中（2026-09-22 用户确认可用）。
 * 定价不设：裸 2.5 官方点数未知，宁缺毋错。
 */
export const imageModel: ImageModelDefinition = {
  id: GRSAI_GPT_25_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2.5 (GRSAI)',
  providerId: 'grsai',
  description: 'GRSAI gpt-image-2.5 裸模型：13 比例 × 1K/2K/4K，质量五档透传',
  eta: '1min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  extraParamsSchema: [
    {
      key: GRSAI_GPT25_QUALITY_KEY,
      label: '质量档',
      type: 'enum',
      options: GPT25_QUALITY_OPTIONS.map((value) => ({ value, label: value })),
      defaultValue: 'auto',
    },
    {
      key: GRSAI_GPT25_TRANSPARENT_BACKGROUND_KEY,
      label: '透明背景',
      labelKey: 'modelParams.transparentBackground',
      type: 'boolean',
      description: '向 GRSAI 网关透传 background=transparent API 参数，直出真 RGBA 透明底。',
      descriptionKey: 'modelParams.grsaiTransparentBackgroundDesc',
      defaultValue: false,
    },
  ],
  defaultExtraParams: {
    [GRSAI_GPT25_QUALITY_KEY]: 'auto',
    [GRSAI_GPT25_TRANSPARENT_BACKGROUND_KEY]: false,
  },
  aspectRatios: GPT25_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: GPT25_RESOLUTIONS,
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_25_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
