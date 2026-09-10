# HANDOFF · 渠道可靠性升级 批次6（模块 C 渠道探活 doctor + 软降权 + 渠道情报）

> 2026-09-10 · 执行：G53F。最后一期功能。Rust + 前端，未 commit。
> 批次1-5 已完成（关键事实见文末「历史批次档案」）。

## 干了什么

1. **Rust `probe_channels`（零生成成本探活）**：
   - **签名偏离任务书说明**：`probe_channels(providers: Vec<ChannelProbeRequest>)` 带前端快照参，而非无参——AIProvider trait 无 key 查询方法且**红线禁止动 trait 契约**，Rust 无法自判「是否配置过 key」。前端传 `{provider_id, api_key, base_url?}` 快照（与 fallback.available_providers 同一「前端快照」哲学）；key 空 = unconfigured 跳过网络（ollama 本地部署免 key 例外）。
   - 三级结果：ok（列表拉到+key 有效，记延迟 ms）/ reachable（base 通但 key 无效或列表 401/403/404——**grsai 网关无 /v1/models，404 特判 reachable**）/ down（超时/5xx/DNS/连接失败）。复用 fetch_openai_compatible_models（666api/juyouapi/agnes）与 fetch_ollama_models；grsai/kie/ppio/fal 走新 `probe_generic_models`（GET {base}/v1/models，端点形态不匹配只会降为 reachable 不误报 down）。
   - **探活 10s 自身超时**：tokio::time::timeout 包裹 + generic 路径 per-request `.timeout(10s)`，不吃全局 300s 客户端；并发限 4（chunks(4) + tauri::async_runtime::spawn 分批）。
   - **链模型交集**：`count_chain_models_ok` —— 拉到的模型列表与 CHAIN_T2I_STANDARD/PRO/I2I 该渠道成员（裸模型名去重）求交集计数（grsai 2 / 666api 2 / juyouapi 1 / kie 2）。
   - 新表 `ai_channel_health`（provider_id 主键 upsert，CREATE IF NOT EXISTS 挂 open_db 初始化链）+ 新命令 `list_channel_health`（读最近结果，不触发探测）。两命令已注册 lib.rs。
2. **Rust 软降权（生成前建议的引擎侧）**：
   - 纯函数 `chain::demote_down_hops(hops, down_ids) -> (Vec<Hop>, bool)`：down 渠道成员**稳定挪链尾**（两侧各自保持原相对序）；全 down / 无 down 记录 / 单元素链 → 原序不变。**仅重排，绝不剔除、不拉黑**（探活有盲区）。4 个新单测（含 ChainMeta.note serde 往返 + 旧数据兼容）。
   - 落点：`submit_generate_image_job` 的 fallback closure 内、build_chain 之后 from_plan 之前——读 `ai_channel_health` status='down' 渠道 id（`list_down_channel_ids`，读失败返回空集=不降权），重排 plan.hops；被降权时组合人话说明写进 `ChainMeta.note`（serde default 新字段，旧 JSON 兼容）：「GRSAI 当前不可用，本次自动从 666API 开始」。
   - **note 透出（选了不改 DTO 形状的做法）**：`dto_from_record` 在 status=running 且行 error 为空时把 note 注入 DTO.error——前端批次5 的 running 黄字通道（generationRunningError）直接显示，零前端改动。CAS 不受影响：软降权发生在建链时（chain_meta 首次落库前），不碰 fail_or_advance 的旧值比对。
   - **单点直连红线**：软降权只在 fallback closure 内，无 fallback 单点路径完全不经过。
3. **前端 ChannelHealthPanel**：独立「渠道健康」分类（settingsEvents 加 'health'）。8 内置渠道各一行：四色徽标（绿/黄/红/灰）+ 渠道名 + 延迟 + 人话（「密钥有效，智能链 N 个链上模型可用」/「渠道无响应，智能出图会自动避开」/「未配置密钥」/「尚未检测」）+ 相对时间；顶部 [立即重新检测]（探测中 pulse）+「检测不会产生任何生成费用」提示 + `autoProbeOnLaunch` 开关（批次4 预留字段落 UI）+ 底部说明。
4. **commands/ai.ts + imageFallback.ts**：`probeChannels`/`listChannelHealth` 绑定；`buildProbeRequests`（8 渠道、666api 用链成员 gemini 分组 key、juyouapi/ollama 带 baseUrl）；`fetchChannelHealthCached`（模块级缓存防重复 invoke）+ `probeAllChannels`（探测后刷缓存，面板/弹窗/启动三处共用）。
5. **专家模式 Tab 圆点**：ModelParamsControls 供应商 tab 左侧小圆点（数据只读 list_channel_health 缓存，无数据=灰，**绝不触发探测**）；Tab 下方一行渠道情报小字（选中渠道的 advice）。
6. **启动静默探活**：App.tsx 等 settingsStore hydrate 完成后，`autoProbeOnLaunch` 开启则后台 probe 一次；失败仅 console.warn；零打扰。
7. **失败弹窗接 [检测所有渠道]**：channel_down/timeout 类 advice 增 `probeChannels` 动作 → probeAllChannels + 打开设置页渠道健康面板（动态 import 防循环依赖）。
8. **渠道情报文案（模块 E 第4条）**：`ModelProviderDefinition` 增 `advice?: { zh, en }`（定义内直取跟随界面语言；静态数据无 i18n key 惯例，任务书允许）；9 个 provider 定义（含 auto 虚拟渠道）全部写入，源 docs/settings/provider-guide.md；展示两处：设置页渠道卡片头部一行小字（666api/juyouapi/ollama/generic 四分支各插入）+ 专家模式 Tab 下方。**顺带把批次5 的 PROVIDER_RECHARGE_URLS 更新为 guide 里的真实官网**（grsai.com / kie.ai / api.juyou.ai / ppio.com / fal.ai / agnes-ai.com）。

## 关键判断

- **trait 红线 vs 无参签名的取舍**：见第 1 条。代价是探活 key 快照由前端拼装（基建已有，成本低）；收益是 AIProvider trait 一行未动。
- **软降权落点选在 submit 建链时而非 get/poll 时**：重排必须在首个 hop 提交前生效（否则 hop0 已扣费）；建链时一次重排落库，后续 CAS 推进天然沿用重排后的 hops 顺序，零额外状态。
- **note 走 error 通道 vs attempts 预记**：attempts[0] 预记会污染「实际尝试轨迹」语义（history 台账与前端轨迹都会多一条假记录）；note 独立字段 + running 期注入 DTO.error 语义干净，且批次5 黄字通道现成。
- **grsai 404 特判**在 classify_probe_failure 里以「HTTP 404 → reachable」通用表达，与批次1 grsai 情报一致，不写渠道名硬编码。
- **探活缓存策略**：Tab 圆点只读台账不触发网络；探测动作只来自三处显式入口（面板按钮/失败弹窗/启动开关）。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/chain.rs` | ChainMeta.note 字段；demote_down_hops 纯函数；4 个新单测 |
| `src-tauri/src/commands/ai.rs` | ChannelProbeRequest/ChannelProbeDto；probe_base_url/probe_generic_models/classify_probe_failure/count_chain_models_ok/probe_one_channel/upsert_channel_health/list_down_channel_ids；probe_channels + list_channel_health 命令；ai_channel_health 表 + open_db 挂载；submit 软降权接入 + note 组合；dto_from_record note 注入 |
| `src-tauri/src/lib.rs` | 注册 probe_channels / list_channel_health |
| `src/commands/ai.ts` | probeChannels/listChannelHealth + 类型 |
| `src/features/canvas/application/imageFallback.ts` | PROBE_CHANNEL_ORDER/buildProbeRequests/fetchChannelHealthCached/getCachedChannelHealth/probeAllChannels |
| `src/features/canvas/application/errorAdvice.ts` | probeChannels 动作 kind + handler；充值链接表更新为 guide 官网 |
| `src/features/settings/ChannelHealthPanel.tsx` | **新增**：渠道健康面板（含 autoProbeOnLaunch 开关） |
| `src/features/settings/settingsEvents.ts` | SettingsCategory 加 'health' |
| `src/components/SettingsDialog.tsx` | 渠道健康 nav+面板；四处渠道卡片 advice 小字 |
| `src/features/canvas/ui/ModelParamsControls.tsx` | 供应商 tab 健康圆点；tab 下方 advice 小字 |
| `src/features/canvas/models/types.ts` | ModelProviderDefinition.advice |
| `src/features/canvas/models/providers/*.ts`（9 个） | advice 定位文案 |
| `src/App.tsx` | 启动静默探活 effect（等 settings hydrate） |
| `src/features/canvas/application/__tests__/errorAdvice.test.ts` | 断言更新 + timeout/probe 动作新用例 |
| `src/i18n/locales/zh.json` / `en.json` | settings.channelHealth.*、errorAdvice.action.probeChannels |

## 复现验证

```bash
cd src-tauri && cargo check && cargo test    # 0 error / 31 passed（27 存量 + 4 新增）；clippy 触碰文件无新告警
npm run build && npm test                    # build 0 error / 25 passed
```

- 红线 grep：探活函数群无 provider.generate/submit_task 调用（唯一命中为注释）；软降权仅在 fallback closure 内（单点路径不经过）；Tab 圆点只读台账不触发探测
- 未验证项：真实端到端（配 key 点「立即重新检测」看四色徽标与延迟；错 key 看 reachable；断网渠道看 down 与软降权说明黄字）；tab 圆点视觉走查

## 升级主线收口状态

六大模块 A-F 全部落地。后续可选项（非主线）：渠道健康历史趋势、探活结果驱动价格排序、充值页深链人工确认。

---

## 历史批次档案（压缩）

- **批次5**（G53F，模块 F 错误行动化 + 模块 D UI 收尾）：Rust DTO 增 provider_id/model/attempts 可选字段（成功路径改走 dto_from_record 重载，前端轮询自带 generationMeta）+ 成功终态剥 chain_meta request 快照（批次3遗留）；errorAdvice.ts 六类错误→人话建议+行动按钮（打开设置/去充值/重试），关键词兜底分类与 Rust error_classify 对齐（17 单测）；Canvas 轮询失败/ImageEditNode 提交 catch 接入，复制详情报告能力保留；running 态异常黄色小字+已等待时长；成功角标 generationMeta（渠道·模型·耗时·智能链）；设置页「生成记录」面板（list_generation_history 最近 100 条，失败行展开链轨迹，按需拉取）；settingsStore v19（backendSyncErrors 同步失败可见化+设置页黄条重试）。
- **批次4**（G53F，模块 E 智能出图·纯前端）：虚拟模型 auto/standard、auto/pro（models/image/auto/ 四件套）置顶为 DEFAULT_IMAGE_MODEL_ID；registry VIRTUAL_PROVIDER_IDS 过滤 listModelProviders；application/imageFallback.ts 统一「链可用渠道现算（grsai=apiKeys['grsai']、666api=resolve666ApiKey(gemini 组)、juyouapi、kie）+ fallback 构建 + injectChainApiKeys 链 key 预注入（修掉 hop 换渠道无 key 缺口）」；四图片入口（ImageEdit/StoryboardGen/SequenceFrameGen/Canvas uiAssetPreset）空链拦截（ai.chainKeyRequired，addNode 之前）+ fallback 注入；ModelParamsControls 智能出图 tab 置顶⭐；settingsStore v17→v18（imageGenMode/imageQuality/autoProbeOnLaunch，lastUsedImageModel 原样保留）+ 迁移抽纯函数 settingsMigration.ts + vitest（devDep ^3.2.4 + npm test）。uiAssetPreset 必接：内置预设全不写 modelId 恒取 DEFAULT。



- **批次3**（G53F，模块 D meta 台账）：`ai/media_store.rs` 结果落盘（>64KB 落 `media/{job_id}.{ext}`，DB 存 `file:media/` 标记，dto_from_record 还原，7 天清理）；新表 `ai_generation_history`（成功失败都记，mode='auto'/'manual'）+ `finalize_job` 八路终态收口；jobs 表 `request_json` 精简快照列（剥参考图）；`list_generation_history` 命令已注册待批次5 UI。6 单测，cargo test 27 过。
- **批次2**（G53 旗舰，模块 B 降级链）：`ai/chain.rs` 三条静态链 + build_chain（i2i 铁律：grsai gpt 系永不上 i2i）+ ChainMeta + 轨迹；jobs 表 chain_meta_json/model 列；`GenerateRequestDto.fallback`（None=单点直连）；fail_or_advance CAS 推进防双扣费；重启恢复降级；链任务 15min 按 hop 计时。
- **批次1**（G53F，模块 A 超时治理）：全局 reqwest client（connect 10s/total 300s，`ai/http.rs`）；kie 轮询 10min deadline；`ai/error_classify.rs` 六类分类随 DTO error_class 透出；poll 3 连错终态 + 15min running 兜底。

## 批次7 · mm3 对抗验收（Go）+ 主对话收尾修复

- mm3 结论：可交付，0 阻断（5 项一般级：见其报告）
- 主对话已修 3 项：settingsMigration.ts:175 注释 v18→v19；ai.rs down_names 改用降权前原始链成员求交集（不再依赖"down 全在尾部"隐式不变量）；cas_advance_hop 补 CAS 自我修正注释
- 修后复验：cargo check 0 错 / cargo test 31 过 / npm test 25 过
- 未修（记录在案）：bundle 2.19MB 超阈值（存量+增量，manualChunks 另立项）；真实端到端 smoke 待美术人工执行（见交付检查清单）

## 批次8 · 渠道扩充（GRSAI 出隐藏 / aifast 预置槽位 / NEWAPI 纳入探活与智能链）

> 2026-09-10 · 执行：G53F。Rust + 前端，未 commit。

### 干了什么

1. **密钥区重排 + grsai 出隐藏**：新常量 `registry.PROVIDER_DISPLAY_ORDER = [grsai, aifast, 666api, juyouapi, agnes, ollama]`（`compareProvidersByDisplayOrder`：auto 置顶 → 顺序表 → newapi_* 垫底 → 字典序），三处消费统一：设置页密钥区 memo、专家模式供应商 Tab（ModelParamsControls providerOrder）、健康面板（PROBE_CHANNEL_ORDER 重排为 9 渠道，kie/ppio/fal 隐藏渠道垫底）。grsai 移出 HIDDEN_PROVIDERS（kie/ppio/fal 维持隐藏）→ 通用渠道卡自动渲染：key 输入 + 注册/取 key 链接（URL 表早已有 grsai 项）+ advice；**原不可达的 grsai 特化区块（nano-banana-pro 变体下拉，SettingsDialog ~1419）随出隐藏自动接活**，credit tier 在价格页本就可达，均无需新接线。
2. **aifast 预置 NEWAPI 槽位**：Rust `build_default_providers` 增 `Api666Provider::new_with_config("aifast", "https://picture.aifast.site")`（照 juyouapi 模式，base 固定；provider_id≠"666api" → gemini 自动走 chat-completions）。前端新建 `models/providers/aifast.ts` 静态定义（advice：企业级 NEWAPI 中转站…）+ settingsMigration 增 `AIFAST_PROVIDER_ID/AIFAST_BASE_URL`。设置页 aifast 卡：固定 base 只读 + key 输入 + 获取模型（list_provider_models 新增 aifast 分支）+ 模型勾选 + 入链开关；勾选存 `settingsStore.aifastModels`（v20），经 `syncCustomEndpointsFromStore(endpoints, aifastModels)` 注册为运行时模型（id 恒 'aifast'、不可删除；Canvas mount/customEndpoints/aifastModels 变化时同步），专家模式 Tab 出现 aifast。
3. **自定义接口 → NEWAPI 接口（纯文案）**：i18n zh「NEWAPI 接口」/en「NEWAPI Endpoint」+ 分类描述改为「用于添加 NEWAPI / OpenAI 兼容格式的中转商」；空态文案同步。代码层 CustomEndpoint 类型/命令名未动。
4. **探活纳入 aifast + NEWAPI 端点**：`buildProbeRequests` 增 aifast 行（固定 base）+ 每个 baseUrl 非空的端点行（base 传端点自己的）；ChannelHealthPanel 在 9 内置行后逐端点渲染（用户起的名字，未配 key 灰）。**Rust probe_one_channel 修复**：原 newapi_*/aifast 落入 generic 分支拿到空 base_url 必然失败——现 aifast 并入 fetch_openai_compatible_models（fallback base 已补）、newapi_* 走 fetch_openai_compatible_models_for_url（用请求传入 base_url）；probe_base_url 补 aifast 默认值。chain_models_ok 计数维持内置链语义不动。
5. **可选入链（extra_hops 协议）**：`CustomEndpoint.joinChain` + `settingsStore.aifastJoinChain`（v20 迁移，缺省 false=红线）。入链规则（前端 `resolveExtraChainHops`）：开启且已配 key 的端点，勾选模型与内置链成员**裸模型名完全同名**（CHAIN_MEMBER_MODEL_NAMES 五个名字）才生成追加档；`GenerateRequestDto.fallback` 增可选 `extra_hops: Vec<ExtraHopSpec>{provider_id,model,display_name}`（serde default 空）。Rust `build_chain(+extra_hops)`：内置链非空时按原序拼尾部，四重防御（未注册 provider/不在 available_providers/裸名不同名/(provider,model) 重复 → 跳过）；`Hop.display_name`/`ChainAttempt.display_name` 可选字段（serde default 旧数据兼容），summarize_attempts 与软降权 note 优先用端点显示名（provider_display_name 表补 aifast）。key 预注入复用既有链路：buildAutoImageFallback 把入链端点 id 追加进 availableProviders → 四个生成入口传 `useSettingsStore.getState()` 第三参 → injectChainApiKeys 原样覆盖新 id（resolveChainApiKey 默认分支即 apiKeys[id]）。

### 红线自查（开关全关 = v0.3.0 逐字节一致）

- 前端：开关全关 → resolveExtraChainHops 返回空 → extraHops 不赋值、availableProviders 不变 → DTO 无 extra_hops 字段
- Rust：extra_hops 空缺省 → build_chain 追加块整体跳过；Hop/ChainAttempt display_name=None → skip_serializing_if 不落库；单点直连（无 fallback）路径零接触
- 内置链 hop 序、软降权、CAS、15min/hop 时限均未改动逻辑，仅在 hops 尾部有可选追加

### 验证

- `cargo check` 0 错；`cargo test` 36 过（31 存量 + 5 新增：同名追加原序/不同名忽略/去重+未注册+无 key 跳过/空链不拼/display_name 轨迹+旧 JSON 兼容）
- `npm run build` 0 错（bundle 2.19MB 为批次7 已记录的存量阈值项）；`npm test` 27 过（25 存量 + 2 新增 v20 迁移断言）
- grep：zh/en 与用户可见 UI 无「自定义接口」残留；kie/ppio/fal 仍在 HIDDEN_PROVIDERS；picture.aifast.site 双端 5 处一致
- 未验证：真实端到端（aifast 配 key 拉模型勾选出图；探活面板端点行四色；入链后真实降级轨迹显示端点名）——待美术人工走查

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/providers/mod.rs` | aifast 内置注册（new_with_config，base 固定） |
| `src-tauri/src/ai/chain.rs` | ExtraHopSpec/FallbackOptions.extra_hops/Hop.display_name/ChainAttempt.display_name；build_chain 追加拼接+四重防御；provider_display_name 补 aifast；summarize 优先 display_name；5 个新单测 |
| `src-tauri/src/commands/ai.rs` | build_chain 传 extra_hops；fail_or_advance 轨迹带 display_name；软降权 note 端点名；probe_base_url/fetch models 补 aifast；probe_one_channel 修复 newapi_*/aifast 分支；list_provider_models 增 aifast |
| `src/stores/settingsMigration.ts` | CustomEndpoint.joinChain；AIFAST_PROVIDER_ID/AIFAST_BASE_URL；normalizeStringList；v20 迁移 |
| `src/stores/settingsStore.ts` | aifastModels/aifastJoinChain + setters；version 20 |
| `src/stores/__tests__/settingsMigration.test.ts` | v20 两个新用例 |
| `src/features/canvas/models/registry.ts` | HIDDEN 移除 grsai；PROVIDER_DISPLAY_ORDER/compareProvidersByDisplayOrder；syncCustomEndpointsFromStore 收 aifastModels |
| `src/features/canvas/models/providers/aifast.ts` | **新增**：aifast 静态定义 + advice |
| `src/features/canvas/application/imageFallback.ts` | PROBE_CHANNEL_ORDER 重排；CHAIN_MEMBER_MODEL_NAMES；resolveExtraChainHops；buildProbeRequests/probeAllChannels 收端点；buildAutoImageFallback 第三参 |
| `src/commands/ai.ts` | ExtraHopSpec/extra_hops/GenerationAttemptStatus.display_name；sanitize 日志 |
| `src/features/canvas/application/ports.ts` + `src/features/canvas/infrastructure/tauriAiGateway.ts` | GenerateImageFallback.extraHops 透传 |
| `src/components/SettingsDialog.tsx` | 渠道顺序 memo；grsai 卡接活；aifast 卡（base 只读/key/拉模型/勾选/入链）；端点 joinChain 开关；NEWAPI 文案 |
| `src/features/settings/ChannelHealthPanel.tsx` | 端点行渲染；探测范围含端点 |
| `src/features/canvas/ui/ModelParamsControls.tsx` | providerOrder 重排（auto/grsai/aifast/666api/juyouapi/agnes/ollama） |
| `src/features/canvas/Canvas.tsx` | sync 同步 aifastModels；uiAsset 入口传快照 |
| `src/features/canvas/nodes/{ImageEdit,StoryboardGen,SequenceFrameGen}Node.tsx` | buildAutoImageFallback 传 settings 快照第三参 |
| `src/features/canvas/application/errorAdvice.ts` / `src/App.tsx` | probeAllChannels 传 customEndpoints |
| `src/features/settings/GenerationHistoryPanel.tsx` | 轨迹 display_name 优先 + label 表补 aifast |
| `src/i18n/locales/zh.json` / `en.json` | customEndpoints→NEWAPI；joinChainSwitch(+Desc) |

## 事故记录 · v0.3.1 黑屏热修（2026-09-10）

- 症状：0.3.1 安装后打开黑屏（0.3.0 正常）
- 根因：registry.ts 模块求值期（line 23 的 providers.sort）调用 compareProvidersByDisplayOrder，其引用的 PROVIDER_ORDER_INDEX/PROVIDER_DISPLAY_ORDER 声明在调用点之后（const 不提升，函数提升）→ TDZ ReferenceError → bundle 顶层炸 → React 未挂载。批次8 引入
- 为何漏网：vitest 只覆盖纯函数模块，从未执行 registry 完整模块图；tsc/vite build 不执行 bundle
- 修复：常量块上移到排序之前（registry.ts 顶部，带 ⚠️ 注释防回退）
- 回归锁：新增 src/features/canvas/models/__tests__/registry.boot.test.ts——node 环境 import 真实模块图（vitest 原生支持 import.meta.glob），任何顶层求值异常红灯；npm test 现在 29 过
- 验证闭环：无头 Chrome + 静态服务 + stderr 抓错（修复前 root 空 + Uncaught；修复后 root 8691 字符 + 0 错）——此法可复用为发布前 bundle 冒烟

## 批次9 · 固定渠道模型清单统一写死（GRSAI gpt 系 / aifast 静态化 / 定价修正）

> 2026-09-10 · 执行：G53F。Rust + 前端，未 commit。版本号不动（0.3.2 由主对话统一发）。

### 干了什么

1. **GRSAI 健康文案修正（用户困惑点）**：用户配了 grsai key 被显示「密钥无效或无模型列表」吓到——根因是 grsai 网关本来就没有 /v1/models，404 特判 reachable 后 detail 文案误导。Rust `probe_one_channel` 失败分支：grsai 且 reachable 且 HTTP 404 → detail 换成固定标记串 `PROBE_NO_MODEL_LIST_DETAIL`（"gateway has no model-list endpoint; key will be verified on generation"，对齐技能 doctor 口径）；真 401/403（key 无效）保持原文走黄标。前端 ChannelHealthPanel：reachable 分支按 detail 含 `no model-list endpoint` 细分——绿徽标 + i18n 专属文案 `settings.channelHealth.reachableNoModelList`（zh/en）。
2. **GRSAI 定价口径修正**：根因 tier 表按 1点=¥0.0001 标定（¥10/100000 点），实际官方口径「积分÷20000=元」（1点=¥0.00005）。修法 = **tier credits 全表 ×2**（¥10/200000 … ¥999/40000000）+ nano-banana-2 点数 1300→1200（官方点）；pro 1800 点本来就对。tier 已选 id 语义不变（越贵越便宜的相对关系保持），设置页 tier 选项显示的积分数字随表自动正确。验收基准单测锁定：nano-banana-2=¥0.06 / pro=¥0.09 / gpt-image-2=¥0.03 / flare·sunburst=¥0.15（tier-10 档）。
3. **GRSAI gpt 系三模型（静态写死，情报源=image-studio 技能两个月实测）**：
   - 前端 `models/image/grsai/` 新增：`gpt-image-2`（¥0.03/600 点，透明底专用真 RGBA 约 1254² 上限仅 1K 档，`transparent_background` 参数——与 666api 提示词式不同，走真 API 参数，新增 i18n key `modelParams.grsaiTransparentBackgroundDesc`）；`gpt-image-2.5-flare`（¥0.15/3000 点，i2i 主力 4K ~32s）；`gpt-image-2.5-sunburst`（¥0.15/3000 点，i2i 精修 ~38s）。flare/sunburst 带 quality enum（auto=不透传 + low/medium/high/xhigh/max，与技能 CLI 一致：仅显式选择才透传）。不加 lite/-fast/-cl/-vip/裸 2.5。
   - Rust `grsai/mod.rs`：SUPPORTED_MODELS 7→10、list_models 2→5；**新增 `/v1/api/generate` 同步调用路径**（gpt 系专用；nano 系 /v1/draw + webhook 轮询一字未动）：body `{model, prompt, images, aspectRatio(像素串), background?, quality?, replyType:"json"}`；参考图一律 base64 dataURL（铁律：http URL 必挂——新增 `encode_reference_as_dataurl`，本地/file 路径读文件、http URL 下载转 dataURL，带魔数 MIME 兜底）；`background:"transparent"` 仅当 extraParams.transparent_background=true；quality 仅 gpt-2.5 系且五档白名单才透传；响应 `status=="succeeded"` → `results[0].url`（http/dataURL 均可，dataURL 由批次3 media_store 落盘管线消化）；`normalize_requested_model` 补 gpt 系原样透传（否则会被 nano 归一化改写成 pro）。像素表 GRSAI_GPT_PX（13 比例×1K/2K/4K=39 格）+ GRSAI_GPT2_PX（10 比例单档）从 image_studio.py **逐格抄全并脚本配对级验证 OK**；查不到表退回比例串（对齐 _grsai_gpt_pixel fallback）。3 个 Rust 单测（单档表/多档折算/分类分派）。
   - **链红线**：chain.rs 三条静态链成员与顺序与批次2 逐字一致（grep 核对）；grsai gpt 系不入任何链，只在专家模式单点直连可用。
4. **aifast 改静态清单（去掉获取勾选）**：
   - 前端 `models/image/aifast/`：`modelNames.ts` 单一真相源（7 个模型名，token 线排首位）+ `factory.ts`（gemini 系共用工厂，照 juyouapi 谨慎口径 5 比例/1K）+ 7 个静态模型文件（友好名：Gemini 3 Pro Image · token 线 等；gpt-image-2 照 666api 先例 9 比例 1K/2K/4K）。**定价一律不设（宁缺毋错）**——单测锁定。
   - Rust api666 `list_models`：aifast 专属分支同步 7 个，**不含 `gemini-3.1-flash-image`（无后缀版 403 已下架）**；juyouapi 等其他非 666api 分支原样（其 gemini-3.1-flash-image 是链成员，保留正确）。
   - SettingsDialog aifast 卡简化：固定 base 只读 + 密钥 + 入链开关 + 静态模型只读小字清单（displayName + 裸名）；删「获取模型」按钮/勾选 UI/fetch handlers。
   - settingsStore **v20→v21**：删 `aifastModels` 字段与 setter，保留 `aifastJoinChain`；迁移层新增 `stripRetiredFields`（spread 输入前剥离退役键——否则 v20 的 aifastModels 会经 spread 回流，单测抓出后修复）；`normalizeStringList` 随 setter 退役删除；迁移测试补 v21 用例（字段不在输出、aifastJoinChain 保留）。
   - registry：`syncCustomEndpointsFromStore` 恢复单参（aifast 运行时注册路径退役）；Canvas 同步点还原；imageFallback 的 aifast 入链候选改读 `AIFAST_MODEL_NAMES` 静态清单。
5. **666api 不动**（写死且生产在用）。

### 已知风险（记录在案，本期不做）

- **aifast token/-preview 系经 chat-completions 出图是否正常待真实 key 端到端验证**（api666 非 666api 分支把 gemini-* 一律走 /v1/chat/completions；token 线/hy 线模型名带后缀，上游是否接受 chat 形态未实测）。备选方案：api666 内为 aifast 加 Gemini 原生分派（`/v1beta/models/{model}:generateContent`）——本期不做。
- aifast 静态清单与内置链成员**无同名模型**（gemini-3-pro-image-preview ≠ 链上 gemini-3-pro-image；带 -token/-hy 后缀均不同名）→ 按同名准入规则，aifast 入链开关开启后实际不产生 extra hop。开关无害保留，等上游出现真同名模型时自动生效。
- grsai gpt 系 /v1/api/generate 为同步长连接（4K 实测 177s），吃全局 client 300s total 上限，与技能「≥300s 起步」口径一致；超时即报 Timeout 走既有行动化。

### 验证

- `cargo check` 0 错；`cargo test` 39 过（36 存量 + 3 新增：像素单档表/多档折算含技能实测例/gpt 分类分派）
- `npm run build` 0 错；`npm test` 40 过（29 存量 + 6 报价基准 + 5 aifast 清单锁）
- 像素表：Python 脚本对 image_studio.py 源做**配对级**比对——GRSAI_GPT_PX 39 格 / GRSAI_GPT2_PX 10 格全 OK
- grep 验收：aifast 卡无「获取模型」残留（剩余两处属 NEWAPI 端点卡与 AI 助手，均在）；`gemini-3.1-flash-image`（无后缀）不在 aifast 清单（api666:1853 命中属 juyouapi 分支=链成员，保留正确）；aifastModels 前端仅存迁移剥离表与测试
- 链红线：chain.rs 三条静态链 hop 逐字核对与批次2 一致
- 未验证：真实端到端（grsai gpt 系三种出图含透明底；aifast token 线 chat-completions 出图；健康面板 grsai 绿标新文案）——待美术人工/真实 key

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/ai.rs` | PROBE_NO_MODEL_LIST_DETAIL；probe_one_channel grsai 404 detail 细分 |
| `src-tauri/src/ai/providers/grsai/mod.rs` | SUPPORTED_MODELS/list_models 扩充；像素表×2 + grsai_gpt_class/resolve_gpt_pixel/is_gpt_model；encode_reference_as_dataurl；request_generate（/v1/api/generate）；submit/generate 分派；normalize_requested_model 透传 gpt 系；3 单测 |
| `src-tauri/src/ai/providers/api666/mod.rs` | list_models aifast 专属 7 模型分支 |
| `src/features/canvas/pricing/types.ts` | GRSAI_CREDIT_TIERS credits ×2（对齐 1点=¥0.00005） |
| `src/features/canvas/models/image/grsai/nanoBanana2.ts` | 1300→1200 点 |
| `src/features/canvas/models/image/grsai/gptImage2.ts / gptImage25Flare.ts / gptImage25Sunburst.ts` | **新增** 3 个 gpt 系静态模型 |
| `src/features/canvas/models/image/grsai/__tests__/pricing.test.ts` | **新增** 四模型报价基准锁 |
| `src/features/canvas/models/image/aifast/*`（modelNames/factory/7 模型/__tests__） | **新增** 静态清单 + 一致性锁 |
| `src/features/canvas/models/providers/aifast.ts` | advice 更新（7 个实测模型开箱即用） |
| `src/stores/settingsMigration.ts` | v21（aifastModels 退役剥离）；normalizeStringList 删除 |
| `src/stores/settingsStore.ts` | 删 aifastModels/setAifastModels；version 21 |
| `src/stores/__tests__/settingsMigration.test.ts` | v21 用例（丢弃语义） |
| `src/features/canvas/models/registry.ts` | syncCustomEndpointsFromStore 恢复单参；PROVIDER_DISPLAY_ORDER 用字面量 |
| `src/features/canvas/application/imageFallback.ts` | aifast 入链候选改 AIFAST_MODEL_NAMES；第三参删 aifastModels |
| `src/features/canvas/Canvas.tsx` | 同步点还原单参 |
| `src/components/SettingsDialog.tsx` | aifast 卡简化（静态清单只读展示） |
| `src/features/settings/ChannelHealthPanel.tsx` | reachable 按 detail 细分绿标 |
| `src/i18n/locales/zh.json` / `en.json` | reachableNoModelList；grsaiTransparentBackgroundDesc |

## 事故记录 · v0.3.2 二次黑屏热修（2026-09-11）

- 症状：0.3.2 安装后打开黑屏（0.3.1 修复版正常）
- 根因：批次9 把测试文件放在 models/image/grsai/__tests__/ 与 models/image/aifast/__tests__/，registry.ts 的模型扫描 glob（./image/**/*.ts，eager）把测试文件当模型模块打进生产包；测试文件的 vitest import 在浏览器启动期抛 "Vitest failed to access its internal state" → React 未挂载 → 黑屏
- 为何三层都没拦住：单测/启动冒烟跑在 vitest 里（该 import 合法，全绿）；tsc+vite build 不执行代码；无头 Chrome 回路只在上次发版手跑过、未固化进流程
- 修复：两处 glob 加负向排除 !./**/__tests__/**（registry.ts，带注释）；测试文件位置不动
- 构建级防泄锁：新增 scripts/check-bundle.mjs 并入 npm run build 链——扫 dist/assets 出现 vitest/__tests__ 痕迹即构建失败，此类问题以后在构建期红灯
- 验证：无头 Chrome 回路 root 8691 字符 + 0 Uncaught；npm test 40 过
- 踩坑小记：check-bundle.mjs 首版块注释里写了 **/__tests__/，其中 */ 把注释提前闭合导致 SyntaxError——注释里别写 glob 星号路径

## 批次9 补丁 · aifast 清单实证修正（2026-09-11）

> 执行：G53F。前端 + Rust，未 commit。背景=主对话用真实企业 key 对 https://picture.aifast.site 完成 smoke（key 未入任何文件/日志/测试）。

### 干了什么

真实 key smoke 实证推翻批次9 两条记录，静态清单随之修正（仍 7 个模型）：

1. **`gpt-image-2` 移除**：上游 `POST /v1/images/generations` 返回 HTTP 503 `model_not_found`（"No available channel for model gpt-image-2 under group 企业生图渠道1"）；且上游 `GET /v1/models` 实列 11 模型中无 gpt-image-2（列表与可调性一一对应）。前端删 `models/image/aifast/gptImage2.ts`，清单去名。
2. **`gemini-3.1-flash-image`（无后缀）复活加回**：批次9 记录的「403 已下架」已过时——经 chat-completions 实测 HTTP 200 出图（11.7s）。新增 `models/image/aifast/gemini31FlashImage.ts`（`createAifastGeminiModel` 工厂，displayName 照同组无后缀惯例「Gemini 3.1 Flash Image」），插入位置在 `-preview-hy` 之后、`-lite` 之前。
3. **批次9 已知风险之一解除**：`gemini-3.1-flash-image-preview-token` 经 `POST /v1/chat/completions` 实测 HTTP 200（18.9s，1024×1024 PNG），返回 content 内嵌 markdown `![image](data:image/png;base64,...)`——`submit_gemini_via_chat_completions` 的 Format 3 提取分支命中，无需 Gemini 原生分派备选方案。
4. 断言同步：`aifastCatalog.test.ts` 清单锁更新；「已下架绝不回流」锁由「无后缀 flash 不在清单」反转为「gpt-image-2 不在清单」。Rust `api666/mod.rs` `list_models` aifast 分支同步同一 7 模型（顺序与前端 modelNames.ts 一致）；juyouapi/666api 分支一字未动。

### 行为变化（协议预期，非 bug）

`gemini-3.1-flash-image` 是 CHAIN_MEMBER_MODEL_NAMES 链成员名（imageFallback.ts:40，juyouapi 档）。加回后 **aifast 静态清单与链成员出现同名** → `aifastJoinChain` 开启时 aifast 会按批次8 同名准入协议追加为链尾 extra hop。批次9 记录的「无同名 → 开关不产生 hop」不再成立。开关默认关（默认行为不变），此为同名准入协议的预期行为，仅记录不改码。

### 验证

- `cargo check` 0 错；`cargo test` 39 过（基线 39，无增减）
- `npm run build` 0 错（check-bundle 过）；`npm test` 40 过（5 aifast 清单锁全绿）
- grep 清残留：`aifast/gpt-image-2` 仅存测试负向断言（应保留）；`AIFAST_GPT_IMAGE_2` 常量与对已删文件 import 均为 0；666api/grsai 各自 gpt-image-2 文件与引用未动；Rust gpt-image-2 其余命中均属 666api 分支/通用协议分派/错误文案
- 链红线：chain.rs、aifastJoinChain 机制、settingsStore、工厂函数均未动

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/features/canvas/models/image/aifast/modelNames.ts` | 去 `gpt-image-2`、加 `gemini-3.1-flash-image`（preview-hy 与 lite 之间）；头注释补 2026-09-11 smoke 实证记录 |
| `src/features/canvas/models/image/aifast/gptImage2.ts` | **删除** |
| `src/features/canvas/models/image/aifast/gemini31FlashImage.ts` | **新增**（工厂 + 同组命名口径） |
| `src/features/canvas/models/image/aifast/__tests__/aifastCatalog.test.ts` | 清单锁 7 成员更新；下架锁反转为 gpt-image-2 |
| `src-tauri/src/ai/providers/api666/mod.rs` | `list_models` aifast 分支同步 7 模型 + 注释更新（顺序与前端一致） |
| `AGENT-BRIEF.md` | 批次9 段末加补丁指针 |

## 事故记录 · grsai gpt 系空参考图守卫误报（2026-09-11 热修）

- **症状**：真机 imageEdit 入口选 grsai/gpt-image-2 无参考图 t2i，秒报 InvalidRequest「Reference images are present but none could be encoded for GRSAI」。
- **根因链**：前端 t2i 发 `referenceImages: []`（空数组非 null）→ tauriAiGateway.ts:22 truthy 判断保留 `[]` → Rust 侧 `reference_images = Some(vec![])` → `grsai/mod.rs` `request_generate`（gpt 系路径）守卫只判「编码结果为空」，`Some(空数组)` 时循环不进、`images` 为空即误触发报错。同文件 nano 路径 `request_draw` 守卫口径正确（先判原始列表非空再判编码结果为空），链头 grsai/nano 产线正常即它守住了。
- **修法（最小改动）**：抽纯谓词 `references_all_failed_to_encode(original, encoded)`（= 原始非空 && 编码为空）替换 `request_generate` 内联守卫；`Some(vec![])` 与 `None` 一律走 t2i（images 空数组），仅「原始非空且编码全失败」报错。
- **为何批次9 漏网**：gpt 系 3 个 Rust 单测只覆盖像素表与分类分派，未覆盖 `Some(空数组)` 分支；t2i 手测当时走的可能是链模式（nano 头）或带参考图，未命中该分支。
- **本期不改前端**：gateway 的 `[] truthy` 是历史行为，其他 provider 均容忍 Some(空数组)；最小可验证改动原则，红线不动。
- **验证**：`cargo check` 0 错；`cargo test` 40 过（基线 39 + 1 新增 `gpt_reference_guard_allows_empty_and_none`：空数组放行 / 非空全败报错 / 部分成功放行三态断言；None 由控制流天然不进守卫）。npm 不涉及未跑。
- **改动文件**：`src-tauri/src/ai/providers/grsai/mod.rs`（守卫换谓词 + 新增谓词函数 + 1 单测）；nano 路径、前端 gateway、其他 provider 未动。未 commit。

## 发版 · v0.3.3（2026-09-11，主对话本地打包）

- 内容 = 0.3.2 全量 + 批次9 补丁（aifast 清单实证修正）+ grsai gpt 空参考图守卫热修。
- 版本三处对齐（package.json / tauri.conf.json / Cargo.toml，经 scripts/sync-version.mjs；Cargo.lock 由 cargo 构建期自动重写）。
- 发版纪律走查：npm run build（check-bundle ✓ 产物干净）→ 无头 Chrome 启动冒烟（root 挂载、DOM 9425 字符、0 Uncaught）→ `npm run tauri build` 本地打包。
- ⚠️ 打包入口是 `npm run tauri build`（node_modules/.bin/tauri）；`cargo tauri` 子命令不存在，且 `cargo tauri build | tail` 会吃掉非零退出码造成「exit 0 假象」。`npm run release` 走 git commit/push + GitHub Actions，与本项目不 commit 纪律冲突，本地发版不要用。
- 产物：`src-tauri/target/release/bundle/dmg/巨游美术工坊_0.3.3_aarch64.dmg`
- 待真机复测：grsai/gpt-image-2 零参考图 t2i（本次修复项）；顺带 grsai gpt 系透明底/flare/sunburst 出图与 aifast 新清单（gemini-3.1-flash-image）出图。

## 批次10 · 智能出图 pro 档链序调整（2026-09-11）

> 执行：G53F。用户拍板：嫌 pro 档 666api 打头，要 grsai nano-banana-pro（游戏资产风格最正）打头、aifast pro 档插第二——**aifast 首次成为内置链成员**。基于 0.3.3 工作区续改，未 commit、未发版（版本号未动，本期不含 0.3.3 之后已并内容以外的发版动作）。

### 新 CHAIN_T2I_PRO（6 hop，逐字）

1. grsai / grsai/nano-banana-pro（300）
2. **aifast / aifast/gemini-3-pro-image-preview（240，新增成员）**——aifast 的 pro 模型实际名带 `-preview`（`gemini-3-pro-image` 是 666api 的名字）；-token/-hy 变体不上链（专家模式不变）
3. 666api / 666api/gemini-3-pro-image（300）
4. 666api / 666api/gemini-3.1-flash-image-preview（240）
5. juyouapi / juyouapi/gemini-3.1-flash-image（240）
6. kie / kie/nano-banana-2（300）

Smoke 证据（主对话 2026-09-11 真实 key）：`gemini-3-pro-image-preview` 经 `POST /v1/chat/completions` HTTP 200 / 23.4s / 1024² PNG，与 -token 线同返回形态，应用 Format 3 提取分支覆盖。i2i 链与 t2i 标准链一字未动；build_chain 内 i2i gpt 防御过滤未动。

### 双端同步与核实结论

- **前端 `imageFallback.ts`**：`CHAIN_PROVIDER_IDS` 加 `'aifast'`（核实：仅两处消费——空链提示 + key 预注入；`resolveChainApiKey` 默认分支 `apiKeys['aifast']` 自动生效）；`CHAIN_MEMBER_MODEL_NAMES` 加 `'gemini-3-pro-image-preview'`（aifast pro 链）。连带效应：Rust `chain_member_bare_model_names()` 同样扩大——NEWAPI 端点的同名模型 `gemini-3-pro-image-preview` 现在也允许以 extra hop 进链尾（同名准入协议自然结果，双端一致）。
- **探活 `count_chain_models_ok` 核实（任务书第 3 条）**：`chain_member_models_for_provider`（commands/ai.rs:1348）**动态遍历三条链 specs 按 provider_id 过滤**，非硬编码 per 渠道 → aifast 自动计入交集计数，健康面板「N 个链上模型可用」自动正确（aifast 探活拉静态 list_models 含 `gemini-3-pro-image-preview`）。零改码。
- **aifast 入链开关文案核对（任务书第 4 条）**：i18n `settings.joinChainSwitchDesc`（zh/en:437）只描述「同名模型追加链尾」语义，未暗示「不开关就不参与链」→ 不误导，**未动**。开关语义现在精确为：aifast 配 key 即自动参与 pro 档第二顺位（不依赖开关）；开关只管 `aifast/gemini-3.1-flash-image` 同名追加链尾。
- **不变式确认（任务书第 5 条）**：① aifast 未配 key → build_chain `available_providers` 过滤自动跳过该 hop，pro 链自然降级为 grsai-pro → 666api-pro → 标准尾部（**新增单测 `quality_pro_skips_aifast_without_key` 锁定**）；② aifastJoinChain extra hop 模型名 `aifast/gemini-3.1-flash-image` 与内置 `aifast/gemini-3-pro-image-preview` 不同名，`seen` 按 (provider, model) 全串去重不冲突。

### 验证

- `cargo check` 0 错；`cargo test` **41 过**（基线 40 + 1 新增：aifast 无 key 降级不变式锁；`quality_pro_head_is_pro_model` 更新为批次10 链序并断言前三位）
- `npm run build` 0 错（check-bundle 过）；`npm test` 40 过（基线 40，无新增断言文件）
- grep 确认：CHAIN_T2I_STANDARD / CHAIN_I2I_STANDARD 与改前逐字一致；i2i gpt 防御过滤未动；aifast 静态清单/专家模式未动
- 未验证：真机智能出图 pro 档端到端（待用户重测；aifast hop 实际耗时预期 ~24s 档）

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/chain.rs` | CHAIN_T2I_PRO 重排 + 插 aifast hop（6 hop）；头注释逐字核对清单补 aifast 行；链序单测更新 + 新增无 key 降级锁；测试 helper `all_available` 加 aifast |
| `src/features/canvas/application/imageFallback.ts` | CHAIN_PROVIDER_IDS 加 'aifast'；CHAIN_MEMBER_MODEL_NAMES 加 'gemini-3-pro-image-preview' |
| `AGENT-BRIEF.md` | 批次进度行加批次10 一句 |

## 发版 · v0.3.4（2026-09-11，主对话本地打包）

- 内容 = 0.3.3 + 批次10（pro 档链序调整：grsai/nano-banana-pro 打头 → aifast/gemini-3-pro-image-preview 第二 → 666api/gemini-3-pro-image → 标准尾部 6 hop）。
- 发版纪律走查：npm run build（check-bundle ✓）→ 无头 Chrome 冒烟（root 挂载 / DOM 9425 / 0 Uncaught）→ `npm run tauri build`（BUILD_EXIT=0）。
- 产物：`src-tauri/target/release/bundle/dmg/巨游美术工坊_0.3.4_aarch64.dmg`
- 待真机复测：智能出图 pro 档（重点=第二顺位 aifast/gemini-3-pro-image-preview，smoke 实测 ~23s 出图；grsai-pro 挂掉才轮到它）；顺带 0.3.3 修复项 grsai/gpt-image-2 零参考图 t2i。
