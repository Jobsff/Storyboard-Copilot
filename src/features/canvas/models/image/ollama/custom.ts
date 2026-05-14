import type { ImageModelDefinition } from '../../types';

export const imageModel: ImageModelDefinition = {
  id: 'ollama/custom',
  mediaType: 'image',
  displayName: 'Ollama 自定义模型',
  providerId: 'ollama',
  description: '通过 Ollama 本地部署的自定义模型生成',
  eta: '30s',
  expectedDurationMs: 30000,
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
    requestModel: 'ollama/custom',
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
