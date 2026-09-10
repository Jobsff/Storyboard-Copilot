# AGENT-BRIEF · 巨游美术工坊（Storyboard-Copilot）

> 子智能体冷启动速览。主对话随进展更新。详细规范见项目根 AGENTS.md / CLAUDE.md（必读）。

## 项目一句话

Tauri 2 桌面应用：节点画布式 AI 美术工作台（文生图/图生图/视频/序列帧/分镜/Spine），供美术人员日常出图。

## 目录速览

- 前端 `src/`：React 18 + TS + Zustand + @xyflow/react + Tailwind，Vite 端口 1420
  - 分层红线：UI → Store → Application(`src/features/canvas/application/`) → Infrastructure(`infrastructure/tauriAiGateway.ts`) → `src/commands/*.ts`(invoke 桥) → Rust。**不可越层**
  - 模型注册表 `src/features/canvas/models/registry.ts`（id 格式 `{providerId}/{model}`，DEFAULT_IMAGE_MODEL_ID，HIDDEN_PROVIDERS=kie/ppio/fal；PROVIDER_DISPLAY_ORDER=grsai→aifast→666api→juyouapi→agnes→ollama 三处展示统一）
  - 设置 `src/stores/settingsStore.ts`（zustand persist localStorage，key `settings-storage`，**当前 version 20**（customEndpoints[].joinChain + aifastModels/aifastJoinChain）；迁移纯函数在 `src/stores/settingsMigration.ts`，单测 `npm test`）
  - 智能出图虚拟模型 `src/features/canvas/models/image/auto/`（auto/standard、auto/pro；链可用渠道与 key 预注入统一在 `application/imageFallback.ts`；渠道探活请求构建/健康缓存也在此）
  - 错误行动化 `src/features/canvas/application/errorAdvice.ts`（class→建议/按钮映射 + 关键词兜底分类，规则与 Rust error_classify 对齐）；失败对话框带行动按钮（GlobalErrorDialog actions）
  - 渠道探活 doctor：Rust `probe_channels`/`list_channel_health`（ai_channel_health 表，前端传 key 快照）+ 软降权 `chain::demote_down_hops`（down 渠道挪链尾，ChainMeta.note 走 running 黄字通道）+ 设置页「渠道健康」面板
  - 主生成节点 `src/features/canvas/nodes/ImageEditNode.tsx`；轮询循环在 `Canvas.tsx`（1400ms）
- 后端 `src-tauri/src/`：Rust + reqwest + rusqlite(SQLite, WAL)
  - `ai/mod.rs`：AIProvider trait + ProviderRegistry（按 `{providerId}/` 前缀路由）
  - `ai/providers/`：api666 / juyouapi / aifast（=Api666Provider 固定 base picture.aifast.site）/ agnes / ppio / grsai / kie / fal / ollama
  - `commands/ai.rs`：generate_image、submit/get_generate_image_job、set_api_key、register_custom_endpoint 等
  - 任务表 `ai_generation_jobs`（submit+poll，app 重启可恢复 resumable hop）

## 约定

- 前后端仅 invoke() 通信；DTO 增量用 Option 字段保持向后兼容
- API key/baseUrl 唯一真源是前端 localStorage，运行时 set_api_key 注入 Rust（Rust 不持久化密钥）
- 数据库迁移：CREATE IF NOT EXISTS / ALTER TABLE 增量，老库必须无痛升级
- 验证：`cargo check`（src-tauri 下）+ 前端 `npm run build`；改 Rust 后必须 cargo check 零错

## 当前主线（2026-09-10 起）：渠道可靠性升级

两大痛点：① API 中转抽风→出图失败/极慢且美术不知原因；② 渠道太多不会选。

升级方案（已批准，源自 image-studio 技能移植，参考 `/Users/jobsff/.agents/skills/image-studio/SKILL.md`）：

- **A 超时治理**：全局 reqwest client（connect 10s / total 300s）；kie 轮询上限；poll 错误不再伪装 running（ai.rs 842-847 是历史坑位，行号可能漂移）
- **B 自动降级链**：Rust 任务编排层 job 内换渠道（新增 `ai/chain.rs`），链打头 grsai/nano-banana-2（价格优先）→ 666api → juyouapi → kie；i2i 链不含 grsai gpt 系（慢线铁律）；指定 provider/model=单点直连不降级
- **C 渠道探活**：probe_channels 命令（零生成成本，GET /v1/models 计时，grsai 404=可达特判）+ 设置页健康面板
- **D meta 台账**：ai_generation_history 表；data:URL 结果落 `media/` 目录不再塞 DB
- **E 智能出图**：虚拟模型 `auto/standard`、`auto/pro` 置顶为默认；专家模式原样保留；settingsStore v17→v18
- **F 错误行动化**：error_classify（Timeout/ChannelDown/Auth/Quota/ContentFilter/Unknown）→ 前端行动按钮对话框

批次进度：批次1完成（超时治理+错误分类：全局 reqwest client 10s/300s、kie 轮询 10min 上限、poll 连续 3 次失败判终态、15 分钟 running 兜底、error_classify 六类分类随 DTO error_class 透出）。批次2完成（模块 B 自动降级链：ai/chain.rs 三条静态链 + build_chain 过滤/空链退化单点；GenerateRequestDto.fallback 可选字段；ai_generation_jobs 加 chain_meta_json/model 列；fail_or_advance 主循环 CAS 推进防双提交、job_id 全程稳定、重启恢复降级、成功回填实际命中渠道；链任务按 hop_started_at 各享 15 分钟时限）。批次3完成（模块 D meta 台账：ai/media_store.rs 结果落盘——>64KB 落 `app_data_dir/media/{job_id}.{ext}`、DB 存 `file:media/` 标记、dto_from_record 还原完整 data URL 前端契约零改动、7 天启动清理；新表 ai_generation_history + finalize_job 八路终态路径收口 + jobs 表 request_json 精简快照列（prompt/model/size/aspect_ratio，剥参考图）+ list_generation_history 命令已注册待批次5 UI 接入）。**批次4完成（模块 E 智能出图·纯前端：虚拟模型 auto/standard、auto/pro 置顶为默认 DEFAULT_IMAGE_MODEL_ID；ModelParamsControls 智能出图 tab 置顶+⭐，手动选择行为不变；四个图片生成入口（ImageEdit/StoryboardGen/SequenceFrameGen/Canvas uiAssetPreset）统一接空链防护（报 ai.chainKeyRequired，绝不发占位 id）+ fallback 注入 + 链渠道 key 预注入 Rust（injectChainApiKeys，修掉"hop 换渠道无 key"缺口）；commands/ports/gateway 透传 fallback 与 error_class 类型；settingsStore v17→v18（imageGenMode/imageQuality/autoProbeOnLaunch，老用户 lastUsedImageModel 原样保留，迁移抽纯函数 settingsMigration.ts + vitest 6 单测，新增 npm test））**。**批次5完成（模块 F 错误行动化 + 模块 D UI 收尾：Rust DTO 增 provider_id/model/attempts 可选字段（成功路径改走 dto_from_record 重载，前端轮询自带 generationMeta）+ 成功终态剥 chain_meta request 快照（批次3遗留）；errorAdvice.ts 六类错误→人话建议+行动按钮（打开设置/去充值/重试），关键词兜底分类与 Rust error_classify 对齐（17 单测）；Canvas 轮询失败/ImageEditNode 提交 catch 接入，复制详情报告能力保留；running 态异常黄色小字+已等待时长；成功角标 generationMeta（渠道·模型·耗时·智能链）；设置页新增「生成记录」面板（list_generation_history 最近 100 条，失败行展开链轨迹，按需拉取）；settingsStore v18→v19（backendSyncErrors 同步失败可见化 + 设置页黄条重试同步）。cargo check 0 错 / test 27 过；npm run build 0 错 / npm test 24 过**。**批次6完成（模块 C 渠道探活 doctor + 软降权 + 渠道情报，升级主线 A-F 全部收口：Rust probe_channels（前端传 key 快照——trait 红线不动故偏离任务书无参签名；零生成成本只拉模型列表，10s 自身超时，并发限 4，grsai 404=reachable 特判，链模型交集计数 chain_models_ok）+ ai_channel_health 表 + list_channel_health；软降权 demote_down_hops 纯函数（down 渠道稳定挪链尾、绝不剔除，submit 建链时生效，单点路径不经过）+ ChainMeta.note 经 running 黄字通道透出「XX 当前不可用，本次自动从 YY 开始」；设置页「渠道健康」面板（四色徽标/延迟/人话/[立即重新检测]/autoProbeOnLaunch 开关）；专家模式供应商 Tab 健康圆点（只读台账不探测）+ 渠道情报 advice 小字（9 个 provider 定义，源 provider-guide.md）；启动静默探活；失败弹窗 [检测所有渠道]。cargo check 0 错 / test 31 过；npm run build 0 错 / npm test 25 过）**。单点直连（无 fallback）行为不变；复制报告能力不变。详见 HANDOFF.md。每批收尾写 `HANDOFF.md`。**批次7完成（mm3 对抗验收 0 阻断 + 主对话修 3 项一般级；未修记录：bundle 2.19MB 阈值项）。批次8完成（渠道扩充：grsai 出 HIDDEN_PROVIDERS 补标准卡（nano-banana-pro 下拉随出隐藏接活）+ 渠道展示顺序统一 grsai→aifast→666api→juyouapi→agnes→ollama（registry.PROVIDER_DISPLAY_ORDER，密钥区/专家 Tab/健康面板三处一致）；aifast 预置 NEWAPI 槽位（Rust new_with_config 固定 base，前端勾选模型 aifastModels 存 v20 经 syncCustomEndpointsFromStore 注册运行时，专家模式可选）；「自定义接口」更名「NEWAPI 接口」（纯文案，类型/命令名不动）；探活纳入 aifast+NEWAPI 端点（修 probe_one_channel 空 base 缺陷）+ 健康面板端点行；NEWAPI/aifast 可选入链（fallback.extra_hops 协议 {provider_id,model,display_name}，同名准入四重防御拼内置链尾，轨迹/软降权 note 显示端点名，key 随 availableProviders 预注入；红线：开关全关与 v0.3.0 逐字节一致）。cargo check 0 错 / test 36 过；npm run build 0 错 / npm test 27 过）**。**批次7完成（mm3 对抗验收 0 阻断 + 主对话修 3 项一般级；未修记录：bundle 2.19MB 阈值项）。批次8完成（渠道扩充：grsai 出 HIDDEN_PROVIDERS 补标准卡 + 渠道展示顺序统一 grsai→aifast→666api→juyouapi→agnes→ollama；aifast 预置 NEWAPI 槽位；「自定义接口」更名「NEWAPI 接口」；探活纳入 aifast+NEWAPI 端点；NEWAPI/aifast 可选入链 extra_hops 协议，开关全关与 v0.3.0 逐字节一致。+ v0.3.1 黑屏 TDZ 热修 + registry.boot.test 冒烟锁，详见 HANDOFF 事故记录）。**批次9完成（固定渠道模型清单写死：GRSAI 健康文案修正（grsai 404=绿标专属文案「网关无模型列表接口（正常）」，区分真 401/403 黄标）；GRSAI 定价修正（tier credits ×2 对齐官方 1点=¥0.00005，基准报价单测锁定 nano-2=0.06/pro=0.09/gpt-image-2=0.03/flare·sunburst=0.15）；GRSAI gpt 系三模型 gpt-image-2/2.5-flare/2.5-sunburst 静态上线 + Rust /v1/api/generate 同步路径（参考图 dataURL 铁律 + 像素串 + background/quality 透传，像素表与技能源配对级核验；nano 系 /v1/draw 与链一字未动）；aifast 改 7 模型静态清单（去获取勾选，settingsStore v21 删 aifastModels，无定价宁缺毋错，不含已下架 gemini-3.1-flash-image）；666api 不动。已知风险：aifast token/-preview 系 chat-completions 出图待真实 key 验证（备选=Gemini 原生分派，本期不做）；aifast 清单与链成员无同名 → 入链开关暂无 extra hop。cargo check 0 错 / test 39 过；npm run build 0 错 / npm test 40 过）**。批次9 补丁（2026-09-11 真实 key smoke 实证）：aifast 清单修正——gpt-image-2 503 model_not_found 移除、gemini-3.1-flash-image（无后缀）复活加回（仍 7 个）；token 线 chat-completions 出图风险解除；aifast 清单与链成员出现同名（gemini-3.1-flash-image）→ aifastJoinChain 开启时产生链尾 extra hop（协议预期、默认关）。详见 HANDOFF.md「批次9 补丁」小节。**grsai gpt 系空参考图守卫热修（2026-09-11）**：t2i 空数组经 gateway truthy 透传成 Some(vec![])，request_generate 守卫误报「参考图存在但编不出来」；修法=纯谓词 references_all_failed_to_encode 对齐 nano 口径（原始非空才算失败），cargo test 40 过。**v0.3.3 已发**（0.3.2 + 批次9 补丁 + 守卫热修；本地 `npm run tauri build`；⚠️ `cargo tauri` 不存在、`npm run release` 走 git push 与不 commit 纪律冲突，均勿用）。**批次10完成（智能出图 pro 档链序调整，用户拍板 2026-09-11：CHAIN_T2I_PRO 重排为 grsai nano-banana-pro 打头（游戏资产风最正）→ aifast/gemini-3-pro-image-preview 第二（**aifast 首次进内置链**，真实 key smoke 200/23.4s）→ 666api gemini-3-pro-image → 标准尾部，6 hop；前端 CHAIN_PROVIDER_IDS/CHAIN_MEMBER_MODEL_NAMES 双同步；i2i/standard 链一字未动；探活 chain_models_ok 动态求交自动计入 aifast；aifast 无 key 时 pro 链自动降级（单测锁定）。cargo check 0 错 / test 41 过；npm run build 0 错 / npm test 40 过，详见 HANDOFF.md「批次10」）**。

## 不要做的事

- 不动 AIProvider trait 契约；不新增 Rust 依赖（用现有 crates / std）
- 不做 OSS 落桶、视频降级链、渠道硬熔断、AI 抠图移植（方案明确排除）
- 不 git commit/push（除非任务书明说）
