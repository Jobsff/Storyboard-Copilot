import type { ImageModelDefinition } from '../../types';

export const API666_GPT_IMAGE_2_MODEL_ID = '666api/gpt-image-2';
export const API666_GPT_IMAGE_2_TRANSPARENT_BACKGROUND_KEY = 'transparent_background';

export const imageModel: ImageModelDefinition = {
  id: API666_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2',
  providerId: '666api',
  description: '通过 666API 的 OpenAI 原生 Images 接口调用 gpt-image-2（支持参考图编辑）',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  extraParamsSchema: [
    {
      key: API666_GPT_IMAGE_2_TRANSPARENT_BACKGROUND_KEY,
      label: '透明背景',
      labelKey: 'modelParams.transparentBackground',
      type: 'boolean',
      description: '让模型尽量输出带有 Alpha 通道的 PNG（alpha=0 背景），适合做抠图素材。',
      descriptionKey: 'modelParams.transparentBackgroundDesc',
      defaultValue: false,
    },
  ],
  defaultExtraParams: {
    [API666_GPT_IMAGE_2_TRANSPARENT_BACKGROUND_KEY]: false,
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
    requestModel: API666_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
