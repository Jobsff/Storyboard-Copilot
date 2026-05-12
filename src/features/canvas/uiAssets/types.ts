export type UiAssetCategoryId = 'button' | 'progress' | 'panel' | 'icon' | 'badge';

export type UiAssetCropMode = 'center' | 'smart' | 'none';

export interface UiAssetNineSliceConfig {
  enabled: boolean;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface UiAssetPostprocessConfig {
  crop?: UiAssetCropMode;
  resize: { width: number; height: number };
  transparentBackground: boolean;
  nineSlice?: UiAssetNineSliceConfig;
  exportScales?: number[];
}

export interface UiAssetModelConfig {
  modelId?: string;
  aspectRatio: string;
  requestSize?: string;
}

export interface UiAssetPreset {
  id: string;
  labelKey: string;
  categoryId: UiAssetCategoryId;
  assetType: string;
  targetSize: { width: number; height: number };
  modelConfig: UiAssetModelConfig;
  postprocess: UiAssetPostprocessConfig;
  promptTemplate: string;
  negativePrompt: string;
  defaultStyle?: string;
  variants?: string[];
}

export interface UiAssetCategory {
  id: UiAssetCategoryId;
  labelKey: string;
}

export interface UiAssetNodeMeta {
  assetType: string;
  presetId: string;
  targetSize: { width: number; height: number };
  modelAspectRatio: string;
  requestSize?: string;
  postprocess: UiAssetPostprocessConfig;
  prompt: string;
  negativePrompt: string;
  variants?: string[];
  exportName?: string;
}

