import type { ImageModelDefinition } from '../../types';

export const AGNES_IMAGE_21_FLASH_MODEL_ID = 'agnes/agnes-image-2.1-flash';

export const imageModel: ImageModelDefinition = {
  id: AGNES_IMAGE_21_FLASH_MODEL_ID,
  mediaType: 'image',
  displayName: 'Agnes Image 2.1 Flash',
  providerId: 'agnes',
  description: '通过 Agnes AI 的 Images 接口调用 Agnes Image 2.1 Flash（支持文生图与图生图）',
  eta: '1min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: [
    { value: '1:1', label: '1:1' },
    { value: '4:3', label: '4:3' },
    { value: '3:4', label: '3:4' },
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '3:2', label: '3:2' },
    { value: '2:3', label: '2:3' },
  ],
  resolutions: [
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: AGNES_IMAGE_21_FLASH_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
