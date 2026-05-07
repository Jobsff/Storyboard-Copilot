import type { ImageModelDefinition } from '../../types';

export const API666_GPT_IMAGE_2_MODEL_ID = '666api/gpt-image-2';

export const imageModel: ImageModelDefinition = {
  id: API666_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2',
  providerId: '666api',
  description: '通过 666API 的 OpenAI 兼容 Images 接口调用 gpt-image-2',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
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
    modeLabel: referenceImageCount > 0 ? '参考图不支持' : '生成模式',
  }),
};

