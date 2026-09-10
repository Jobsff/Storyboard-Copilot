import type { ImageModelDefinition, ResolutionOption } from '../../types';

/**
 * aifast 静态模型工厂（批次9）。aifast 是 NEWAPI 兼容站，Rust 侧复用 Api666Provider
 * （provider_id ≠ "666api" → gemini 系走 /v1/chat/completions，gpt-image-2 走 images API），
 * 协议口径与 juyouapi/666api 先例一致。定价不设（宁缺毋错）。
 */

const GEMINI_ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
];

const GEMINI_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
];

export function createAifastGeminiModel(
  modelName: string,
  displayName: string,
  description: string
): ImageModelDefinition {
  const id = `aifast/${modelName}`;
  return {
    id,
    mediaType: 'image',
    displayName,
    providerId: 'aifast',
    description,
    eta: '1min',
    expectedDurationMs: 80000,
    defaultAspectRatio: '1:1',
    defaultResolution: '1K',
    extraParamsSchema: [],
    defaultExtraParams: {},
    aspectRatios: GEMINI_ASPECT_RATIOS,
    resolutions: GEMINI_RESOLUTIONS,
    resolveRequest: ({ referenceImageCount }) => ({
      requestModel: id,
      modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
    }),
  };
}
