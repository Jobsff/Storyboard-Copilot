# 666api 万相视频（阿里格式）本地 Smoke Test 总结

本文只覆盖 **阿里格式的万相视频**链路：提交 `/api/v1/services/aigc/video-generation/video-synthesis` + 任务查询 `/v1/tasks/{task_id}`（以及 `task_` 前缀任务的 `/v1/video/generations/{task_id}` 兼容）。

## 范围与结论

- 已按要求取消 Kling 的所有视频模式方案：前端/后端视频链路仅保留 Wan（阿里格式万相）。
- 当前产品锁定的视频模型：`wan2.6-i2v-flash`（图生视频）。
- 666api 官方文档示例中 `img_url` 为 **可公网访问的 https URL**（参考 [万相视频生成](https://docs.666api.ai/api-reference/%E8%A7%86%E9%A2%91%EF%BC%88videos%EF%BC%89%E9%98%BF%E9%87%8C%E6%A0%BC%E5%BC%8F/%E4%B8%87%E7%9B%B8%E8%A7%86%E9%A2%91%E7%94%9F%E6%88%90)）。
- 本地用 `data:image/...;base64,...` 作为 `img_url` 进行 i2v 测试时，出现过 Cloudflare `524` 超时（提交阶段未返回 task_id）；该现象更像上游/网关超时或不支持 dataURL 形态导致的慢处理。

## 测试输入（temp/）

以下文件用于本地 smoke test 读取（请勿提交敏感信息）：

- `temp/测试用apikey.md`：包含 baseUrl 与 apikey（脚本会自动解析，不会写入明文到输出）
- `temp/文生视频提示词.md`：提示词
- `temp/test1.png`：参考图（i2v 测试默认使用）

## Smoke Test 脚本

脚本位置：

- `temp/666api_video_smoketest.mjs`

能力：

- 仅保留 Wan（阿里格式）测试：i2v（`wan2.6-i2v-flash`）
- 自动记录请求证据与产物到 `temp/video-smoketest/<timestamp>/`
- 支持 502/503/504/524 的简单重试（`RETRY_ATTEMPTS`）

### 常用运行方式

运行（默认使用 `temp/test1.png` 作为参考图）：

```bash
node temp/666api_video_smoketest.mjs
```

提高提交超时/重试次数（缓解 524）：

```bash
RETRY_ATTEMPTS=12 POST_TIMEOUT_MS=240000 node temp/666api_video_smoketest.mjs
```

用公网图片 URL 作为参考图（更贴近 666api 文档的 `img_url` 形态）：

```bash
IMAGE_URL='https://example.com/your.png' node temp/666api_video_smoketest.mjs
```

可选环境变量：

- `IMAGE_PATH`：默认 `temp/test1.png`
- `IMAGE_URL`：若提供则优先作为 i2v 的 `img_url`
- `RESOLUTION`：默认 `720P`
- `DURATION`：默认 `5`
- `GET_TIMEOUT_MS`：默认 `25000`
- `POST_TIMEOUT_MS`：默认 `180000`
- `RETRY_ATTEMPTS`：默认 `5`

## 输出目录与证据文件

每次运行会生成：

- `temp/video-smoketest/<timestamp>/context.json`：脱敏后的运行上下文
- `models.raw.json` / `models.wan.json`：模型列表记录
- `results.json`：本次运行结果汇总

成功时额外包含：

- `wan.<model>.<task_id>.mp4`：下载的视频文件
- `wan.<model>.result.json`：包含 videoUrl 与 outPath 的证据
- `wan.<model>.poll.last.json`：轮询最后一次返回（便于排障）

失败时通常包含：

- `wan.<model>.submit.json`：提交失败的状态码与返回体（例如 524 HTML）

## 现有运行证据（已产出目录）

以下目录为当前仓库内已经存在的 run 证据（可作为“平台/网络波动”与“程序行为”的对照）：

- 成功样例（i2v 产出 mp4）：`temp/video-smoketest/20260511_204105/`
  - 其中包含 `wan.task_M8Cgnw2URxhuVKafKHkXO23JO0UTdQQf.mp4`
- 失败样例（提交 524，未返回 task_id）：`temp/video-smoketest/20260511_212230/`

## 代码侧现状（仅万相视频）

- 前端视频节点：`src/features/canvas/nodes/VideoEditNode.tsx`
  - 模型固定为 `666api/wan2.6-i2v-flash`
  - 无参考图时会阻止提交并提示先连接参考图
- Rust provider：`src-tauri/src/ai/providers/api666/mod.rs`
  - 视频 submit/poll 统一走 Wan（阿里格式）路径
  - 视频模型仅允许 `wan2.6-i2v-flash`
  - 已移除 Kling/OpenAI 视频的不可达实现

## 近期校验结果

- `npx tsc --noEmit`：通过
- `cargo check`：通过（存在少量 `dead_code` 警告，后续可按需清理）
