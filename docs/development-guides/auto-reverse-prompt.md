# 自动反推提示词开发方案

## 目标

- 在画布中从”可输出图片”的节点拉线创建新节点时，新增一个菜单项：自动反推提示词。
- 自动调用 666api 的 `doubao-seed-2-0-mini-260215` 进行识图，把生成的提示词写入 AI 图片节点的提示词输入框（不自动触发生成）。
- 支持两种输出模式：中文纯文本（`language=zh`）和 JSON 结构化（`language=json`）。

## 不在本方案内

- 抠图/背景去除。

## 现状

- 连接菜单候选节点由节点注册表推导（connectMenu），并在 `Canvas` 中创建节点与连线。
- AI 图片节点为 `imageNode`（ImageEditNode），包含 `prompt/model/size/aspect_ratio/reference_images/extra_params` 等数据。
- 图片输入来源可由图结构收集：遍历指向该节点的入边，抽取上游节点 `imageUrl`。

## 交互与数据流

1. 用户从 Upload/ExportImage 等节点拖出连线，在画布空白处松开。
2. 弹出“创建节点菜单”，包含：
   - AI 图片
   - 分镜生成
   - 自动反推提示词
3. 用户选择“自动反推提示词”：
   - 创建一个 AI 图片节点（同 UI）
   - 自动连线到上游节点
   - 自动识图得到提示词，填入该 AI 图片节点的 `prompt`
   - 用户可编辑提示词后再点击“生成”

## 节点设计

### 方案：新增一个“仅用于连线菜单”的节点类型

- 新增 `imageAutoPromptNode`（示例命名）作为一个独立的 `CanvasNodeType`：
  - `visibleInMenu: false`（不在双击画布菜单中出现）
  - `connectMenu.fromSource: true`（在拉线菜单出现）
  - `menuLabelKey` 对应“自动反推提示词”
- 渲染组件仍复用 `ImageEditNode`（避免复制 UI），通过节点 data 中的标志位触发一次性行为：
  - `autoPrompt: true`

### 自动行为触发条件

在 `ImageEditNode` 内部增加一次性 effect：

- 仅当：
  - `autoPrompt === true`
  - `prompt` 为空
  - 入边存在至少 1 张上游图片
  - 当前未处于生成中
- 执行：
  - 调用 `reverse_prompt` 命令（Tauri）
  - 成功：写入 `prompt`，并将 `autoPrompt` 置为 false
  - 失败：保留 `autoPrompt` 置为 false，并记录错误到 `generationError/generationErrorDetails`（或新增 `autoPromptError` 字段）

## 后端能力（Tauri）

### 新命令

- `reverse_prompt`
  - 输入：
    - `model`: 固定 `doubao-seed-2-0-mini-260215`（666API default 分组 key）
    - `image`: 参考图（data url 或本地 file path）
    - `language`: `zh`（中文纯文本）或 `json`（JSON 结构化，含 color_palette、key_elements、use_case 等字段）
  - 输出：
    - `prompt`: string

- 端点：`POST https://www.666api.ai/v1/chat/completions`
- 结构：OpenAI 兼容的 `messages`，其中 user content 包含 text + image（多模态格式）
- 约束输出：只返回可直接用于生图的提示词（不输出解释、步骤、免责声明）

## 前端能力

- 在 commands 层新增 `reversePrompt()`，封装 Tauri invoke。
- 在 `AiGateway` 增加 `reversePrompt` 方法，供节点 effect 调用。

## i18n

- 新增文案 key：
  - `node.menu.autoPrompt`：自动反推提示词
  - `ai.autoPrompt.error`：反推提示词失败

## 安全与隐私

- 不在前端日志里输出原始图片 base64 全量内容。
- 不在错误报告中包含 API key。
- 默认仅使用用户主动拉线触发，不做后台自动批量分析。

## 验收标准

- 拉线菜单出现“自动反推提示词”。
- 选择后创建 AI 图片节点并自动连线。
- 自动填入提示词到文本框；用户可编辑并继续生成。
- 失败时有可复制的错误报告，不会导致黑屏或卡死。

