import type { ImageModelDefinition } from '../../types';

export const imageModel: ImageModelDefinition = {
  id: 'juyouapi/gemini-3.1-flash-image',
  mediaType: 'image',
  displayName: 'Gemini 3.1 Flash Image (巨游)',
  providerId: 'juyouapi',
  description: '通过巨游API 调用 Gemini 3.1 Flash 原生图片生成',
  eta: '20s',
  expectedDurationMs: 20000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  extraParamsSchema: [],
  defaultExtraParams: {},
  aspectRatios: [
    { value: '1:1', label: '1:1' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
  ],
  resolutions: [
    { value: '1K', label: '1K' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: 'juyouapi/gemini-3.1-flash-image',
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
