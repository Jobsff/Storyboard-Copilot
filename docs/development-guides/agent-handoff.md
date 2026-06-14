# AI 开发工具接手指南

本文档用于 Claude、OpenCode 或其他 AI 开发工具快速接手 Storyboard Copilot。目标是先建立正确上下文，再动代码。

## 1. 先读哪些文件

按顺序阅读：

1. `README.md`：了解产品能力、运行命令和文档入口。
2. `AGENTS.md`：了解项目架构边界、验证标准和开发红线。
3. `CLAUDE.md`：Claude Code 可直接读取，内容与 `AGENTS.md` 保持一致。
4. `docs/development-guides/project-development-setup.md`：本地开发环境与常见问题。
5. `docs/development-guides/provider-and-model-extension.md`：新增供应商或模型时阅读。
6. `docs/development-guides/sequence-frame-workflow.md`：维护 AI 序列帧、切割动画、Spine 导出时阅读。
7. `docs/settings/provider-guide.md`：维护设置页供应商说明时阅读。

## 2. 当前稳定基线

- 当前版本：`0.2.5`。
- 主分支：`main`。
- 发布流程：准备 `docs/releases/vx.y.z.md` 后执行 `npm run release -- patch --notes-file docs/releases/vx.y.z.md`。
- Windows 安装包由 `.github/workflows/build.yml` 在 tag push 后自动构建并发布到 GitHub Releases。

## 3. 当前核心功能状态

- AI 图片：支持多供应商文生图、图生图、Prompt 工程师和反推提示词。
- AI 视频：支持按供应商能力进行文生视频和图生视频。
- AI 序列帧：支持 `2x2 / 3x3 / 4x4` 网格生成，用户审核后通过顶部工具条「切割动画」进入切割配置。
- 切割动画：支持行列数、线宽、FPS、透明背景处理、角色居中/基线校准和抽帧。
- 透明背景策略：不要假设 GPT Image 2 稳定输出真实 Alpha；序列帧默认走纯绿 `#00FF00` 背景，再由切割动画的 chroma key / 白底后处理兜底。
- 付费生图策略：提交请求不要静默重试；失败后如果已有 job/task id，应继续轮询同一任务，避免重复扣费。
- Spine 导出：必须输出可被现有导入器重新导入的 `.json + .atlas + .png` 文件包，不应只生成画布预览。

## 4. 修改代码前的定位规则

- 改节点：优先看 `src/features/canvas/domain/canvasNodes.ts`、`src/features/canvas/domain/nodeRegistry.ts`、`src/features/canvas/nodes/index.ts`。
- 改工具：优先看 `src/features/canvas/tools/types.ts`、`src/features/canvas/tools/builtInTools.ts`、`src/features/canvas/ui/tool-editors/`、`src/features/canvas/application/toolProcessor.ts`。
- 改模型/供应商：优先看 `src/features/canvas/models/registry.ts`、`src/features/canvas/models/image/`、`src/features/canvas/models/providers/`、`src-tauri/src/ai/providers/`。
- 改 AI 助手：优先看 `src/commands/ai.ts`、`src/stores/settingsStore.ts`、`src/features/canvas/ui/PromptEngineerDialog.tsx`。
- 改持久化：优先看 `src/stores/projectStore.ts`、`src/commands/projectState.ts`、`src-tauri/src/commands/project_state.rs`。

## 5. 必跑验证

轻量验证：

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

大改或发布前：

```bash
npm run build
```

涉及桌面能力、文件导出、SQLite、图片处理或 Tauri 命令时，应使用：

```bash
npm run tauri dev
```

## 6. 接手时不要做的事

- 不要绕过 `nodeRegistry.ts` 手写节点菜单白名单。
- 不要让 UI 层直接耦合底层 Tauri/API 细节。
- 不要把 GPT Image 2 真实透明背景当成稳定前提。
- 不要让 Spine 导出只创建预览节点，必须落盘三件套。
- 不要把临时测试密钥、截图路径或单次故障流水账写入 `AGENTS.md` / `CLAUDE.md`。
- 不要在拖拽、缩放、输入中做重持久化或重图片处理。
- 不要为新弹窗重复手写拖动逻辑，优先用默认可拖动的 `UiModal`。
- 不要让文件 drop 冒泡到页面级；图片工具箱上传区优先用 `ImageUploadDropZone`。

## 7. 如果文档和代码冲突

以代码和最新构建验证结果为准，然后同步修正文档。稳定规则写入 `AGENTS.md` / `CLAUDE.md`，操作说明和架构细节写入 `docs/`，发布变更写入 `docs/releases/`。
