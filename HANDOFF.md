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

## 批次11 · 画板生成图片自动上传公司 OSS（2026-09-11，全渠道统一方案）

### 干了什么

出图成功后（**所有渠道含 grsai 统一一条路，无 grsai oss-id 快车道**）自动把结果图上传公司阿里 OSS，按 `{工程名}/{yyyy-MM}/{job_id}_{provider}_{裸模型名}.{ext}` 归档（工程名中文原样；`/`→`-`、去首尾空白与点号、空兜底「未分类」；yyyy-MM 取 job 行 created_at UTC），拿到桶直链 `https://juyou-meishu.oss-cn-hangzhou.aliyuncs.com/{encoded_key}` 永久 URL。**软失败铁律**：未配凭据/数据缺失/上传失败一律一行日志返回 None，绝不影响出图。

- **Rust 新模块 `ai/oss_store.rs`**：纯 std 手写 SHA-1（RFC 3174 向量）+ HMAC-SHA1（RFC 2202 向量，期望值经 python hmac 复核）+ RFC 7231 IMF-fixdate（无 chrono，civil_from_days 算法，固定 epoch→固定串单测）；OSS V1 签名对齐 image-studio 技能 python 原型 `oss_v1_sign`，**签名交叉验证单测**（哑密钥 dummy-sk/dummy-sk-2，python 离线生成期望 base64 签名写死）；percent-encode 手写（safe='/'，与 python quote 逐字节对齐）。**铁律落地**：请求 URL 用编码 key、签名 resource 用原始未编码 key（形态不一致必 403，smoke 实证）。`upload_image` = HEAD 探测（404 才传；200=已存在直接返回 URL；网络错跳过）→ 签名 PUT（`tokio::time::timeout` 60s）；任何失败 warn 一行。配置态模块级 `RwLock<Option<OssConfig>>`，`set_oss_config` 注入（空=关闭，Rust 不持久化密钥）。
- **归档接线**：`archive_result_to_oss(app, job_id, stored, model)`（commands/ai.rs）在 **5 处成功终态**接线（submit_hop_inner 两处 / submit_generate_image_job 两处 / get_generate_image_job poll 一处）。元数据自 job 行：provider_id=实际命中渠道、created_at、request_json 快照新增 `oss_project` 字段（前端 gateway 注入，重启恢复路径归档可读）。字节来源：`file:media/` 标记走新增 `media_store::load_spooled_bytes`（读原始字节免 base64 往返，路径穿越防护同 load_from_dir）；内联 dataURL 走 `parse_base64_data_url`（media_store 三函数改 pub(crate)）。成功写回 job 行 `oss_url`（新 `set_job_oss_url`）。
- **DB**：`ai_generation_jobs` 与 `ai_generation_history` 各加 `oss_url TEXT`（jobs 走既有 PRAGMA 自愈先例；history **新增自愈块**——批次3 建的老表无痛升级）；finalize_job 的 history INSERT 带上 `record.oss_url`；`list_generation_history` 透出。
- **命令**：`set_oss_config(ak, sk)` + `test_oss_archive(access_key, secret_key)`（可选参——设置页未保存即可测当前输入值；传 1×1 PNG 到 `未分类/.connectivity-test-{unix_ts}.png`，失败人话区分 403/超时/网络不可达）。已注册 lib.rs。
- **前端**：①gateway 三个提交入口（generate/submit image/submit video）从 `useProjectStore.getState().currentProject?.name` 注入 `extra_params.oss_project`（新纯函数模块 `infrastructure/ossProjectName.ts`，清洗规则与 Rust 逐条对齐，无工程上下文不塞→Rust 兜底未分类；5 个 vitest 用例）；②settingsStore **v21→v22**（`ossArchive: { enabled(默认true), accessKey, secretKey }`，`normalizeOssArchive` 纯函数：enabled 语义=非显式 false 即默认开；3 个迁移用例）；③App.tsx hydrate 后及 ossArchive 变化时 invoke `set_oss_config`（enabled 且密钥齐备才传值否则传空清除；失败 console.warn）；④设置页新增「资产归档」分类（settingsEvents 加 'archive'；新组件 `features/settings/OssArchivePanel.tsx`：AK/SK password 框+显隐、enabled 开关、[测试连接] 显绿/红、说明文案；zh/en i18n 全 key）；⑤复制链接：`GenerationMeta.ossUrl` + Canvas 轮询 meta 带上 + ImageNode 成功角标 title 末尾加「归档直链：URL」行 + 生成记录行内「复制链接」小按钮（仅 ossUrl 非空显示，stopPropagation，navigator.clipboard 参照 GlobalErrorDialog 先例；**行容器从 button 改 div role=button 规避嵌套 button**）；⑥`commands/ai.ts`：GenerationJobStatus/GenerationHistoryEntry 加 `ossUrl`（Rust serde rename ossUrl + skip none）+ setOssConfig/testOssArchive 封装 + ports.ts 轮询状态类型同步。

### 关键判断

1. **归档时机放 succeeded 标记之前**（任务书要求）：finalize_job 从 job 行读 oss_url 落 history 台账，且本轮轮询返回的 DTO 首包即带 ossUrl，前端无需补拉。代价=成功可见最多让路上传耗时（HEAD 5s + PUT 60s 封顶，典型 <2s，对比 20-60s 生成耗时可忽略）。**一处偏离**：submit_generate_image_job 的 resumable 同步成功路径（原 1875 行）job 行在 spool 之后才 insert，归档放 insert（直接写 succeeded）之后、finalize 之前——语义等价（都在 history 台账收口前），该路径本无 update_generation_job 调用。
2. **job 行 oss_url 与 DTO 透出路径**：archive → `UPDATE ai_generation_jobs SET oss_url`（不碰 status/result，与 update_generation_job 正交）→ finalize_job 从 job 行读 → history INSERT 第 14 列；轮询成功路径 dto_from_record 从重载行带 `ossUrl`（serde rename camelCase + skip none，向后兼容）。
3. **HTTP-Date 语义**：IMF-fixdate 周几按 UTC 算，2026-09-12 实为周六——任务书示例「Fri, 12 Sep 2026」的 Fri 是笔误（python calendar 复核），单测以 python 权威值为准；签名交叉验证向量不受影响（签名只依赖字符串本身）。
4. **test_oss_archive 加可选密钥参数**（任务书签名无参）：设置页输入未保存时也能测当前值，且走同一上传路径；无参调用回落 Rust 已注入配置，兼容任务书原语义。
5. **上传复用全局 reqwest client**（connect 10s/总 300s），HEAD 与 PUT 各包 `tokio::time::timeout`（5s/60s）做硬上限，不吃满客户端 300s。
6. **工程改名语义**：新图按 job 提交时的 request_json.oss_project 快照进新目录，旧图不搬家（key 一经上传即不变）。此语义长期有效。
7. tu.jyounet.com 画廊域名不做 oss_url（非浏览器 UA 被 CF 1010 拦），oss_url 一律桶直链。

### 验证

- `cargo check` 0 错；`cargo test` **50 过**（基线 41 + 新增 9：sha1 rfc3174 / hmac rfc2202 / http-date / utc_year_month / 签名 python 交叉验证 / key 编码 / 工程名清洗 / build_key / 配置态）
- `npm run build` 0 错（check-bundle ✓）；`npm test` **48 过**（基线 40 + v22 迁移 3 + ossProjectName 5）
- grep 自查：仓库无真实 AK/SK 串（LTAI 开头 20 位；仅哑密钥 dummy-* 测试串）；grsai provider / AIProvider trait / 链逻辑零改动；未 git commit/push
- 未验证（需真机）：真实凭据下的应用内归档端到端、设置页测试连接按钮（网络部分主对话 smoke 已覆盖：PUT 200 / GET 200 / 中文目录 OK）

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/oss_store.rs` | 新增：SHA1/HMAC/HTTP-Date/V1 签名/上传/配置态 + 9 单测 |
| `src-tauri/src/ai/mod.rs` | 注册 oss_store 模块 |
| `src-tauri/src/ai/media_store.rs` | mime_to_ext/ext_to_mime/parse_base64_data_url 改 pub(crate)；新增 load_spooled_bytes |
| `src-tauri/src/commands/ai.rs` | oss_url 列（jobs+history 建表+自愈）、request 快照补 oss_project、archive_result_to_oss + 5 处接线、set_job_oss_url、set_oss_config/test_oss_archive 命令、DTO/查询透出 |
| `src-tauri/src/lib.rs` | 注册两个新命令 |
| `src/commands/ai.ts` | GenerationJobStatus/GenerationHistoryEntry 加 ossUrl；setOssConfig/testOssArchive |
| `src/features/canvas/infrastructure/ossProjectName.ts` | 新增：工程名清洗纯函数 |
| `src/features/canvas/infrastructure/tauriAiGateway.ts` | 三个提交入口注入 oss_project |
| `src/features/canvas/application/ports.ts` | 轮询状态类型加 ossUrl（×2） |
| `src/stores/settingsMigration.ts` | OssArchiveSettings 类型 + normalizeOssArchive + 迁移接线（v22） |
| `src/stores/settingsStore.ts` | ossArchive state/setter，version 22 |
| `src/App.tsx` | ossArchive 订阅 → set_oss_config 注入 effect |
| `src/features/settings/settingsEvents.ts` | SettingsCategory 加 'archive' |
| `src/features/settings/OssArchivePanel.tsx` | 新增：资产归档面板 |
| `src/components/SettingsDialog.tsx` | archive nav + 面板挂载 |
| `src/features/canvas/domain/canvasNodes.ts` | GenerationMeta.ossUrl |
| `src/features/canvas/Canvas.tsx` | 成功 meta 带 ossUrl |
| `src/features/canvas/nodes/ImageNode.tsx` | 成功角标 title 加 OSS 直链行 |
| `src/features/settings/GenerationHistoryPanel.tsx` | 行内复制链接按钮（外层行改 div role=button） |
| `src/i18n/locales/zh.json` / `en.json` | settings.archive.* 、history.copyLink/linkCopied、node.imageNode.ossLink |
| `src/stores/__tests__/settingsMigration.test.ts` | v22 迁移 3 用例 |
| `src/stores/__tests__/ossProjectName.test.ts` | 新增：工程名清洗 5 用例 |
| `AGENT-BRIEF.md` | 批次进度行补批次11 一句 |

## 发版 · v0.3.5（2026-09-11，主对话本地打包 + CI）

- 内容 = 0.3.4 + 批次11（公司资产自动归档 OSS：全渠道统一、按工程名分目录、桶直链分享）。
- 链路事实（主对话真实凭据 smoke 实证，勿重复调查）：V1 签名 PUT/公共读 GET/DELETE 全通；中文目录 key 正常；**tu.jyounet.com 是 Cloudflare 后的画廊应用**（/api/list?prefix= 按前缀列桶，图片 URL 即桶直链，非浏览器 UA 被 CF 1010 拦）→ 分享链接用桶直链 `https://juyou-meishu.oss-cn-hangzhou.aliyuncs.com/{key}`，不用画廊域名。
- 发版纪律走查：check-bundle ✓ / 无头冒烟 root 挂载 DOM 9425、0 Uncaught ✓ / BUILD_EXIT=0 ✓。
- 产物：`src-tauri/target/release/bundle/dmg/巨游美术工坊_0.3.5_aarch64.dmg`；Windows 走 tag v0.3.5 CI（commit 0aeefbf）。
- 真机走查清单（用户）：设置→资产归档填 AK/SK→测试连接显绿；出图成功角标悬停见归档直链；生成记录「复制链接」可用；关开关/断网出图不受影响；归档目录=工程名/年-月/。

## 事故记录 · grsai 裸 URL 源不归档（2026-09-12 热修）

### 现象与根因链

用户真机 0.3.5：出图成功但零归档。DB 实证：成功 job（grsai/nano-banana-pro）的 `ai_generation_jobs.result` 是**裸 http URL**（`https://file2.aitohumanize.com/file/...`，72 字节）。根因链 = 三环叠加：

1. `media_store::encode_spool` 既有语义：只物化 dataURL（解码落盘），≤64KB 源原样入库，**http URL 永不下载**（media_store.rs 测试锁定，语义未动）→ 裸 URL 原文进 result 列；
2. grsai 全系渠道都返回 URL 结果 → 智能链头 grsai 活着就命中它（与工程名注入无关，前端 oss_project 注入正常，DB 快照含 "oss_project"）；
3. 批次11 `archive_result_to_oss` 只认 `file:media/` 标记与 dataURL 两形态 → 裸 URL 走 `parse_base64_data_url` 失败 → debug 静默跳过。

### 修法（最小改动，两处）

1. **`archive_result_to_oss` 加第三种源形态 http(s) URL**（commands/ai.rs）：以 `http://`/`https://` 开头 → `ai::http` 全局 client GET 下载（单请求 `.timeout(30s)`）；非 2xx/下载失败 `tracing::warn!` 一行返回 None（软失败铁律不动）。字节魔数嗅探定 ext/mime：`oss_store::sniff_image(bytes)` 纯函数——PNG `\x89PNG\r\n\x1a\n`→("png","image/png")、JPEG `\xFF\xD8\xFF`→("jpg","image/jpeg")、WebP `RIFF`+偏移8 `WEBP`→("webp","image/webp")，嗅探不出 debug 跳过；后续 build_object_key + upload_image 路径不变。
2. **App.tsx OSS 注入归一 `effective` 形态**：`effective = enabled && ak !== '' && sk !== ''`，`setOssConfig(effective ? ak : '', effective ? sk : '')`——开关关闭即清空 Rust 侧配置。**注**：改动前代码已在用 enabled 且行为等价（旧写法 `setOssConfig(ak && sk ? ak : '', sk)` 依赖 Rust 侧任一为空即清除兜底），本次为按任务书归一为显式 effective 形态，运行行为无变化。

### 验证

- `cargo check` 0 错；`cargo test` **51 过**（批次11 基线 50 + 新增 `sniff_image_magic_bytes` 1 组：PNG/JPEG/WebP 真实魔数 + 纯文本/空/截断 RIFF → None）
- `npx tsc --noEmit` 0 错；`npm test` **48 过**（App.tsx 改动无测试面，数量不变）
- grep 自查：`media_store.rs` 零改动（`encode_spool("https://example.com/short.png").is_none()` 锁定测试原样在位）；真实密钥零出现（仅 OssArchivePanel placeholder "LTAI..." 文本）；未 git commit/push
- 未验证（需真机）：grsai 真实出图 → URL 下载 → OSS 归档端到端

### 改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/oss_store.rs` | 新增 `sniff_image` 纯函数 + 1 单测（四组向量） |
| `src-tauri/src/commands/ai.rs` | `archive_result_to_oss` 加 http(s) URL 分支 + 新增 `download_result_image`（30s 超时软失败） |
| `src/App.tsx` | OSS 注入 effect 归一 effective 形态（行为等价） |

## 批次11 补丁2 · 目录扁平化 + 图片工具栏手动补传（2026-09-12）

### 干了什么

0.3.6 真机复测：**归档链路已工作**（job 2471c622 oss_url 已写、桶内对象公网 GET 200），用户误判没传上的根因 = 画廊两层目录（工程→年-月→图）只点开一层。用户拍板两层整改：

1. **key 扁平化**：`build_object_key` 去掉 `{yyyy-MM}` 层 → `{工程名}/{唯一段}_{provider}_{裸模型名}.{ext}`（`created_at` 参数移除；工程名清洗/未分类兜底不变）。自动归档唯一段=job_id，手动补传=毫秒时间戳。`utc_year_month` 纯函数保留备用（注释已注明）。**存量旧层级对象不迁移**：桶里已有的少数 `{工程}/{年-月}/` 老对象原样留存，仅新对象走扁平 key。
2. **手动补传命令 `archive_image_manual(source, oss_project?, provider_id?, model?) -> Result<String, String>`**（commands/ai.rs，已注册 lib.rs）：源形态四种与自动归档共用抽出的 `resolve_archive_image_source`（`file:media/` 标记 / http(s) URL / **本地绝对路径 = std::fs::read + sniff_image** / dataURL）；无 job_id，key=`{project}/{unix_ms}_{provider 或 manual}_{model 裸名或 image}.{ext}`；未配凭据 → Err「请先在设置 → 资产归档 填写公司密钥」；上传失败走 `upload_image_detail` 保留上游状态码（403/超时/网络不可达人话）。软失败铁律只约束自动归档——手动命令是用户显式动作，失败必须如实报错。
3. **图片工具栏「上传归档」按钮**（NodeActionToolbar，`isExportImageNode && node.data.imageUrl` 才出，CloudUpload 图标）：无 `generationMeta.ossUrl` → 解析节点真实源调手动归档，成功 updateNodeData 写回 ossUrl + 直链自动进剪贴板 + 按钮短暂绿色态（复用 isCopySuccess 先例）；已有 ossUrl → 同按钮复用为「复制归档链接」；loading 态防连点（RefreshCw 自旋）；失败走 `showErrorDialog` 全局错误弹窗（与现有错误展示一致）；oss_project 从 `useProjectStore currentProject?.name` 经 `resolveOssProjectParam` 清洗注入（同 gateway 口径），provider/model 取 generationMeta（缺省 manual/image，Rust 侧兜底）；i18n zh/en 各 7 个新 key（nodeToolbar.uploadArchive*）。
   - **补丁2 追加（用户复测后缺口）**：按钮 gate 扩为 **exportImage 或 upload** 且有图——自己上传的图（uploadNode）也要能补传归档；源=本地绝对路径，Rust 本地路径分支已覆盖，Rust 零改动。ossUrl 存储按节点类型分字段：exportImage 沿用 `generationMeta.ossUrl`，upload 新增可选字段 `UploadImageNodeData.ossArchiveUrl`（不给上传节点挂整个 GenerationMeta——provider/model/耗时/链轨迹对上传图全是无意义语义；可选字段随 nodes_json 整体序列化+imagePool 编码，无迁移）；provider/model 上传节点不传（Rust 缺省 manual/image 已就位），工程名注入口径不变。

### 关键判断

1. **节点图池化源调查结论**：`__img_ref__:N` 编码**只存在于持久化 JSON**（projectStore `encodeImageReference`/`decodeImageReference` 仅在存取 DB 时成对生效，`Project` 类型上没有 imagePool 字段，`PersistedProject` 才有）——内存节点 `data.imageUrl` 就是真实源，且 Tauri 模式下上传与生成结果都经 `prepareNodeImage` 落盘为**本地绝对路径**（imageData.ts `prepareNodeImageSource` 返回 imagePath），故手动归档的主流源形态=本地路径，Rust 侧 `std::fs::read + sniff_image` 正面覆盖。前端不做池化反查（类型上也不成立）；万一出现 `__img_ref__`，Rust 返回「图片源不可读」人话错误，可接受软失败。
2. 源形态分派顺序（`resolve_archive_image_source`）：spool 前缀 → http(s) → 本地路径（Unix `/`、UNC `\\`、盘符 `X:\`）→ dataURL，互斥无歧义。
3. 本地路径只认魔数（png/jpg/webp），不信任扩展名——与热修 http 分支同口径；gif 等其他格式走 spool/dataURL 分支仍支持（自动归档不受影响）。
4. 手动 key 唯一段用毫秒时间戳：同图重复点击会生成新对象（时间戳不同），不做去重——补传语义就是「传一份能分享的直链」，已有 ossUrl 的节点按钮已转为复制链接，不会重复触发。

### 验证

- `cargo check` 0 错；`cargo test` **51 过 0 挂**（`build_object_key_layout` 单测更新为扁平向量 + 手动形态向量；`utc_year_month` 测试保留）
- `npx tsc --noEmit` 0 错；`npm test` **48 过**；`npm run build` 0 错（check-bundle ✓）
- grep 自查：真实密钥零出现；media_store spool 语义零改动；未 git commit/push
- 未验证（需真机）：手动补传端到端（本地路径图 → 按钮 → 桶直链复制）；旧工程 2471c622 对象不受影响

### 改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/oss_store.rs` | `build_object_key` 扁平化（去 created_at/yyyy-MM）+ 单测更新 + 模块头注释 |
| `src-tauri/src/commands/ai.rs` | 抽 `resolve_archive_image_source` 四形态共享函数 + `is_local_filesystem_path`；`archive_result_to_oss` 改走共享函数；新增 `archive_image_manual` 命令 |
| `src-tauri/src/lib.rs` | 注册 archive_image_manual |
| `src/commands/ai.ts` | archiveImageManual 封装 |
| `src/features/canvas/ui/NodeActionToolbar.tsx` | 上传归档按钮（CloudUpload）+ handleArchiveImage（补传/复制链接双态 + loading 防连点 + 全局错误弹窗）；追加：gate 扩 uploadNode，写回按节点类型分字段 |
| `src/features/canvas/domain/canvasNodes.ts` | 追加：UploadImageNodeData.ossArchiveUrl 可选字段（上传节点归档直链写回位） |

## 批次12 · 画廊集成与归档伴档（画板侧，2026-09-12）

> 画廊 Worker 侧（tu.jyounet.com 读 .meta.json 渲染卡片简介）由主对话同期实现，不在本小节。

### 干了什么

1. **应用内嵌巨游资产画廊页**：projectStore `currentPage` 路由扩 `'gallery'`（'toolbox' 先例）；App.tsx 三元路由变四分支，**进入画廊不清空 currentProjectId**——从工程进画廊、返回画布回原工程，从首页也能进。TitleBar 标题旁两个小按钮：「画廊」（Images 图标，随时可见，画廊页高亮）与「画布」（LayoutGrid，仅画廊页显示，高亮，点击 `setCurrentPage('projects')` 回画布/项目首页）；TitleBar 返回键同样覆盖画廊页（回 projects，不 closeProject）。新组件 `features/gallery/GalleryPage.tsx`：全屏页 = 窄工具栏（返回 + 标题「巨游资产画廊」+ 在浏览器中打开，openUrl 走既有 `@tauri-apps/plugin-opener`，opener:default 权限已有先例）+ `<iframe src="https://tu.jyounet.com/">`，onLoad 前 Loader2 spinner 遮罩。**tauri.conf.json csp 调查结论：`"csp": null`，无需补 frame-src，零改动。** i18n `gallery.*` 5 key（zh/en）。
2. **归档写 `.meta.json` 伴档**（画廊卡片简介数据源）：`oss_store` 新增 `ArchiveSidecarMeta`（serde camelCase，`skip_serializing_if` ——字段缺失一律省略绝不写 null：provider/model/aspectRatio/size/prompt/jobId/archivedAt 毫秒）+ `meta_sidecar_key`（=图 key + `.meta.json`）+ `upload_meta_sidecar`（复用 `upload_image_detail` 签名 PUT，content-type application/json，「URL 编码/签名原始」铁律天然继承；**伴档软失败**——失败 warn 一行返回 None，oss_url 照常返回，画廊少个简介而已）。接线两条归档成功路径：自动归档 meta 取 job 行 request_json 快照（prompt/model/size/aspect_ratio）+ provider_id + job_id，空串字段经 `non_empty_str` 省略；手动补传 provider/model 沿用 key 缺省（manual/image），prompt 等 None 全省略。新增单测 2 个：serde skip 形状断言（无 prompt 时输出无该 key 且全文无 null）、伴档 key 构造。

### 验证

- `cargo check` 0 错；`cargo test` **53 过 0 挂**（批次11 基线 51 + 伴档 2）
- `npx tsc --noEmit` 0 错；`npm test` **48 过**；`npm run build` 0 错（check-bundle ✓）
- grep 自查：真实密钥零出现；未 git commit/push
- 未验证（需真机）：iframe 内嵌加载画廊（tu.jyounet.com 非浏览器 UA 被 CF 拦的问题是服务端 Worker 侧解决，主对话同期处理；应用 WebView UA 是否放行待真机确认）；伴档 JSON 在画廊卡片实际渲染效果

### 改动文件（画板侧）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/oss_store.rs` | ArchiveSidecarMeta（serde skip）/meta_sidecar_key/upload_meta_sidecar + 2 单测 |
| `src-tauri/src/commands/ai.rs` | 自动归档与手动补传成功路径接伴档上传；non_empty_str 辅助 |
| `src/stores/projectStore.ts` | currentPage 路由扩 'gallery' |
| `src/App.tsx` | 四分支路由 + TitleBar 返回键覆盖画廊页 + GalleryPage 挂载 |
| `src/components/TitleBar.tsx` | 画廊/画布切换小按钮（Images/LayoutGrid） |
| `src/features/gallery/GalleryPage.tsx` | 新增：内嵌画廊页（工具栏 + iframe + spinner 遮罩 + 浏览器打开） |
| `src/i18n/locales/zh.json` / `en.json` | gallery.* 5 key |
| `src/i18n/locales/zh.json` / `en.json` | nodeToolbar.uploadArchive* 7 key |

## 批次12 补充 · 画廊 Worker 侧（主对话改，2026-09-13）

源码正本 ~/.agents/skills/oss-gallery/worker.js（线上=CF Worker juyou-gallery，账号 dbf129aab5007e9400c5f97db35fb3fe）：
1. **首页递归瀑布流**：/api/list?recursive=1（无 delimiter，10 页×1000 封顶，时间倒序，一级目录自推）；首页「全部」页签走递归=所有目录新图直接上首页；卡片左上角目录角标（可点击进目录）；分层模式不动。
2. **/api/meta 伴档接口**：?keys=k1,k2（≤50/批）签名 GET {key}.meta.json → {metas:{key:json|null}}；卡片简介（模型/规格 chip + 提示词一行预览）+ 灯箱完整提示词（可复制）；.meta.json 伴档从瀑布流过滤（marker 取原始 page 翻页不受影响）。
3. 本地校验：node --check ✓ / sign_test ✓ / mock 页面含 minfo/lprompt/api/meta 13 处 ✓。
4. **部署阻塞**：CF MCP token 只读（PUT 报 10000）。部署脚本 /Users/jobsff/code/xyflow/deploy-gallery.mjs 已就绪——用户放有 Workers 写权限的 API Token 到 ~/.zcode/.cf-token 后 `node /Users/jobsff/code/xyflow/deploy-gallery.mjs`（自动验证 health + 递归列举）。wrangler 登的是另一账号（9bd082…）不可用。
5. app 侧伴档字段：provider/model/aspectRatio/size/prompt/jobId/archivedAt（serde skip 缺失，无 null）。

## 画廊上线收口（2026-09-13 主对话）

- **CF 写权限打通**：ego-browser 替用户在 dash 创建账号级 token「juyou-gallery-deploy」（Edit Cloudflare Workers 模板 + 1 年期），存 ~/.zcode/.cf-token（600）。**部署实证：CF API 的 secret_text 必须带值上传（10021，按名继承不可用）**→ OSS_SECRET_KEY/ADMIN_TOKEN 从技能 .env 取值；ADMIN_TOKEN 当日轮换，新值=GALLERY_ADMIN_TOKEN（已写入 ~/.agents/skills/.env）。
- **画廊新版已上线验证**：/api/health ok；递归列举 20 图横跨 5 目录、最新=3/…_gpt-image-2.png；页面含 recursive/minfo/api/meta 逻辑。首页瀑布流=全目录新图时间倒序；卡片带模型/规格 chip+提示词预览（老图无伴档只显基础信息）；灯箱含完整提示词+复制。
- 部署脚本 deploy-gallery.mjs 已修为实战版（从 .env 读 secret 值）。

## 批次13 · 智能出图双引擎（谷歌 Gemini × GPT 系三档）+ 透明底跨渠道降级（2026-09-13）

### 干了什么

1. **前端五张模型卡平铺**（智能出图 tab）：auto/standard displayName 改「智能出图 · 谷歌 标准」、auto/pro 改「智能出图 · 谷歌 高质量」；新增 `auto/gpt-standard`「智能出图 · GPT 标准·高速」、`auto/gpt-pro`「智能出图 · GPT 高质量」、`auto/gpt-transparent`「智能出图 · GPT 透明底」（models/image/auto/ 下照 smartStandard 同构，无 extraParamsSchema，resolveRequest 返回占位 requestModel；registry eager glob 自动注册零接线）。
2. **Rust 三条新静态链**（chain.rs）：CHAIN_GPT_STANDARD=[grsai/gpt-image-2.5-flare]、CHAIN_GPT_PRO=[grsai/gpt-image-2.5-sunburst]、CHAIN_GPT_TRANSPARENT=[grsai→666api→juyouapi 的 gpt-image-2]。QUALITY_GPT_* 三常量；**R6 选链顺序**：GPT 档位判断提到 is_i2i 之前（无论有无参考图都走 GPT 链），Gemini 档位维持现状；i2i grsai gpt 防御过滤只对 Gemini 链生效（选链结果为 GPT 链时不走该过滤，透明链含参考图不被误杀，单测锁）。
3. **R1 Hop.extra_params_overlay**（Option<HashMap<String,Value>>，serde default + skip None，照 display_name 先例，旧 chain_meta_json 兼容）；HopSpec 加 const 布尔标记 transparent_overlay（HashMap 无法 const 构造），透明链三 hop 落成 `{"transparent_background": Value::Bool(true)}`——**Bool 不是字符串**（grsai as_bool() 只认 bool）。
4. **R2 overlay 合并两处**（commands/ai.rs）：抽 `apply_overlay`（None→Some、Some→逐项 insert 覆盖同名键），submit_hop_inner（换 hop 重提交）与首 hop 直接提交点（req.model 替换后、submit_task 前）都调用；meta.request 快照不烤入 overlay（保持 per-hop 语义）。3 单测。
5. **R5 同名准入同步**：chain_member_bare_model_names() 链数组补三条新链；前端 CHAIN_MEMBER_MODEL_NAMES 加 gpt-image-2 / gpt-image-2.5-flare / gpt-image-2.5-sunburst。
6. **666api/juyouapi 透明底提示词式透传**（api666/mod.rs submit_gpt_image_2_task 头部一处，submit_task/generate 两分支共用；juyouapi=Api666Provider 别名自动继承）：extra_params.transparent_background 为 bool true 或字符串 "true" → prompt 尾部换行追加透明提示词（文案/幂等关键字逐字对齐前端 transparentBackground.ts L3-4/L11-21）；幂等：prompt 小写含任一关键字不追加。grsai 侧零改动（原生 background=transparent 参数）。4 单测（追加/字符串true/假值不加/幂等）。
7. **前端档位化**（autoCapabilities + imageFallback）：ImageAutoQuality 扩五值，resolveAutoImageQuality 精确五值映射（未知兜底 standard）；isAutoImageModelId 覆盖五 id；**R3 空链防护档位化**：buildAutoImageFallback 按档位求交（gpt-transparent→[grsai,666api,juyouapi]、gpt-standard/pro→[grsai]、Gemini 档位维持五渠道全集），交集空→null（入口 ai.chainKeyRequired 拦截），绝不发占位 id；Gemini 档位行为逐字节不变（单测锁）。commands/ai.ts 与 ports.ts 的 fallback quality 联合类型同步扩五值。
8. **R4 零改动确认**：ModelParamsControls auto tab key 校验走 resolveChainAvailableProviders（五渠道全集），已覆盖 GPT 链渠道，未动。

### 验证

- `cargo check` 0 错；`cargo test` **67 过 0 挂**（批次12 基线 53 + 新增 14：chain.rs 7 / ai.rs 3 / api666 4）
- `npm run build` 0 错（check-bundle ✓）；`npm test` **56 过**（基线 48 + imageFallback.test 8）
- grep 自查：真实密钥零出现；未 git commit/push
- 主对话 smoke 实证（本批不测网络）：grsai flare/sunburst 恢复（17s/18s）；666api gpt-image-2 t2i 正常（22s），透明提示词式实测出真 RGBA（color type 6 + 角落 alpha=0）；juyouapi gpt-image-2 保留链尾（shell 测不通，应用内待真机，链降级吸收）
- 未验证（需真机）：gpt-transparent 链端到端（含参考图 i2i 编辑分支透明追加）、juyouapi gpt-image-2 实际可用性

### 改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/ai/chain.rs` | QUALITY_GPT_* 三常量 + CHAIN_GPT_* 三链 + Hop.extra_params_overlay（R1）+ HopSpec.transparent_overlay 标记 + R6 选链顺序/过滤档位化 + R5 链数组 + 7 单测 |
| `src-tauri/src/commands/ai.rs` | apply_overlay 抽函数 + submit_hop_inner / 首 hop 提交点两处合并（R2）+ 3 单测（本文件首个 test mod） |
| `src-tauri/src/ai/providers/api666/mod.rs` | submit_gpt_image_2_task 头部透明提示词追加（TRANSPARENT_BACKGROUND_PROMPT_HINT/KEYWORDS/transparent_background_requested/append_transparent_background_hint）+ 4 单测 |
| `src/features/canvas/models/image/auto/autoCapabilities.ts` | 三个新 id 常量 + ImageAutoQuality 五值 + resolveAutoImageQuality 精确映射 + isAutoImageModelId 扩 |
| `src/features/canvas/models/image/auto/gptStandard.ts` / `gptPro.ts` / `gptTransparent.ts` | 新增三张模型卡（无 extraParamsSchema，glob 自动注册） |
| `src/features/canvas/models/image/auto/smartStandard.ts` / `smartPro.ts` | displayName 改「智能出图 · 谷歌 标准/高质量」 |
| `src/features/canvas/application/imageFallback.ts` | CHAIN_MEMBER_MODEL_NAMES +3（R5）+ chainProviderIdsForQuality 档位交集域 + buildAutoImageFallback 档位求交（R3） |
| `src/features/canvas/application/ports.ts` / `src/commands/ai.ts` | fallback quality 联合类型扩五值 |
| `src/features/canvas/application/__tests__/imageFallback.test.ts` | 新增 8 单测（五值映射/模型名集合/档位求交：只配 kie→GPT null、只配 grsai→GPT 全档位非 null、Gemini 行为不变） |

## 批次14 · 抠图工具：任意高饱和纯色背景 → 连续 alpha matting（2026-09-14）

### 干了什么

纯前端批次（零 Rust 改动、零新 npm 依赖），算法源 = image-studio 技能 `_magenta_key`（scripts/image_studio.py L788-833）移植 + 去品红特化。

1. **算法模块 `src/features/canvas/application/matting.ts`**（纯函数 + typed arrays，无 canvas 依赖）：
   - `estimateKeyColor(data,w,h,x,y)`：点击点 9×9 邻域 RGB 各通道中位数（越界钳制，抗噪抗渐变边）。
   - `matteSolidBackground(data,w,h,keyColor,opts?)`：前景种子=到键色欧氏距离>fgThreshold(默认60，对应技能 chroma<5 的通用化)；种子腐蚀 1 轮（3×3 全邻域，越界按非种子=border_value 0 对齐 scipy）；**最近种子参考色用两遍 3-4 chamfer 传播**（前向左上→右下、后向右下→左上；正交步权 3、对角步 4，每像素携带最近种子 RGB，O(N) Float64Array+Uint8Array，近似技能 EDT-with-indices）；投影 alpha 逐字移植 py:816 `clamp(dot(px-bg,ref-bg)/max(|ref-bg|²,1),0,1)`；距键色<bgTolerance(30)→alpha=0、种子强制 1、alpha<0.025 清零；unmix 去污染逐字移植 py:821-823（`unmixed=(rgb-(1-α)bg)/max(α,1e-2)`、`w=clamp((α-0.8)/0.2,0,1)`、`fore=clamp(ref+w*(unmixed-ref),0,255)`），种子保原色、透明像素颜色填 ref；已有 alpha 的输入按 RGB 原样处理（straight-alpha 覆盖式输出）；w/h<3 或全图无前景种子 → 原样副本返回。退化保护：腐蚀清空种子时退回腐蚀前种子（细线目标）。
   - `parseMattingKeyColor`/`stringifyMattingKeyColor`/`read|writeMattingKeyColorFromOptions`：keyColor 兼容 `[r,g,b]` 数组 / `"[r,g,b]"` / `"r,g,b"` 三形态读写。
2. **vitest `__tests__/matting.test.ts`**（11 用例，合成 Uint8ClampedArray 无 canvas）：纯背景→alpha=0；中心目标→alpha=255 保原色；边缘 t=0.2 混色像素→alpha 精确 51/255（连续非二值，输入 alpha 被覆盖）；品红/绿/蓝三键色等价；estimateKeyColor 中位数抗噪（4/81 噪点不影响）+ 越界钳制；镂空（背景色包围洞）透；w/h<3 与无种子原样返回；seedErode 0/1 行为。
3. **工具接入**：`canvasNodes.ts` NODE_TOOL_TYPES +`matting`；`tools/types.ts` ToolIconKey/ToolEditorKind +`'matting'`，CanvasToolPlugin 新增**可选** `isApplyEnabled(options)`（按 options 禁用应用按钮，其他工具不受影响）；`builtInTools.ts` mattingToolPlugin（icon/editor='matting'、supportsNode 走公共 supportsImageSourceNode、options 初始 `{}`、execute→processTool）。
4. **`ui/tool-editors/MattingToolEditor.tsx`**（照 AnnotateToolEditor Konva Stage 结构，viewportSize 自适应）：底图 KonvaImage；点击 onMouseDown→getImagePoint 先例拿原图坐标→离屏 canvas（loadImageElement）getImageData→estimateKeyColor→写 options.keyColor；**点击即预览**：≤1024px 缩放版跑 matteSolidBackground → PNG dataURL 画到预览 KonvaImage（16px 棋盘格 fillPatternImage 模拟透明底），可反复点选重抠；顶部提示行 + 「自动取色」按钮（复用 toolProcessor 边框主导背景色估计）+ 键色 chip。
5. **`toolProcessor.ts`**：+matting 分支（loadImageElement→canvas 原尺寸 getImageData→matteSolidBackground 全分辨率→putImageData→PNG dataUrl→`{outputImageUrl}`，走 addDerivedExportNode+addEdge 现有落地链路零改动）；私有 `estimateDominantBorderBackgroundColor` **提为模块级导出纯函数**（算法逐字未动、行为字节级不变，任务书授权的签名适配，内部唯一调用点直接调函数）。
6. **NodeActionToolbar**：toolIconMap +`matting: Wand2`（lucide）、工具标签 t('tool.matting')；**NodeToolDialog**：标签/结果节点标题（toolDialog.mattingResultTitle）/编辑器宽度 1120px 档（照 annotate）/matting 编辑器分支/应用按钮 disabled 接 plugin.isApplyEnabled（未取色禁用 + title 提示 t('matting.pickFirst')）。
7. **i18n zh/en**：`tool.matting`（抠图/Matting）、`toolDialog.mattingResultTitle`、`matting.hint/autoPick/pickFirst`。

### 验证

- `npm run build` 0 错（check-bundle ✓，2,232KB 与既有阈值项同水位）；`npm test` **67 过**（基线 56 + matting 新增 11）
- `npx tsc --noEmit` 0 错；**Rust 零改动**（本批未写任何 src-tauri 文件，git status 中 src-tauri 变更均为批次13 前遗留，mtime 2026-09-13 实证）
- 未 commit/push；分层：算法 application/、编辑器 ui/，红线未动其他四工具逻辑与公共条件

### 偏离记录

- `keyColor` 在 ToolOptions 里以 `"r,g,b"` 字符串落盘（ToolOptionPrimitive 不收数组，对齐 annotate 的 stringify 惯例）；`parseMattingKeyColor` 兼容任务书数组形态，外部按 `{keyColor:[r,g,b]}` 调 processTool 同样有效。
- unmix 分母 epsilon 用任务书的 `1e-2`（技能 py 源为 `1e-5`）；因 alphaFloor=0.025 > 两者，实际像素结果零差异。
- 技能的「亮品红屏幕采样估计键色」被点击取色/自动取色替代（工具语义即人工指定键色）；技能 ValueError 两处（图片太小/无前景采样）改为原样返回副本（工具链无错误通道，宁可不动图）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/features/canvas/application/matting.ts` | 新增：算法模块（estimateKeyColor / matteSolidBackground / keyColor 解析读写） |
| `src/features/canvas/application/__tests__/matting.test.ts` | 新增：11 单测 |
| `src/features/canvas/domain/canvasNodes.ts` | NODE_TOOL_TYPES + matting |
| `src/features/canvas/tools/types.ts` | ToolIconKey/ToolEditorKind + 'matting'；CanvasToolPlugin 可选 isApplyEnabled |
| `src/features/canvas/tools/builtInTools.ts` | mattingToolPlugin 注册（数组尾部追加） |
| `src/features/canvas/ui/tool-editors/MattingToolEditor.tsx` | 新增：点击取色 + 即时预览 + 自动取色编辑器 |
| `src/features/canvas/application/toolProcessor.ts` | matting 分支 + matteImage；estimateDominantBorderBackgroundColor 提为导出纯函数（行为不变） |
| `src/features/canvas/ui/NodeToolDialog.tsx` | 标签/结果标题/1120 宽度/编辑器分支/应用禁用 |
| `src/features/canvas/ui/NodeActionToolbar.tsx` | toolIconMap + Wand2；工具标签 |
| `src/i18n/locales/zh.json` / `en.json` | tool.matting / toolDialog.mattingResultTitle / matting.* 3 key |

## 批次15 · 抠图算法科学化升级（多键色 + 影子识别 + 边缘去污染）（2026-09-14）

### 干了什么

纯前端批次（零 Rust、零新 npm 依赖），在批次14 matting 基础上的四项升级，全部由用户真机样图闭环驱动（任务书 D 项 = 本批最重要流程）。

1. **A 多键色**：`matteSolidBackground(data,w,h,keyColor|keyColors,options)` 接受 1~4 个键色（`MAX_KEY_COLORS=4`），逐像素取最近键（欧氏距离）参与背景距离 / 容差清零 / 投影 / 影子检测；调用方兼容旧单键入参形态（`normalizeKeyColors` 识别 `[r,g,b]` 单键与 `[[r,g,b],...]` 多键）。
2. **B 亮度缩放键匹配（Primatte 式影子识别）**：`s* = dot(P,K)/dot(K,K)` 钳到 [0.15,1.0]，`||P − s*·K|| < shadowTolerance`（默认 **45**，任务书建议 34 经样图迭代上调）→ 判背景。三重门防误杀（样图实证缺一不可）：
   - **色度方向门**：色度向量模长 > 4 时要求 `cos(P−gray(P), K−gray(K)) ≥ 0.9`——深棕球杆（vs 暗紫地面键色度方向正交）不被吞；
   - **键领地密度门**：41×41 邻域内该键的容差背景像素占比 ≥ 0.15（积分图实现，Primatte detail 区域离散近似）——深色头发块虽在暗紫地面键轴上但那片区域没有地面；
   - **边界连通门**：影子判定须与图边背景四连通才生效（BFS 走「容差∪影子」联合掩膜）——裙子内部的孤立影子判定被营救。
3. **C 边缘去污染**：
   - **色度轴 despill**（`_despill` 通用化）：`spill = dot(P−ref, u)`、`u = normalize(K−luma(K))`，spill>0 时收回；**过中和保护**：以像素自身灰点为界截断（`min(spill, spillSelf)`），防止品红溢出扣过头变假绿（绿 speckle 根因）；作用域 = 半透明带 0<α<0.9 + 边界带 α=1 种子（对齐 `_despill` 的 in_band 含不透明贴边像素）；
   - **半透明带 ref 强化**：unmix 信任曲线 `w=clamp((α−0.5)/0.4,0,1)`（0.8→0.5 渐入）；α<0.35 边缘像素 RGB 直接填最近种子 ref（原仅 α=0 填充）；
   - **种子保守化**：腐蚀 1→2 轮；双门 = 强前景（dist>fgThreshold×1.5，绕过腐蚀保细线）∨ 经腐蚀仍存活；**边界带种子去污染**：用「腐蚀内核」参考色对强前景绕过的边界种子先 despill，再以去污染后的种子传播参考色（绿晕/粉边根因修复）。
4. **D 真实样图闭环**：`scripts/matting-harness.mjs`（不入 src/、不进 npm test 主链）——最小 PNG 编解码（8/16-bit、colorType 0/2/4/6、filter 0-4、node:zlib；node_modules 无 pngjs 已实证）、`--keys auto|r,g,b|...`、`--max` 降采样、`--over` 合成底色检查图、`--stats` 指标、`--dump-fixture` 生成回归 fixture；node 24 原生 type-stripping 直接 import matting.ts，零构建零依赖。达标结论（Read 目视迭代 6 轮）：
   - **绿幕源**（768×1376，16-bit PNG）：自动取键 2 键（`9,210,24|6,162,29`）→ **达标**：无绿晕（发丝间也净）、脚下阴影消失、人物完整；
   - **品红渐变源**（1536×2752）：自动取键 3 键（`244,5,197|125,65,104|151,101,124`）→ **达标**：暗紫地面与脚下影子全透、无粉边，深色衣裙/马甲完整（B 项影子识别曾把裙中央/马甲成片误杀，靠三重门修复），深棕球杆完整（色度方向门修复）。

### 编辑器与接入

- **MattingToolEditor**：色板 chips（点击累加 1~4、重复点击去重、满 4 淘汰最早、点 chip 删除）；「自动取色」升级为 `sampleBorderKeyColors` 边框主色聚类（5bit/通道分桶 + 计数贪心聚类，纯色 1 键 / 墙+地面 2~4 键）；任一变更自动重抠预览。
- **toolProcessor** matting 分支透传 `keyColors`（`readMattingKeyColorsFromOptions` 兼容回落旧单键 `keyColor`）；builtInTools `isApplyEnabled` 同步 plural 读。
- **options 落盘**：`keyColors` 字段 `"r,g,b|r,g,b"` 竖线串（写时清旧 `keyColor` 字段避免双真源；读时优先 `keyColors` 回落 `keyColor`，老项目兼容）。
- **i18n zh/en**：`matting.hint` 更新为「可连续点击多个背景色（最多 4 个）」、新增 `matting.removeKey`。

### 文件规模

matting.ts 升级后 1059 行超 AGENTS.md 1000 行强制拆分线 → 键色解析/序列化/边框取键聚类拆至 `mattingKeys.ts`（257 行），matting.ts 828 行（核心算法），matting.ts 统一 re-export 既有导入路径不受影响（matting.ts 内部 import 带 `.ts` 扩展名以兼容 node 原生 type-stripping 直跑 harness）。

### 验证

- `npm run build` 0 错（check-bundle ✓，2,238.83KB 与批次14 的 2,232KB 同水位）；`npm test` **85 过**（基线 67 + 批次15 新增 18）；`npx tsc --noEmit` 0 错
- Rust 零改动（git status 中 src-tauri 变更均为批次13 前遗留，mtime 2026-09-13/14 早于本批实证）；未 commit/push
- harness 在 scripts/ 不进 src/（check-bundle 扫 dist 实证干净）

### 回归单测（+18）

多键最近匹配（双键双背景清除 / 单键对照 / 超上限截断）；s* 影子识别（0.35×键影子带清零 / 色度方向不同的棕块存活 / `shadowTolerance=0` 关闭）；despill 方向与作用域（半透明带 spill 收回 / 种子保原色 / α=0 填 ref）；种子双门（孤点弱前景不入选 / 5×5 弱块腐蚀存活 / 强前景孤点绕过腐蚀）；`sampleBorderKeyColors` 聚类（渐变+双底多键 / 纯色单键）；keyColors options 读写（四形态解析 / 截断 / 写清旧字段 / 旧单键回落）；**真实样图缩样回归**（128px fixture 内嵌 base64，`__tests__/mattingFixtureData.ts` 纯数据 + `pngDecode.ts` 测试专用解码——@types/node 缺失故用 DecompressionStream 而非 node:zlib）锁指标：边缘带最大色距 ≤90（实测 43.0/31.6）、左右边条 α=0 占比 ≥0.95（实测 1.0/0.993）、全图 α=0 占比（实测 0.703/0.732）、头部区 α>200 占比（实测 0.831/0.749）。

### 偏离记录

- `shadowTolerance` 默认 34→**45**：绿幕背景暗角（38,193,47，残差 38.4）在 34 下漏抠成绿丝，45 全清且实测两图无副作用。
- 影子识别三重门（色度方向 / 键领地密度 / 边界连通）为任务书 B/C 之外的新增机制：真机样图暴露「深色前景色度上与暗背景键轴同族」（品红图裙子/马甲/发丝块被影子识别成片误杀、球杆被吃），纯颜色判定不可解，按 Primatte detail 区域语义补空间门。
- despill 过中和保护（`min(spill, spillSelf)`）：任务书公式全额扣减会把品红混合像素扣到补色侧产生假绿 ref 污染，对齐 `_despill` 原义（只扣「超出亮度」的溢出）加界。
- 前景保护带（影子判定对真前景候选 1px 膨胀区不生效）：批次14 锁定的 t=0.2 混色环 α=51 指标与影子识别冲突（前景靠灰时混色像素天然近键轴），保护带两者兼得。
- 任务书「暗紫地面 = 品红×0.35」与实图不符：实际地面是「提亮的品红灰」（s*≈0.73-1.0，s<0.55 无真实背景像素分布），影子识别实际由多键（A 项）+ 容差覆盖，s 范围按任务书保持 [0.15,1.0]。
- 已知残留（不阻断达标）：品红图脚下亮面地板反射（色度与皮肤几乎同色，dist≈22）无法纯颜色分离，现为贴地淡反射薄雾存留；绿幕图杆尖 1px 级软边。批量验收以任务书两图达标线为准。
- 主对话验收轮修复（2026-09-14）：① 品红图手臂浅带/浅斑 = 阴影皮肤细褶皱（到键距离刚过阈值 1-2px）经 seedErode=2 腐蚀整条失去种子 → 投影 α≈0.5 半透明浅带；修法 = seedErode 默认 2→0（全部候选入选，混色排除交给种子去污染），种子去污染改为「细结构才自中和」——needs 掩膜（spillSelf>40 且 cos≥0.6）经腐蚀 3 轮+膨胀回补的形态学开运算裁决，厚区域肤影保留、薄区域绿丝/混色带一次中和到位。② 绿幕图头顶发丝绿丝 = 链式部分校正残留（ref 本身偏绿时欠校正）；随上述自中和一次到位解决。③ 品红图脚下地板反射薄雾：知悉接受（色度与皮肤 dist≈22 不可分）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/features/canvas/application/matting.ts` | 升级：多键色 / s* 影子识别三重门 / despill+过中和 / ref 强化 / 种子双门+边界带去污染（828 行） |
| `src/features/canvas/application/mattingKeys.ts` | 新增：键色解析/序列化/边框取键聚类（257 行，matting.ts re-export） |
| `src/features/canvas/ui/tool-editors/MattingToolEditor.tsx` | 色板 chips 1~4 + 自动取色聚类 + 多键预览 |
| `src/features/canvas/application/toolProcessor.ts` | matteImage 透传 keyColors |
| `src/features/canvas/tools/builtInTools.ts` | isApplyEnabled 多键读 |
| `src/i18n/locales/zh.json` / `en.json` | matting.hint 更新 + matting.removeKey |
| `src/features/canvas/application/__tests__/matting.test.ts` | +18 用例（多键/s*/despill/双门/聚类/options/样图回归） |
| `src/features/canvas/application/__tests__/mattingFixtureData.ts` | 新增：真实样图 128px fixture 内嵌 base64（纯数据） |
| `src/features/canvas/application/__tests__/pngDecode.ts` | 新增：测试专用最小 PNG 解码（DecompressionStream，无 node API） |
| `scripts/matting-harness.mjs` | 新增：真实样图闭环 harness（PNG 编解码 + 自动取键 + 指标 + fixture 导出；不入 src/） |

## 批次15a · 品红管线回归修复（2026-09-14，主对话验收）

- 用户真机反馈：v0.4.2 绿幕很好、品红反不如 v0.4.1。裁决=按键色组自动路由管线：`isGreenKey`（g−max(r,b)≥25）全绿键→批次15 完整管线；任一非绿→**v0.4.1 温和管线**（seedErode=1/无 despill/无影子门/无自中和/unmix 0.8）+ 多键最近匹配基建共享。编辑器零改动，美术零感知。
- 硬校验：gentle 与批次14 内联参考实现**逐像素 RGBA 全等**（两合成场景）；绿幕回归无回潮。npm test 110 过。真实样图四轮目视验收存档 /tmp/matting-verify/。
- 遗留裁决：matting.ts 1079 行超 1000 行拆分线（绿管线可拆独立模块）——暂缓，后续安静批次再拆。
- 并行说明：本修复与批次16（AI 抠图）并行执行，文件白名单隔离（修复只碰 matting*/tests/harness，文档由主对话统一回写）。

## 批次16 · AI 抠图工具（内网 SAM-HQ，独立第六工具）（2026-09-14）

### 干了什么

与「抠图」（键色 matting）并列的独立新工具：内网 SAM-HQ 两段式（embed/decode）点选式抠图。
**不动 matting.ts / MattingToolEditor 一字**；键色抠图另有管线路由（见批次16 补充·matting 管线路由）。

1. **Rust 代理 `src-tauri/src/commands/sam.rs`**（内网服务无 CORS 头，必须走 reqwest）：
   - `sam_health(base_url)`：GET /api/sam/health，5s 超时，透传 ok/service/version/device/models/max_upload_mb；
   - `sam_embed(base_url, image_base64, model)`：multipart（字段 file+model）→ 60s 超时 → `{embedId, model, width, height, cached}`；
   - `sam_decode(base_url, embed_id, model, points)`：JSON POST（点=原图像素 [x,y,label]）→ 30s → 蒙版 PNG base64；
     **404（embed expired）以结构化错误 kind=embed_expired 传给前端**（触发自动重 embed + 重放全部历史点）；
   - 全局 http client（ai::http）+ 按接口限超时；参数校验纯函数（base_url 归一化/模型白名单/点格式）+ 5 单测。
2. **前端桥 `src/commands/sam.ts`**：三个 invoke 封装 + `SamServiceError`（kind: network/http/bad_request/embed_expired/service）。
3. **纯函数编排 `src/features/canvas/application/aiMatting.ts`**：点列表增删/清空、`pointsToTriples`、
   `decodeMaskWithRecovery`（404 → 重 embed → **重放全部历史点一次**，只重试一次）、
   `upsampleMaskBilinear`（手写双线性，256→原图尺寸）、`featherMask`（1px 盒式羽化）、`maskForegroundRatio`（全黑检测）。
4. **编辑器 `ui/tool-editors/AiMattingToolEditor.tsx`**：进入先 sam_health（不通→人话提示+[重试]，通→自动 embed vit_t）；
   左键=正点(1)、右键=负点(0)（onContextMenu preventDefault）；点变更自动 decode（请求序号防并发）；
   点 chips（正绿负红可删）+ 清空；模型切换 vit_t/vit_b（重新 embed，已有点保留并自动重 decode）；
   蒙版全黑提示；蒙版预览 = 原图经羽化蒙版 destination-in 合成叠棋盘格底；
   应用 = 原尺寸合成（蒙版双线性放大回原图 + 1px 羽化 + putalpha）写 options.aiMattingResultDataUrl；
   超大图（长边>4096）embed 前等比降采样上传（蒙版放大回原尺寸，输出不降分辨率）。
5. **工具注册**：NODE_TOOL_TYPES.aiMatting（'ai-matting'）；ToolIconKey/ToolEditorKind +'aiMatting'（lucide Scan）；
   builtInTools aiMattingToolPlugin（isApplyEnabled=有合成结果）；NodeToolDialog 宽度/编辑器/结果标题/应用提示分支；
   NodeActionToolbar toolIconMap + 工具标签；toolProcessor aiMatting 分支（校验并透传编辑器合成结果）。
6. **设置**：settingsStore v22→v23 新增 `aiMattingBaseUrl`（默认 `http://192.168.1.188:8760`，normalize 纯函数+3 单测）；
   设置页「资产归档」分类下新增 AiMattingServicePanel（地址输入即时落 store + 测试连接）。

### 本机联调结论（内网可达，实测 2026-09-14）

- health：`{"ok":true,"service":"sam-hq-matting","version":"1.0","device":"directml","models":{"vit_t":true,"vit_b":true}}` ✓
- embed vit_t（真实样图降采样 512×917）：92ms，返回 embed_id + 原图尺寸；同图重 embed `cached:true`（内容哈希去重）✓
- decode：25ms，256×256 灰度 PNG ✓；多点（正+负）decode ✓；单点前景占比 0.076（人物半身占画面比例合理）
- vit_b 换模型重 embed ✓（编码不通用已实证）；404 `{"ok":false,"error":"embed expired"}` ✓（前端自动恢复路径依赖此响应）
- 恐龙基准（文档 0.633）无对应测试图未复跑；已用真实样图建立等效回归（前景占比 + 端到端流程）

### 验证

- `cargo check` 0 错；`cargo test` **72 过**（基线 67 + sam 新增 5）
- `npm run build` 0 错（check-bundle ✓）；`npm test` **110 过**（基线 86 + 批次16 新增 24：aiMatting 12 + v23 迁移 3 + 描述性断言迁移调整）
- Rust 零业务改动（sam.rs 为新增命令模块）；不 commit/push

### 走查清单（联调排错速查，源：API 文档第五节）

| 现象 | 处理 |
|---|---|
| 连不上/超时 | 服务停用；设置页地址核对；面板 `schtasks /Run /TN "SAM-HQ Matting"` |
| health models 有 false | 模型文件缺失/未加载，查服务端 sam_server.log |
| 404 embed expired | 前端已自动重 embed + 重放点；若频发=缓存被挤（64 条 LRU）或服务重启 |
| 400 model 校验 | 只允许 vit_t / vit_b |
| 400 points 校验 | 每点必须 [x, y, 0或1]，至少 1 个点 |
| 蒙版全黑 | 前端已提示「试点主体中心或多加正点」 |
| 抠出局部细节 | 用了 vit_b，换 vit_t 重新 embed |

### 改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/sam.rs` | 新增：SAM-HQ 代理三命令 + 参数校验 + 5 单测 |
| `src-tauri/src/commands/mod.rs` / `src-tauri/src/lib.rs` | 注册 sam 模块与三命令 |
| `src/commands/sam.ts` | 新增：invoke 封装 + SamServiceError |
| `src/features/canvas/application/aiMatting.ts` | 新增：点管理 / 404 恢复编排 / 蒙版放大羽化 / 前景占比（纯函数） |
| `src/features/canvas/application/__tests__/aiMatting.test.ts` | 新增：12 单测 |
| `src/features/canvas/ui/tool-editors/AiMattingToolEditor.tsx` | 新增：点选式编辑器 |
| `src/features/canvas/domain/canvasNodes.ts` / `tools/types.ts` / `tools/builtInTools.ts` | 工具注册 |
| `src/features/canvas/ui/NodeToolDialog.tsx` / `NodeActionToolbar.tsx` | 宽度/编辑器/结果标题/图标/标签分支 |
| `src/features/canvas/application/toolProcessor.ts` | aiMatting 分支（透传编辑器合成结果） |
| `src/stores/settingsStore.ts` / `settingsMigration.ts` | v23 aiMattingBaseUrl + normalize 纯函数 |
| `src/stores/__tests__/settingsMigration.test.ts` | +3 v23 迁移单测 |
| `src/features/settings/AiMattingServicePanel.tsx` / `SettingsDialog.tsx` | 服务地址面板 + 挂载 |
| `src/i18n/locales/zh.json` / `en.json` | tool.aiMatting / toolDialog.aiMattingResultTitle / aiMatting.* / aiMattingService.* |

## 事故记录 · AI 抠图 embed「异常载荷」误报（2026-09-14，主对话修复）

- **症状**：真机 AI 抠图必报「embed 失败：服务返回异常载荷」。
- **根因**：`sam.rs` 三个响应结构体挂了 `#[serde(rename_all = "camelCase")]`，而 SAM 服务返回 snake_case（`embed_id`/`vit_t`/`max_upload_mb`）→ serde 找不到 `embedId` 走 default 空串 → `embed_id.is_empty()` 误判「异常载荷」。health 误报被掩盖（只看 ok 字段）。集成测试当时用 curl 验的服务端、单测没覆盖真实响应原文——两层都漏。
- **诊断法**：本机 curl 同图成功 → 临时 Rust 探针走 `sam_embed` 命令本体复现 Err → 二分隔离（字节往返 ✓ / 全局 client ✓）→ 锁定解析层 → 原始响应体抓包实锤 snake_case。
- **修复**：响应结构体去 camelCase（服务端说什么就收什么）；`SamModelsStatus` rename+alias 双兼容（de 吃 vit_t / ser 吐 vitT 给前端）；错误透传服务端 `error` 原文（不再吞）；3 个真实响应原文回归锁。
- **验证**：cargo test 75 过；探针走命令本体 Ok 断言通过（同图同路径由 Err 转 Ok）。测试已随探针清理，回归锁留在 sam.rs。
- **教训**：跨语言代理层的集成测试必须用**真实响应原文**做解析断言，不能只测服务端可达（curl 通 ≠ 命令通）。

### 客户端蒙版增强（批次16 追加，纯前端）

服务端只回 256×256 蒙版，直接双线性放大有块状边/发丝孔洞；客户端过渡优化（不改服务端协议），
decode 后链路升级为：**fillMaskHoles → upsampleMaskGuided → featherMask（1px 羽化）**，默认全开无设置项。

1. **`fillMaskHoles(gray,w,h)`**（aiMatting.ts）：四边界背景泛洪 BFS，不可达边界的背景区=孔洞填前景
   （修头发黑斑/四肢碎裂）；4 单测（封闭孔洞/开放凹角/全背景/全前景）。
2. **`upsampleMaskGuided(mask256, guideRgba, guideW, guideH, radius=8, eps=1e-3)`**：以原图亮度为引导 I 的
   引导滤波（局部线性模型，box filter 积分图 O(N)）上采样，边缘按图像结构对齐；超大图内部自动
   降采样到 ≤6M 像素工作域滤波后再放大回原尺寸（radius 按比例换算），不崩内存；4 单测
   （边缘位置钉在引导边缘 ±1px、单步跃变陡于双线性、无结构域退化平滑、大图网格图不崩）。
3. **自动布点**：编辑器新增「自动布点」按钮——`generateAutoPoints`（中心 + 3×2 偏内 4 点，
   与既有正点按 6% 对角线去重，返回新增点）→ 点变更 effect 自动 decode；3 单测（数量/去重/钳制）。
4. **联调数字**（真实服务 + 512×917 样图单点 vit_t）：256 蒙版孔洞填充 2px；前景占比 plain/guided 均
   0.076（无整体偏移）；边缘最大单步跳变 plain 127 → guided 228（边缘对齐图像结构约 2 倍陡）；
   羽化后 0-255 全域。i18n：aiMatting.autoPlace。

## 批次16b · SAM-HQ 服务端升级兼容化 + BiRefNet 一键去底（2026-09-14）

背景：内网 SAM 服务升级 v1.1（蒙版 256→1024、补 vit_l 档规划、新增 BiRefNet 全分辨率 RGBA 端点，
参考 xyflow/SAM-HQ-升级方案.md）。本批 = 前后兼容适配（新旧服务都可用）+ BiRefNet 零交互工具落地。
**不动 matting.ts/MattingToolEditor 一字**；AiMattingToolEditor 只动兼容三处，点选业务逻辑零改动。

### 服务端升级兼容化（新旧服务双路径都工作）

1. **蒙版尺寸动态化**：`AiMattingToolEditor` 删 `MASK_SIZE=256` 常量（grep 全清）；
   `decodeMaskWithRecovery` 的 decode 回调改返 `DecodedMask{mask,width,height}`（PNG 实际宽高透传），
   下游 `fillMaskHoles`/`upsampleMaskGuided` 宽高参数接它——旧服务 256 / v1.1 1024 蒙版均自适应。
2. **灰度通道健壮化**：新纯函数 `rgbaToGrayLuminance`（0.299R+0.587G+0.114B 取整）替换「取红通道」——
   灰度蒙版逐像素等价（单测锁），RGB/RGBA 彩色载荷更稳（纯红蒙版旧读法 255 全前景 → luminance 76）。
3. **模型档自适应**：Rust health `models` 改吃 `HashMap<String,bool>` 动态透传
   （`resolve_model_list`：enabled 过滤 + vit_t/vit_b/vit_l 固定序 + 未知档字典序排后）；
   前端 `SamModel` 放宽为 string（运行时以 health.models 为唯一真相源）；
   编辑器按 health.models 动态渲染切换按钮（缺失/空兜底 [vit_t,vit_b]，旧服务零变化），
   当前档被服务端下线时 `pickEffectiveModel` 自动落可用档首项并重 embed；
   Rust 白名单补 vit_l（仅兜底防拼写错误）。命名：vit_t 整体（快）/ vit_b 细节（HQ）/ vit_l 高召回（大模型）。
4. **服务信息透出**：health DTO 补 `birefnet`/`maskSize`（旧服务缺省 false/256）；
   设置页 AiMattingServicePanel 连通后补一行小字 `device · models · BiRefNet ✓/✗ · mask 1024`。

### BiRefNet 一键去底（第七个工具，零交互 immediate 形态）

- **形态取舍**：BiRefNet 全分辨率软 alpha、零交互、单张 ~0.3s——开对话框只剩一个「应用」按钮，
  纯增加一次点击。故 `CanvasToolPlugin` 新增可选 `immediate` 标记（`editor` 改可选）：
  工具条按钮点击即执行（按钮 loading 转圈），结果复用 NodeToolDialog 既有落地链路
  （prepareNodeImage → addDerivedExportNode + addEdge 建新节点连线），失败 showErrorDialog。
  无编辑器插槽，NodeToolDialog/EditorKind 零改动。
- **Rust**：`biref_matting` 壳正式注册进 lib.rs；错误人话映射 `map_biref_error`
  （503=BiRefNet 模型未加载（服务端）/ 413=图片超过 50MB / 其他=AI 去底服务不可用：…）。
- **前端链路**：NODE_TOOL_TYPES.aiBirefMatting（'ai-biref-matting'）→ builtInTools 插件
  （immediate:true，supportsNode 同其他抠图工具）→ NodeActionToolbar immediate 分支（Eraser 图标，
  title「一键 AI 去底（需内网）」）→ toolProcessor 分支：persistImageLocally → loadImageElement
  → 长边 >4096 等比降采样（`resolveSamUploadSize` 纯函数，与 SAM embed 同约束）→ birefMatting
  → RGBA dataURL 直返（不经抠图二次处理）。
- **i18n**：tool.aiBirefMatting / toolDialog.aiBirefMattingResultTitle / aiBirefMatting.{buttonTitle,failed,offline}（zh/en）。

### 验证

- 真实服务 v1.1 curl 实测：health `birefnet:true, mask_size:1024` ✓；BiRefNet multipart `file`
  字段 200/0.11s/RGBA PNG（colortype 6）全尺寸直返 ✓
- `cargo check` 0 错；`cargo test` **81 过**（基线 75 + 6：vit_l 白名单/升级 health 解析/models 排序/
  biref 壳校验/错误映射/v1.1+旧版 health 双 payload）
- `npm run build` 0 错（check-bundle ✓）；`npm test` **136 过**（基线 121 + 15：luminance 3/
  模型自适应 3/蒙版尺寸透传 1/biref 工具注册 5/上传尺寸 3）
- 不 commit/push；CORS 代理路线不脱（记录在案）；BiRefNet 按钮不接编辑器、aiMatting 点选路径零行为变化

### 改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/sam.rs` | models HashMap 动态化 + resolve_model_list；health DTO +birefnet/mask_size；白名单 +vit_l；biref_matting 落地（map_biref_error 人话映射）；+6 单测 |
| `src-tauri/src/lib.rs` | 注册 biref_matting |
| `src/commands/sam.ts` | SamModel 放宽 string；SamHealthInfo models:string[]+birefnet/maskSize；birefMatting 封装 |
| `src/features/canvas/application/aiMatting.ts` | DecodedMask 尺寸透传；rgbaToGrayLuminance；resolveAvailableModels/pickEffectiveModel；resolveSamUploadSize |
| `src/features/canvas/application/toolProcessor.ts` | aiBirefMatting 分支（降采样→birefMatting→RGBA dataURL） |
| `src/features/canvas/ui/tool-editors/AiMattingToolEditor.tsx` | 兼容三处：MASK_SIZE 全清接实际宽高 / luminance 灰度 / 模型档 health 驱动 |
| `src/features/canvas/domain/canvasNodes.ts` | NODE_TOOL_TYPES.aiBirefMatting |
| `src/features/canvas/tools/types.ts` / `builtInTools.ts` | immediate/editor 可选插槽 + aiBirefMattingToolPlugin |
| `src/features/canvas/ui/NodeActionToolbar.tsx` | immediate 分支（点击即执行/转圈/落节点/错误弹窗）+ Eraser 图标 + 标签 |
| `src/features/settings/AiMattingServicePanel.tsx` | health 小字：device · models · BiRefNet ✓/✗ · mask 尺寸 |
| `src/i18n/locales/zh.json` / `en.json` | aiMatting.modelLarge；tool.aiBirefMatting / toolDialog.aiBirefMattingResultTitle / aiBirefMatting.* |
| `src/features/canvas/application/__tests__/aiMatting.test.ts` | +7 单测（luminance/模型自适应/尺寸透传/上传尺寸） |
| `src/features/canvas/tools/__tests__/aiBirefMattingTool.test.ts` | 新增：5 单测（注册/immediate 形态/supportsNode/排序/execute 透传） |

## 批次16c · AI 抠图负点改「橡皮擦硬清除」+ 下线 vit_b 细节档（2026-09-14）

> 用户真机反馈两项：① 右键负点「没感觉出有啥用，背景照样没被清除」；② vit_b（细节 HQ）点击漂移、无用处，裁决取消。纯前端，Rust 零改动，未 commit。

### 根因实证（内网 v1.1 服务 curl A/B，勿重复调查）

- **SAM 负点是软约束且在本场景失效**：合成透明 sprite 图（服务端白底合成后）实测——单正点蒙版 **94.4% 全图前景**（白底图上 SAM 把整图圈成一个物件）；加 1 负点仅 94.4%→93.7%，**负点位置仍是前景**；普通照片图同理（99.8%→99.85% 几乎零变化）。负点加多后蒙版**不可控崩塌**（2 负点 → 2.4%）。中间不存在平稳可用区间——「右键排除」在服务端协议层就不成立。
- **vit_b 漂移**：API 文档二节早有实测（同一点 vit_t 覆盖 63%、vit_b 只圈 0.3% 局部），用户感知即「漂移/没用」。
- **连带发现 busy 竞争 bug**：点变更 effect 在 `busy !== ''` 时直接 return 且依赖数组无 busy——decode 进行中点的新点被静默丢弃、事后不补发。

### 修复（负点语义改为客户端硬清除）

1. **负点不再传服务端 decode**（`runDecode` 过滤 `label===1`）——正点驱动 SAM 蒙版保持稳定，负点从「无效的软提示」变为「确定性的橡皮擦」。
2. **`applyNegativeClears`（aiMatting.ts 新纯函数）**：最终 alpha 上以每个负点为圆心强制清除，半径 `negativeClearRadius` = 对角线 5%、下限 24px；0.7r 内清零、0.7r~r 线性渐变边。点哪清哪，可预测、绝不影响蒙版其余部分。
3. **编辑器重构**：decode 成功的服务端原生蒙版缓存进 `serverMaskRef`——**仅负点变化时走本地重合成（免网络、即时响应）**；正点/embedId 变化才重新 decode。
4. **busy 竞争修复**：effect 依赖加 `busy`（busy 结束自动补跑）；`lastAttemptSigRef` 记「已发起」签名（decode 失败不死循环）；`lastDecodedPositiveSigRef` 区分「正点变了→decode」与「仅负点变了→本地重合成」；`handleClearPoints` 重置三 ref。runEmbed 删显式 runDecode（统一由点变更 effect 驱动，消重复请求）。
5. **画布可见性**：负点位置绘制红色半透明清除圈（与 `applyNegativeClears` 同半径口径），「点哪清哪」所见即所得。
6. **下线 vit_b**：`FALLBACK_MODELS=['vit_t']`；`resolveAvailableModels` 过滤 `RETIRED_MODELS=['vit_b']`（vit_l 等新档自动出现）；`modelDisplayName` 删 case；i18n 删 `aiMatting.modelFine`（zh/en）。Rust 白名单与服务端不动（服务端仍支持，仅前端无入口）。
7. **i18n hint 更新**（zh/en）：「右键点=橡皮擦强制清除该处」。

### 验证

- `npx tsc --noEmit` 0 错；`npm run build` 0 错（check-bundle ✓）；`npm test` **139 过**（基线 136 + 负点清除 3，模型自适应 3 用例改写）
- **真实服务端到端**（node 直跑 aiMatting.ts，type-stripping）：sprite 合成图 embed → decode 只发正点 → fillMaskHoles → guided → feather → applyNegativeClears——阴影中心负点 255→0、空白区负点 255→0、sprite 主体保持 255、圈外保持；diff 目视圆形渐变边正确
- Rust 零改动（未跑 cargo）；未 commit/push
- 未验证（需真机）：应用内右键清除的实际手感（半径 5% 对角线是否合适，后续可调 `negativeClearRadius`）

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/features/canvas/application/aiMatting.ts` | `negativeClearRadius`/`applyNegativeClears` 新增；FALLBACK_MODELS 缩为 ['vit_t']；resolveAvailableModels 过滤 RETIRED_MODELS |
| `src/features/canvas/ui/tool-editors/AiMattingToolEditor.tsx` | runDecode 只发正点 + serverMaskRef 缓存；postProcess 抽出（负点本地重合成）；点变更 effect 重写（busy 补跑 + 双 sig 去重）；runEmbed 删显式 decode；画布负点清除圈（Circle）；modelDisplayName 删 vit_b |
| `src/features/canvas/application/__tests__/aiMatting.test.ts` | 模型自适应 3 用例改写（vit_b 过滤）；+3 负点清除用例（半径口径/三区段清除/多点叠加） |
| `src/i18n/locales/zh.json` / `en.json` | aiMatting.hint 语义更新；删 modelFine |

## v0.4.8 · AI 抠图左右对比 + 左图缩放平移（2026-09-14，计划批准后小票执行）

单画布预览整幅盖住原图（主体没点全就看不见）→ viewport 改双面板：左「原图 · 点选」（原图永不遮挡、点标记/清除圈/点击交互；滚轮锚点缩放钳 [fit,8×] + 拖拽平移 + 复位按钮，嵌套 Group 视图变换×fit 令 getImagePoint 零改动，标记尺寸 ÷viewScale 视觉恒定）；右「抠图预览」（只读，**镜像左图视图变换**保持逐像素对齐，规格原为静态 fit、实现时改为镜像属语义升级）。加点 onMouseDown→onClick（防拖拽误点）。tsc 0/npm 139/build ✓。dmg 已出。

## v0.4.9 · 工具条双行 + 删复制按钮（2026-09-14，小票执行）

NodeActionToolbar：删 image-copy 按钮+handleCopyImage+isCopySuccess+copyImageSourceToClipboard（全仓单引用，连 commands/image.ts 函数本体删除；Rust 命令未动）；分镜文案/复制报错/归档按钮不动。工具拆两行：**第二行核心 = 裁剪/AI 抠图/AI 去底（CORE_TOOL_IDS 用 NODE_TOOL_TYPES kebab-case 常量）**，第一行 = 其余工具+全部常驻按钮；组空不渲染空行；位置仍走 nodeToolbarConfig 零改动。i18n 删 nodeToolbar.copy。v0.4.9 已正式发版（commit 90e5aa9 + tag + CI 全绿 + GitHub Release exe）。

## v0.4.10 · 巨游API 四个 gpt 系模型 smoke 实证 + 接入三条 GPT 链尾（2026-09-15）

用户上游（juyouapi base=192.168.1.188:8317）新增四模型；**smoke 先行全绿**（/v1/models 34 模型在册；四模型 t2i 200/18-24s 同步 b64_json PNG 1254²；flare i2i 走 multipart /v1/images/edits 200/24.4s；**裸 base+/v1 直拼、同步无轮询**）→ 全部落地零跳过：

- 前端 juyouapi 新增三卡（gptImage25/Flare/Sunburst，照 gptImage2.ts，提示词式透明 schema，9 比例 1K/2K/4K，**定价不设**）；imageFallback `GPT_SINGLE_CHAIN_PROVIDER_IDS` ['grsai']→['grsai','juyouapi']（GPT 标准档交集域，防只配巨游被空链挡）、CHAIN_MEMBER_MODEL_NAMES 补 gpt-image-2.5。
- Rust：list_models 新增独立 juyouapi 分支（else 分支留给运行时 newapi 端点）；**submit_task/generate 两处路由闸门 `=="gpt-image-2"` 扩为「或 starts_with("gpt-image-2.5")」+ submit_gpt_image_2_task 模型名随请求透传**（规格外必要扩展：不扩则新模型全 ModelNotSupported；666api 线上字节不变）；chain.rs 三条 GPT 链尾各追加巨游 hop（STANDARD→flare、PRO→sunburst、TRANSPARENT→hop_transparent(gpt-image-2.5, 240)）+ 无 key 自动降级不变式锁。
- cargo 82 / npm 140 全绿；key 仅用于 curl 未入仓。打包 0.4.10 走新流程：**open dmg 弹安装窗口即停**（不退旧版/不覆盖安装）。

## v0.4.11 · GRSAI 添加裸 gpt-image-2.5（2026-09-22）

用户上游确认：grsai 的 flare/sunburst 均维护中，裸 `gpt-image-2.5` 可用，要求添加。改动极小（1 新文件 + 1 Rust 文件）：

- 前端 `models/image/grsai/gptImage25.ts` 新增：照 flare 卡同构（id='grsai/gpt-image-2.5'、13 比例×1K/2K/4K、quality 五档复用 `GRSAI_GPT25_QUALITY_KEY`、透明底 `transparent_background` 照 gpt-image-2 卡样式、**定价不设**——官方点数未知宁缺毋错）。registry eager glob 自动注册零接线。
- Rust `grsai/mod.rs`：SUPPORTED_MODELS 10→11、list_models +1；**normalize_requested_model 核实零改动**——`grsai_gpt_class` 用 `starts_with("gpt-image-2.5")` 前缀判断，裸 2.5 天然命中 multi 三档表（GRSAI_GPT_PX）+ quality 白名单 + 透传（不会被 nano 归一化改写）。gpt_class_dispatch 测试补裸模型断言。
- 红线：不加链（grsai gpt 慢线铁律，仅专家单点）、flare/sunburst/gpt-image-2 零改动、报价锁不含裸 2.5 未动。cargo 82 / npm 140 全绿。dmg 0.4.11 新流程弹窗交付。
