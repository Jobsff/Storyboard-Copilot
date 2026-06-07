import type { ImageModelDefinition } from '../../types';

export const JUYOUAPI_GPT_IMAGE_2_MODEL_ID = 'juyouapi/gpt-image-2';

export const imageModel: ImageModelDefinition = {
  id: JUYOUAPI_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2 (巨游)',
  providerId: 'juyouapi',
  description: '通过巨游API 的 OpenAI 原生 Images 接口调用 gpt-image-2（支持参考图编辑）',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  extraParamsSchema: [
    {
      key: 'transparent_background',
      label: '透明背景',
      labelKey: 'modelParams.transparentBackground',
      type: 'boolean',
      description: '通过提示词让模型尽量输出透明背景素材；不向上游发送透明背景 API 参数。',
      descriptionKey: 'modelParams.transparentBackgroundDesc',
      defaultValue: false,
    },
  ],
  defaultExtraParams: {
    transparent_background: false,
  },
  aspectRatios: [
    { value: '1:1', label: '1:1' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
    { value: '2:3', label: '2:3' },
    { value: '3:2', label: '3:2' },
    { value: '4:5', label: '4:5' },
    { value: '5:4', label: '5:4' },
  ],
  resolutions: [
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: JUYOUAPI_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
