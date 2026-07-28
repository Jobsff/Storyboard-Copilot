# AI 序列帧工作流

本文档说明 AI 序列帧从生图到动画帧、游戏帧动画包、再到 Spine 导出的当前实现约束。

## 1. 工作流

1. AI 序列帧节点只负责生成序列帧网格图。
2. 用户审核网格图，确认可用后选中图片节点。
3. 顶部工具条点击「切割动画」，打开切割配置。
4. 切割配置支持行列数、分割线、透明背景处理、角色校准、FPS 和抽帧。
5. 应用后生成 `storyboardSplit` 动画帧节点。
6. 动画帧节点继续负责预览、游戏帧动画包导出与 Spine 三件套导出。
7. 游戏帧动画包优先输出 `frames/`、`*_sheet.png`、`frames.json`；Spine 输出 `.json + .atlas + .png` 并创建预览节点。

## 2. 网格尺寸

AI 序列帧节点支持：

- `2x2`：4 帧，适合简单待机、小动作。
- `3x3`：9 帧，适合走路、跑步、攻击等常规循环。
- `4x4`：16 帧，适合更细腻的动作或复杂特效。

生成后的网格图会写入 storyboard metadata：

- `gridRows`
- `gridCols`
- `frameNotes`

切割弹窗会优先读取这些 metadata 初始化行列数。

## 3. 背景与抠图策略

AI 序列帧提示词默认要求模型生成纯色抠图背景，而不是依赖真实 Alpha 透明背景。当前默认背景是纯洋红，原因是它更容易与常见角色服装、皮肤和环境色区分。

默认背景约束：

- 纯亮洋红 `#FF00FF`
- 每个格子背景必须是完全统一纯色
- 禁止渐变、纹理、阴影、地面、棋盘格、白底或灰底
- 禁止角色、服装、武器、特效、描边、高光使用洋红、粉色、紫色或紫罗兰色

切割动画的透明背景处理包含：

- `自动`：无真实 Alpha 时自动抠图；即使已有 Alpha，只要检测到残留 chroma 背景也会继续处理。
- `不处理`：保留原背景。
- `强制抠图`：不管是否已有 Alpha，尝试处理 chroma key / 白底。

当前后处理链路：

- 高饱和 chroma 背景走 soft matte + despill，支持洋红、绿色和蓝色。
- 边缘背景色只有在确认为 chroma key 时才使用；否则会回退到整帧 dominant chroma 检测。
- 白底/浅色底走保守背景清理。
- 先移除背景，再清理每帧窄边缘残留。
- 角色边缘会做羽化和去色边，减少毛边。
- 角色居中与基线校准用于减少动画漂移。

## 4. 抽帧

切割动画弹窗会按网格显示帧编号。点亮的格子会进入动画，未选中的格子会被丢弃。

规则：

- UI 显示从 1 开始的帧编号。
- 内部用 0 基索引保存 `selectedFrameIndices`。
- 输出动画帧顺序按原始网格从左到右、从上到下排序。
- 抽帧后结果节点会按实际帧数紧凑展示，不保留空格。

## 5. 导出格式

### 5.1 游戏帧动画包

这是面向游戏开发的优先导出格式。

输出内容：

- `frames/<animation>_###.png`：逐帧透明 PNG。
- `<package>_sheet.png`：横向排列的 sprite sheet。
- `frames.json`：帧 metadata，格式标识为 `storyboard-copilot.sprite-pack.v1`。

`frames.json` 记录动画名、FPS、循环设置、pivot、每帧文件路径、sheet rect 和帧备注，便于后续导入游戏引擎或自定义工具链。

### 5.2 Spine

Spine 导出用于兼容需要 Spine 资产包的工具链。当前导出是 frame-by-frame attachment animation，不是骨骼 rig 动画。

输出内容：

- `.json`
- `.atlas`
- `.png`

导出完成后，前端会创建/验证一个 Spine 预览节点，用同一套 `.json + .atlas + .png` 文件包回读播放。

## 6. 关键代码位置

- 节点 UI：`src/features/canvas/nodes/SequenceFrameGenNode.tsx`
- 工具注册：`src/features/canvas/tools/builtInTools.ts`
- 切割弹窗：`src/features/canvas/ui/tool-editors/SplitStoryboardToolEditor.tsx`
- 工具执行：`src/features/canvas/application/toolProcessor.ts`
- 工具入口：`src/features/canvas/ui/NodeActionToolbar.tsx`
- 工具弹窗执行：`src/features/canvas/ui/NodeToolDialog.tsx`
- 动画帧导出 UI：`src/features/canvas/nodes/StoryboardNode.tsx`
- Tauri 导出命令：`src/commands/assets.ts`、`src-tauri/src/commands/assets.rs`

## 7. 验证建议

常规检查：

```bash
npx tsc --noEmit
npm run build
cd src-tauri && cargo check
```

手测主路径：

1. 新建 AI 序列帧节点。
2. 分别测试 `2x2`、`3x3`、`4x4`。
3. 生成网格图后选中图片节点。
4. 点击顶部「切割动画」。
5. 测试 `自动` 与 `强制抠图`。
6. 取消部分帧，确认结果节点只保留选中帧。
7. 播放预览，确认角色漂移和背景残留可接受。
8. 导出游戏帧动画包，确认 `frames/`、`*_sheet.png`、`frames.json` 都落盘且 metadata rect 正确。
9. 导出 Spine，确认 `.json + .atlas + .png` 可重新导入，并自动创建/播放预览节点。
