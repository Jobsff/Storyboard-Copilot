import { applyTransparentBackgroundHint } from '@/features/canvas/application/transparentBackground';

export type GameAssetCategoryId =
  | 'ui'
  | 'gameplay'
  | 'vfx'
  | 'marketing'
  | 'tech'
  | 'other';

export interface BuiltInGameAssetCategory {
  id: GameAssetCategoryId;
  labelKey: string;
}

export interface BuiltInGameAssetTemplate {
  id: string;
  categoryId: GameAssetCategoryId;
  groupLabelKey: string;
  labelKey: string;
  template: string;
  defaultTransparentBackground: boolean;
}

const COMPANY_STYLE_PREFIX = '小游戏素材，卡通Q版画风，暗黑卡通手绘风格，中式微恐元素';
const NO_TEXT_CONSTRAINT = '画面中不要出现任何文字内容。';

export const builtInGameAssetCategories: BuiltInGameAssetCategory[] = [
  { id: 'ui', labelKey: 'gameAsset.category.ui' },
  { id: 'gameplay', labelKey: 'gameAsset.category.gameplay' },
  { id: 'vfx', labelKey: 'gameAsset.category.vfx' },
  { id: 'marketing', labelKey: 'gameAsset.category.marketing' },
  { id: 'tech', labelKey: 'gameAsset.category.tech' },
  { id: 'other', labelKey: 'gameAsset.category.other' },
];

export const builtInGameAssetTemplates: BuiltInGameAssetTemplate[] = [
  {
    id: 'ui.basic_components',
    categoryId: 'ui',
    groupLabelKey: 'gameAsset.group.ui.basic',
    labelKey: 'gameAsset.item.ui.basic_components',
    defaultTransparentBackground: true,
    template: `基础UI组件一套：
- 按钮 Button（普通/悬停/按下/禁用四态）
- 输入框 Input Field
- 滑动条 Slider
- 复选框 Checkbox
- 单选框 Radio Button
- 下拉框 Dropdown
- 进度条 Progress Bar
- 开关 Toggle
- 标签页 Tab
- 滚动条 Scrollbar
- 弹窗 Dialog / Popup
- 悬停提示 Tooltip
- 通知 Notification
- 轮盘菜单 Radial Menu
- 计时器 Timer
要求：统一风格，适配手游UI，按网格排布，一次出一整套。`,
  },
  {
    id: 'ui.screen_templates',
    categoryId: 'ui',
    groupLabelKey: 'gameAsset.group.ui.screens',
    labelKey: 'gameAsset.item.ui.screen_templates',
    defaultTransparentBackground: true,
    template: `功能界面模板一套：
- 主菜单 Main Menu
- 暂停菜单 Pause Menu
- 设置 Settings
- 背包 Inventory
- 角色面板 Character Panel
- 技能面板 Skill Tree
- 商店 Shop
- 地图 Map
- 任务 Quest Log
- 对话框 Dialogue Box
- 合成 Crafting
- 排行榜 Leaderboard
- 成就 Achievements
- 聊天 Chat
- 好友 Friends List
- 公会 Guild
- 邮箱 Mail
- 拍卖行 Auction House
- 组队 Party
要求：只出UI框架与可放置区域结构示意，适合后续填充。`,
  },
  {
    id: 'ui.hud_components',
    categoryId: 'ui',
    groupLabelKey: 'gameAsset.group.ui.hud',
    labelKey: 'gameAsset.item.ui.hud_components',
    defaultTransparentBackground: true,
    template: `HUD组件一套：
- HP Bar
- MP Bar
- Stamina Bar
- EXP Bar
- 小地图容器 Minimap
- 技能栏 Skill Bar
- 物品栏 Item Bar
- 准星 Crosshair
- 伤害数字样式 Damage Number（不含数字）
- 状态图标样式 Status Icon
- 任务追踪 Quest Tracker
- 连击计数 Combo Counter（不含数字）
- 信号标记 Ping Marker
要求：只出框架/容器/底板/图标底座，可读性强，风格统一。`,
  },
  {
    id: 'ui.decorations',
    categoryId: 'ui',
    groupLabelKey: 'gameAsset.group.ui.decor',
    labelKey: 'gameAsset.item.ui.decorations',
    defaultTransparentBackground: true,
    template: `装饰元素一套：
- 边框 Border / Frame
- 面板背景底纹 Background
- 图标底板 Icon Background
- 分割线 Divider
- 角落装饰 Corner Decoration
- 指示箭头 Arrow
- 稀有度边框 Rarity Border（普通/稀有/史诗/传说）
要求：边角结构清晰，适合九宫格切片与复用。`,
  },

  {
    id: 'gameplay.character_system',
    categoryId: 'gameplay',
    groupLabelKey: 'gameAsset.group.gameplay.character',
    labelKey: 'gameAsset.item.gameplay.character_system',
    defaultTransparentBackground: false,
    template: `角色系统素材一套：
- 角色立绘 Character Portrait
- 角色模型 Character Model（2D精灵风）
- 角色动画 Character Animation（待机/走路/攻击等风格示意）
- 角色拆分 Character Parts（头发/衣服/武器等可换装部件示意）
- 表情 Facial Expression（喜怒哀乐惊）
- 皮肤/配色 Skin / Color Variant
要求：偏萌系但带轻微怪诞细节，风格统一。`,
  },
  {
    id: 'gameplay.monsters_npcs',
    categoryId: 'gameplay',
    groupLabelKey: 'gameAsset.group.gameplay.monster',
    labelKey: 'gameAsset.item.gameplay.monsters_npcs',
    defaultTransparentBackground: false,
    template: `怪物与NPC素材一套：
- 怪物模型 Monster Model
- 怪物动画 Monster Animation（巡逻/追击/攻击/死亡示意）
- 怪物图标 Monster Icon
- Boss 模型 Boss Model
- Boss 阶段变化 Boss Phase
- NPC 模型 NPC Model
- NPC 头像 NPC Portrait
- 名称框样式 Nameplate（不含文字）
要求：轮廓清晰，辨识度高。`,
  },
  {
    id: 'gameplay.scenes',
    categoryId: 'gameplay',
    groupLabelKey: 'gameAsset.group.gameplay.scene',
    labelKey: 'gameAsset.item.gameplay.scenes',
    defaultTransparentBackground: false,
    template: `场景资源一套：
- 地形贴图 Terrain Texture（草地/泥土/石头/水面瓦片）
- 瓦片地图 Tilemap
- 多层背景 Background / Parallax
- 前景遮挡 Foreground
- 建筑 Building Model（房屋/城墙/塔楼）
- 室内场景 Interior Scene（地牢/洞穴）
- 环境物体 Environment Props（树木/石头/草丛/花）
- 水面 Water Surface
- 天空 Skybox
- 传送点 Portal / Waypoint
- 场景特效 Scene VFX（雾气/光线/落叶/雨雪）
要求：氛围统一，整体偏暗，但主体可读。`,
  },
  {
    id: 'gameplay.items_skills_icons',
    categoryId: 'gameplay',
    groupLabelKey: 'gameAsset.group.gameplay.icons',
    labelKey: 'gameAsset.item.gameplay.items_skills_icons',
    defaultTransparentBackground: true,
    template: `物品与技能资源图标一套：
- 物品图标 Item Icon
- 消耗品 Consumable Icon
- 材料 Material Icon
- 任务物品 Quest Item
- 宝箱 Chest
- 掉落物 Drop Item
- 技能图标 Skill Icon
- Buff / Debuff 图标
- 范围指示器 Area Indicator
- 投射物 Projectile（图标化）
要求：中心构图，高对比易识别，细节集中但不杂乱。`,
  },

  {
    id: 'vfx.particle_library',
    categoryId: 'vfx',
    groupLabelKey: 'gameAsset.group.vfx.particles',
    labelKey: 'gameAsset.item.vfx.particle_library',
    defaultTransparentBackground: false,
    template: `粒子特效库一套：
- 刀光 Slash Effect
- 爆炸 Explosion
- 火焰 Fire
- 冰霜 Ice / Frost
- 雷电 Lightning
- 毒素 Poison
- 治疗 Heal
- 升级特效 Level Up VFX
- 传送特效 Teleport VFX
- 死亡特效 Death VFX
- 环境粒子 Ambient Particle
- 天气 Weather（雨/雪/雾/沙尘暴）
- 水花 Splash
- 脚步尘土 Dust Kick
要求：效果清晰但不过度写实，风格统一。`,
  },
  {
    id: 'vfx.animation_sets',
    categoryId: 'vfx',
    groupLabelKey: 'gameAsset.group.vfx.anim',
    labelKey: 'gameAsset.item.vfx.animation_sets',
    defaultTransparentBackground: false,
    template: `全类型动画资源规划：
- 角色动画集 Character Animation Set
- 怪物动画集 Monster Animation Set
- NPC 动画集 NPC Animation Set
- 物品动画 Item Animation
- 场景动画 Scene Animation
- UI 动画 UI Animation
- 过场动画 Cutscene Animation
- Logo 动画 Logo Animation
- 转场 Transition
- 相机动画 Camera Animation
要求：只做风格与结构示意。`,
  },

  {
    id: 'marketing.promo_assets',
    categoryId: 'marketing',
    groupLabelKey: 'gameAsset.group.marketing',
    labelKey: 'gameAsset.item.marketing.promo_assets',
    defaultTransparentBackground: false,
    template: `产品宣传素材一套：
- 应用图标 App Icon
- 宣传海报 Promo Art
- 截图风格示意 Screenshot
- 预告片封面 Trailer
- Logo 造型示意 Game Logo（不含文字）
- 启动图 Splash Screen
- 加载图 Loading Screen
- 成就图标 Achievement Icon
- 商店 Banner Store Banner
要求：商业化统一，画面干净。`,
  },

  {
    id: 'tech.engine_optimization',
    categoryId: 'tech',
    groupLabelKey: 'gameAsset.group.tech.engine',
    labelKey: 'gameAsset.item.tech.engine_optimization',
    defaultTransparentBackground: false,
    template: `引擎资源优化规划：
- Shader（水面/火焰/卡通渲染）
- Lightmap
- Normal Map
- Occlusion Map
- Collision Map
- NavMesh
- Sprite Atlas / Texture Atlas
- 9-Slice Sprite
要求：只做结构示意。`,
  },
  {
    id: 'tech.multi_platform',
    categoryId: 'tech',
    groupLabelKey: 'gameAsset.group.tech.platform',
    labelKey: 'gameAsset.item.tech.multi_platform',
    defaultTransparentBackground: false,
    template: `多平台适配规划：
- 多分辨率适配 Resolution Adaptation
- 横竖屏布局 Landscape / Portrait Layout
- 手柄图标 Controller Icons（Xbox/PS/Switch）
- 键鼠图标 Keyboard / Mouse Icons
- 触控图标 Touch Icons
- 安全区域 Safe Area
要求：只做图标/框架示意。`,
  },

  {
    id: 'other.misc',
    categoryId: 'other',
    groupLabelKey: 'gameAsset.group.other',
    labelKey: 'gameAsset.item.other.misc',
    defaultTransparentBackground: false,
    template: `其他资源风格示意：
- 全键盘快捷键提示
- 鼠标提示
- 游戏内提示
要求：作为UI/引导系统的视觉参考。`,
  },
];

export function getBuiltInGameAssetTemplate(templateId: string): BuiltInGameAssetTemplate | null {
  return builtInGameAssetTemplates.find((preset) => preset.id === templateId) ?? null;
}

export function buildGameAssetPrompt(template: BuiltInGameAssetTemplate): string {
  const baseParts = [COMPANY_STYLE_PREFIX, template.template, NO_TEXT_CONSTRAINT].filter(Boolean);
  const basePrompt = baseParts.join('\n');
  return template.defaultTransparentBackground ? applyTransparentBackgroundHint(basePrompt) : basePrompt;
}
