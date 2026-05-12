export type StyleCategoryId =
  | 'uiIcon'
  | 'uiPanel'
  | 'avatar'
  | 'character'
  | 'monster'
  | 'prop'
  | 'scene';

export interface BuiltInStylePreset {
  id: string;
  version: number;
  categoryId: StyleCategoryId;
  labelKey: string;
  template: string;
}

export interface BuiltInStyleCategory {
  id: StyleCategoryId;
  labelKey: string;
}

export const builtInStyleCategories: BuiltInStyleCategory[] = [
  { id: 'uiIcon', labelKey: 'style.category.uiIcon' },
  { id: 'uiPanel', labelKey: 'style.category.uiPanel' },
  { id: 'avatar', labelKey: 'style.category.avatar' },
  { id: 'character', labelKey: 'style.category.character' },
  { id: 'monster', labelKey: 'style.category.monster' },
  { id: 'prop', labelKey: 'style.category.prop' },
  { id: 'scene', labelKey: 'style.category.scene' },
];

const CUTOUT_BACKGROUND_HINT = '主体边缘清晰，中心构图，留白干净';

export const builtInStylePresets: BuiltInStylePreset[] = [
  {
    id: 'uiIcon.chibiOutlineThickPaint',
    version: 1,
    categoryId: 'uiIcon',
    labelKey: 'style.item.uiIcon.chibiOutlineThickPaint',
    template:
      `{subject}，Q版，粗描边清晰，厚涂质感，形体简化但特征夸张，中心构图，轮廓强对比，少量高光点缀，游戏UI技能图标风格，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'uiIcon.flatSymbolic',
    version: 1,
    categoryId: 'uiIcon',
    labelKey: 'style.item.uiIcon.flatSymbolic',
    template:
      `{subject}，扁平化图标，2-3层色块分层，少量层次变化，轮廓清晰，细节克制，图形符号化，游戏UI图标，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'uiPanel.flatRoundedOutline',
    version: 1,
    categoryId: 'uiPanel',
    labelKey: 'style.item.uiPanel.flatRoundedOutline',
    template:
      `{subject}，UI按钮风格，圆角矩形，扁平化，清晰描边，层级分明（底色+描边+高光+暗部），适合点击反馈的结构，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'uiPanel.thickPaintPanelLightDecor',
    version: 1,
    categoryId: 'uiPanel',
    labelKey: 'style.item.uiPanel.thickPaintPanelLightDecor',
    template:
      `{subject}，UI面板背板，厚涂质感但保持平整可读，边缘描边，角落少量装饰元素，整体留白充足，适配文本与图标摆放，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'avatar.chibiBigHead',
    version: 1,
    categoryId: 'avatar',
    labelKey: 'style.item.avatar.chibiBigHead',
    template:
      `{subject}，Q版大头比例，表情夸张可爱，五官清晰，粗描边，厚涂上色，光影简化，头像构图居中，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'avatar.animeCelClean',
    version: 1,
    categoryId: 'avatar',
    labelKey: 'style.item.avatar.animeCelClean',
    template:
      `{subject}，二次元赛璐璐头像，线条干净，硬边明暗分区，眼神有高光，配色统一，轮廓清晰，居中构图，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'character.chibiThickPaint',
    version: 1,
    categoryId: 'character',
    labelKey: 'style.item.character.chibiThickPaint',
    template:
      `{subject}，Q版角色立绘，厚涂质感，粗描边，形体简化，服装/武器特征突出，适合游戏内展示，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'character.celActionPose',
    version: 1,
    categoryId: 'character',
    labelKey: 'style.item.character.celActionPose',
    template:
      `{subject}，赛璐璐上色角色立绘，动作姿态明确，硬边明暗分区，高光集中，线条清晰，细节有重点但不杂乱，适合塔防/割草风格，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'monster.chibiStrongSilhouette',
    version: 1,
    categoryId: 'monster',
    labelKey: 'style.item.monster.chibiStrongSilhouette',
    template:
      `{subject}，Q版怪物设计，轮廓夸张，特征集中（角/牙/眼/背部结构），粗描边，厚涂上色，材质简化，适合游戏怪物头像或立绘，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'monster.celThreatClean',
    version: 1,
    categoryId: 'monster',
    labelKey: 'style.item.monster.celThreatClean',
    template:
      `{subject}，赛璐璐上色怪物，硬边明暗分区，结构清晰，威胁感强但细节可控，轮廓明确，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'prop.thickPaintMaterialClear',
    version: 1,
    categoryId: 'prop',
    labelKey: 'style.item.prop.thickPaintMaterialClear',
    template:
      `{subject}，游戏道具图，厚涂质感，粗描边，材质表现明确（高光/反光点），轮廓清晰，细节集中在关键部位，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'prop.flatSymbolic',
    version: 1,
    categoryId: 'prop',
    labelKey: 'style.item.prop.flatSymbolic',
    template:
      `{subject}，扁平化道具图标，形状符号化，色块分层，轮廓清晰，细节克制，${CUTOUT_BACKGROUND_HINT}`,
  },
  {
    id: 'scene.chibiIsometric',
    version: 1,
    categoryId: 'scene',
    labelKey: 'style.item.scene.chibiIsometric',
    template:
      '{subject}，Q版游戏场景，俯视或等距视角，形体简化，粗描边，厚涂上色，色彩统一，地形与关键物件轮廓清晰，细节不过载',
  },
  {
    id: 'scene.flatModular',
    version: 1,
    categoryId: 'scene',
    labelKey: 'style.item.scene.flatModular',
    template:
      '{subject}，扁平化场景插画，模块化块面，层级分明，低细节噪点，配色统一，适合做关卡底图',
  },
];

export function getBuiltInStylePreset(styleId: string): BuiltInStylePreset | null {
  return builtInStylePresets.find((preset) => preset.id === styleId) ?? null;
}

export function buildStylePrompt(preset: BuiltInStylePreset, subject: string): string {
  const trimmedSubject = subject.trim();
  return preset.template.split('{subject}').join(trimmedSubject);
}
