import type { UiAssetCategory, UiAssetPreset } from './types';

export const builtInUiAssetCategories: UiAssetCategory[] = [
  { id: 'button', labelKey: 'uiAsset.category.button' },
  { id: 'progress', labelKey: 'uiAsset.category.progress' },
  { id: 'panel', labelKey: 'uiAsset.category.panel' },
  { id: 'icon', labelKey: 'uiAsset.category.icon' },
  { id: 'badge', labelKey: 'uiAsset.category.badge' },
];

const DEFAULT_UI_STYLE =
  '游戏UI设计资产，移动端手游质感，Q版、描边、厚涂、扁平结合，赛璐璐阴影，高级、干净、可读性强';

const DEFAULT_NEGATIVE =
  'text, numbers, logo, watermark, signature, QR code, realistic photo, background scene, character, messy details, low quality, blurry';

export const builtInUiAssetPresets: UiAssetPreset[] = [
  {
    id: 'button_small_128x64',
    labelKey: 'uiAsset.preset.button.small_128x64',
    categoryId: 'button',
    assetType: 'button',
    targetSize: { width: 128, height: 64 },
    modelConfig: { aspectRatio: '21:9', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 128, height: 64 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['normal', 'pressed', 'disabled'],
    promptTemplate:
      '生成一张游戏UI按钮资源图。主题：{{subject}}。风格：{{style}}。要求：横向圆角矩形按钮，左右端有装饰，中心区域留空用于放文字，但画面中不要出现任何文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'button_normal_256x96',
    labelKey: 'uiAsset.preset.button.normal_256x96',
    categoryId: 'button',
    assetType: 'button',
    targetSize: { width: 256, height: 96 },
    modelConfig: { aspectRatio: '21:9', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 256, height: 96 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['normal', 'pressed', 'disabled'],
    promptTemplate:
      '生成一张游戏UI按钮资源图。主题：{{subject}}。风格：{{style}}。要求：横向按钮，左右端对称装饰，中心区域留空用于放文字，但画面中不要出现任何文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'button_long_512x128',
    labelKey: 'uiAsset.preset.button.long_512x128',
    categoryId: 'button',
    assetType: 'button',
    targetSize: { width: 512, height: 128 },
    modelConfig: { aspectRatio: '21:9', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 512, height: 128 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['normal', 'pressed', 'disabled'],
    promptTemplate:
      '生成一张横向长按钮UI资源图。主题：{{subject}}。风格：{{style}}。要求：左右端有装饰和端帽，中间留出大面积可放文字区域，但画面中不要出现任何文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'progress_short_256x48',
    labelKey: 'uiAsset.preset.progress.short_256x48',
    categoryId: 'progress',
    assetType: 'progress_bar',
    targetSize: { width: 256, height: 48 },
    modelConfig: { aspectRatio: '21:9', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 256, height: 48 },
      transparentBackground: true,
      nineSlice: { enabled: true, left: 24, right: 24, top: 12, bottom: 12 },
      exportScales: [1, 2],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['track', 'fill', 'frame'],
    promptTemplate:
      '生成一张游戏UI横向进度条资源图。主题：{{subject}}。风格：{{style}}。要求：包含清晰的底槽（track）和填充区域（fill），左右端有装饰端帽，中间填充区域干净可拉伸。不要文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产，适合切片。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'progress_long_1024x96',
    labelKey: 'uiAsset.preset.progress.long_1024x96',
    categoryId: 'progress',
    assetType: 'progress_bar',
    targetSize: { width: 1024, height: 96 },
    modelConfig: { aspectRatio: '21:9', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 1024, height: 96 },
      transparentBackground: true,
      nineSlice: { enabled: true, left: 64, right: 64, top: 24, bottom: 24 },
      exportScales: [1, 2],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['track', 'fill', 'frame'],
    promptTemplate:
      '生成一张游戏UI长进度条资源图。主题：{{subject}}。风格：{{style}}。要求：清晰的底槽（track）+ 可填充区域（fill）+ 外框（frame），左右端装饰明显，中间区域可拉伸。不要文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产，适合九宫格/切片。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'panel_popup_1024x768',
    labelKey: 'uiAsset.preset.panel.popup_1024x768',
    categoryId: 'panel',
    assetType: 'panel',
    targetSize: { width: 1024, height: 768 },
    modelConfig: { aspectRatio: '4:3', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 1024, height: 768 },
      transparentBackground: true,
      nineSlice: { enabled: true, left: 96, right: 96, top: 96, bottom: 96 },
      exportScales: [1, 2],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张游戏UI弹窗面板框资源图。主题：{{subject}}。风格：{{style}}。要求：四角有装饰，边缘可重复拉伸，中心区域安静留白用于放内容，画面中不要出现任何文字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI框资产，适合九宫格。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'panel_9slice_1024x1024',
    labelKey: 'uiAsset.preset.panel.nineslice_1024x1024',
    categoryId: 'panel',
    assetType: 'panel',
    targetSize: { width: 1024, height: 1024 },
    modelConfig: { aspectRatio: '1:1', requestSize: '1K' },
    postprocess: {
      crop: 'none',
      resize: { width: 1024, height: 1024 },
      transparentBackground: true,
      nineSlice: { enabled: true, left: 96, right: 96, top: 96, bottom: 96 },
      exportScales: [1, 2],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张方形九宫格游戏UI面板框资源图。主题：{{subject}}。风格：{{style}}。要求：四角装饰明确，边缘条纹可重复，中心区域安静留白，画面中不要出现任何文字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI框资产，适合九宫格切片。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'icon_skill_512x512',
    labelKey: 'uiAsset.preset.icon.skill_512x512',
    categoryId: 'icon',
    assetType: 'icon',
    targetSize: { width: 512, height: 512 },
    modelConfig: { aspectRatio: '1:1', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 512, height: 512 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张游戏UI技能图标资源图。主题：{{subject}}。风格：{{style}}。要求：中心构图，轮廓清晰，细节集中但不杂乱，高对比易识别。不要文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'icon_item_512x512',
    labelKey: 'uiAsset.preset.icon.item_512x512',
    categoryId: 'icon',
    assetType: 'icon',
    targetSize: { width: 512, height: 512 },
    modelConfig: { aspectRatio: '1:1', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 512, height: 512 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张游戏UI道具图标资源图。主题：{{subject}}。风格：{{style}}。要求：中心构图，轮廓清晰，材质表现明确（高光/反光点），细节集中但不杂乱，高对比易识别。不要文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'icon_slot_256x256',
    labelKey: 'uiAsset.preset.icon.slot_256x256',
    categoryId: 'icon',
    assetType: 'slot',
    targetSize: { width: 256, height: 256 },
    modelConfig: { aspectRatio: '1:1', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 256, height: 256 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['frame'],
    promptTemplate:
      '生成一张游戏UI槽位/背包格子框资源图。主题：{{subject}}。风格：{{style}}。要求：方形外框，四角有装饰，边缘厚度统一，中心区域留空用于放图标，画面中不要出现任何文字/数字/Logo。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'badge_new_256x96',
    labelKey: 'uiAsset.preset.badge.new_256x96',
    categoryId: 'badge',
    assetType: 'badge',
    targetSize: { width: 256, height: 96 },
    modelConfig: { aspectRatio: '21:9', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 256, height: 96 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张游戏UI标签/徽章底图资源。主题：{{subject}}。风格：{{style}}。要求：像“NEW/HOT”这种标签底图，但画面中不要出现任何文字，只生成底图形状和装饰。轮廓清晰。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'badge_sale_384x128',
    labelKey: 'uiAsset.preset.badge.sale_384x128',
    categoryId: 'badge',
    assetType: 'badge',
    targetSize: { width: 384, height: 128 },
    modelConfig: { aspectRatio: '4:1', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 384, height: 128 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张游戏UI折扣/促销标签底图资源。主题：{{subject}}。风格：{{style}}。要求：横向长条标签底图，有价格牌/折扣牌的感觉，但画面中不要出现任何文字/数字/Logo。轮廓清晰。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
  {
    id: 'badge_ssr_512x512',
    labelKey: 'uiAsset.preset.badge.ssr_512x512',
    categoryId: 'badge',
    assetType: 'badge',
    targetSize: { width: 512, height: 512 },
    modelConfig: { aspectRatio: '1:1', requestSize: '1K' },
    postprocess: {
      crop: 'center',
      resize: { width: 512, height: 512 },
      transparentBackground: true,
      exportScales: [1, 2, 3],
    },
    defaultStyle: DEFAULT_UI_STYLE,
    variants: ['default'],
    promptTemplate:
      '生成一张游戏UI稀有度徽章底图资源。主题：{{subject}}。风格：{{style}}。要求：像“SSR/UR”这种徽章底图，但画面中不要出现任何文字，只生成徽章形状、光效、装饰。轮廓清晰，高对比易识别。输出带有 Alpha 通道的 PNG，透明背景（alpha=0），单个独立UI资产。',
    negativePrompt: DEFAULT_NEGATIVE,
  },
];

export function getBuiltInUiAssetPreset(presetId: string): UiAssetPreset | null {
  return builtInUiAssetPresets.find((preset) => preset.id === presetId) ?? null;
}

export function buildUiAssetPrompt(preset: UiAssetPreset, subject: string): string {
  const trimmedSubject = subject.trim();
  const style = (preset.defaultStyle ?? '').trim();
  return preset.promptTemplate
    .split('{{subject}}')
    .join(trimmedSubject)
    .split('{{style}}')
    .join(style);
}
