//! 自动降级链（渠道可靠性升级 · 模块 B）。
//!
//! 移植自 image-studio 技能的 run_chain 机制：一次生成按"价格优先"有序链逐档尝试，
//! 失败自动降下一档，job_id 全程稳定（前端轮询协议不变，app 重启可续）。
//!
//! 分层约定：链是任务编排层（commands/ai.rs）的策略，不进 ProviderRegistry——
//! Registry 只做名字路由，被 reverse_prompt / craft_image_prompt 等所有调用方共用。
//!
//! 模型 id 逐字核对记录（2026-09-10，双端 grep 确认）：
//! - `grsai/nano-banana-2` / `grsai/nano-banana-pro`：前端 registry 与 grsai provider SUPPORTED_MODELS 完全一致
//! - `666api/gemini-3.1-flash-image-preview`：前端 api666/gemini31FlashImagePreview.ts 与 Rust list_models 一致
//! - `666api/gemini-3-pro-image`：前端 requestModel 实发名（api666 对任意 `666api/gemini-*` 前缀透传）
//! - `juyouapi/gemini-3.1-flash-image`：前端与 Rust list_models 一致
//! - `kie/nano-banana-2`：前端与 Rust list_models 一致
//! - `aifast/gemini-3-pro-image-preview`（批次10 进链）：aifast 静态清单成员，真实 key smoke 实证可调
//!
//! 铁律（源自 image-studio 渠道情报，2026-09 实测）：
//! - grsai 网关 gpt 系 i2i 是慢线不可生产 → **grsai gpt-image* 永不入 i2i 链**（build_chain 防御性过滤）
//! - 参考图跨链成员复用安全：grsai/api666/kie 均接受本地路径参考图（前端 persistImageLocally 管线）
//!
//! timeout_hint_s 为本批落库的数据字段（hop 级时限参考，批次3 可用于细化 deadline）；
//! 本批实际超时由批次1的全局治理兜底（http 300s / kie 10min / poll 3 连错 / 15min 总上限）。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::ai::{GenerateRequest, ProviderRegistry};

/// 质量档位（前端"智能出图"五档；gpt-2.5 low~max 透传档不进链）。
pub const QUALITY_STANDARD: &str = "standard";
pub const QUALITY_PRO: &str = "pro";
/// 批次13：GPT 系三档（选链优先级高于 i2i 判定，见 build_chain 注释 R6）。
pub const QUALITY_GPT_STANDARD: &str = "gpt-standard";
pub const QUALITY_GPT_PRO: &str = "gpt-pro";
pub const QUALITY_GPT_TRANSPARENT: &str = "gpt-transparent";

/// 链成员静态定义（provider, 完整模型 id, hop 时限提示秒）。
#[derive(Debug, Clone, PartialEq)]
pub struct HopSpec {
    pub provider_id: &'static str,
    pub model: &'static str,
    pub timeout_hint_s: u64,
    /// 批次13：hop 提交时向 request.extra_params 合并 {"transparent_background": true}
    /// （HashMap 无法 const 构造，用布尔标记、from_spec 时落成 overlay）。
    pub transparent_overlay: bool,
}

const fn hop(provider_id: &'static str, model: &'static str, timeout_hint_s: u64) -> HopSpec {
    HopSpec {
        provider_id,
        model,
        timeout_hint_s,
        transparent_overlay: false,
    }
}

/// 透明底链成员专用构造：hop 级 extra_params overlay 标透明背景。
const fn hop_transparent(provider_id: &'static str, model: &'static str, timeout_hint_s: u64) -> HopSpec {
    HopSpec {
        provider_id,
        model,
        timeout_hint_s,
        transparent_overlay: true,
    }
}

/// 文生图标准链（价格优先）：GRSAI ¥0.06/张 1K/2K/4K 同价打头 → 666api（独立供应商最稳）
/// → 巨游（同协议备用）→ KIE（配了 key 才入链）。
pub const CHAIN_T2I_STANDARD: &[HopSpec] = &[
    hop("grsai", "grsai/nano-banana-2", 300),
    hop("666api", "666api/gemini-3.1-flash-image-preview", 240),
    hop("juyouapi", "juyouapi/gemini-3.1-flash-image", 240),
    hop("kie", "kie/nano-banana-2", 300),
];

/// 文生图高质量链（批次10 重排，用户拍板 2026-09-11）：grsai nano-banana-pro 打头
/// （游戏资产风格最正）→ aifast pro 档第二（首次进内置链；真实 key smoke
/// chat-completions 200/23.4s 出图）→ 666api Pro → 降级回标准链尾部。
pub const CHAIN_T2I_PRO: &[HopSpec] = &[
    hop("grsai", "grsai/nano-banana-pro", 300),
    hop("aifast", "aifast/gemini-3-pro-image-preview", 240),
    hop("666api", "666api/gemini-3-pro-image", 300),
    hop("666api", "666api/gemini-3.1-flash-image-preview", 240),
    hop("juyouapi", "juyouapi/gemini-3.1-flash-image", 240),
    hop("kie", "kie/nano-banana-2", 300),
];

/// 图生图链：nano 系 i2i 才是快线（grsai nano-banana-2 i2i 实测 28~38s）；
/// grsai gpt 系 i2i 慢线永不上链（见 build_chain 防御过滤 + 单测锁定）。
pub const CHAIN_I2I_STANDARD: &[HopSpec] = &[
    hop("grsai", "grsai/nano-banana-2", 300),
    hop("666api", "666api/gemini-3.1-flash-image-preview", 240),
    hop("juyouapi", "juyouapi/gemini-3.1-flash-image", 240),
    hop("kie", "kie/nano-banana-2", 300),
];

/// 批次13 · GPT 标准·高速链：grsai gpt-image-2.5-flare 单档（主对话 smoke 17s 实证恢复）。
pub const CHAIN_GPT_STANDARD: &[HopSpec] = &[hop("grsai", "grsai/gpt-image-2.5-flare", 300)];

/// 批次13 · GPT 高质量链：grsai gpt-image-2.5-sunburst 单档（smoke 18s 实证）。
pub const CHAIN_GPT_PRO: &[HopSpec] = &[hop("grsai", "grsai/gpt-image-2.5-sunburst", 300)];

/// 批次13 · GPT 透明底链：grsai gpt-image-2（原生 background=transparent 参数）
/// → 666api / juyouapi gpt-image-2（提示词式透明兜底，见 api666 submit_gpt_image_2_task）。
/// 三 hop 均带 transparent overlay（提交时合并 {"transparent_background": true} 进 extra_params；
/// grsai 侧 request_generate 用 as_bool() 只认 bool，必须 Value::Bool 不是字符串）。
pub const CHAIN_GPT_TRANSPARENT: &[HopSpec] = &[
    hop_transparent("grsai", "grsai/gpt-image-2", 300),
    hop_transparent("666api", "666api/gpt-image-2", 240),
    hop_transparent("juyouapi", "juyouapi/gpt-image-2", 240),
];

/// 运行期 hop（chain_meta_json 落库形态的元素）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hop {
    pub provider_id: String,
    /// 完整模型 id（`{provider}/{model}`），重提交时直接作为 GenerateRequest.model。
    pub model: String,
    pub timeout_hint_s: u64,
    /// 端点显示名（批次8，仅 extra hop 有）：链轨迹/失败汇总里 NEWAPI 接口显示
    /// 用户起的名字而非 newapi_<hash>。serde default 兼容旧落库数据。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// hop 级 extra_params 覆盖（批次13，R1）：提交该 hop 时逐项合并进
    /// request.extra_params（如透明底链标 {"transparent_background": true}）。
    /// serde default + skip None，旧 chain_meta_json 兼容（照 display_name 先例）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_params_overlay: Option<HashMap<String, serde_json::Value>>,
}

impl Hop {
    fn from_spec(spec: &HopSpec) -> Self {
        let extra_params_overlay = if spec.transparent_overlay {
            let mut overlay = HashMap::new();
            // Bool 不是字符串：grsai request_generate 用 value.as_bool() 只认 bool。
            overlay.insert(
                "transparent_background".to_string(),
                serde_json::Value::Bool(true),
            );
            Some(overlay)
        } else {
            None
        };
        Self {
            provider_id: spec.provider_id.to_string(),
            model: spec.model.to_string(),
            timeout_hint_s: spec.timeout_hint_s,
            display_name: None,
            extra_params_overlay,
        }
    }

    fn from_extra(spec: &ExtraHopSpec, timeout_hint_s: u64) -> Self {
        Self {
            provider_id: spec.provider_id.clone(),
            model: spec.model.clone(),
            timeout_hint_s,
            display_name: Some(spec.display_name.clone()),
            extra_params_overlay: None,
        }
    }

    /// 空链退化单点：用请求原模型造一个单元素"链"，行为与单点直连一致。
    fn from_request_model(model: &str) -> Self {
        let provider_id = model
            .split_once('/')
            .map(|(provider, _)| provider.to_string())
            .unwrap_or_else(|| model.to_string());
        Self {
            provider_id,
            model: model.to_string(),
            timeout_hint_s: 0,
            display_name: None,
            extra_params_overlay: None,
        }
    }
}

/// 前端提交时的降级选项（GenerateRequestDto.fallback，serde 可空，向后兼容）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FallbackOptions {
    /// "standard" | "pro"（其他值一律按 standard 处理）。
    pub quality: String,
    /// 已配置密钥的渠道 id 清单（localStorage 是 key 唯一真源，前端随请求注入快照）。
    pub available_providers: Vec<String>,
    /// NEWAPI 接口 / aifast 追加 hop（批次8）：前端只提交"开启入链 + 已配 key +
    /// 模型名与内置链成员完全同名"的端点；Rust 侧仍做注册/同名/去重三重防御。
    /// 缺省空 = 行为与 v0.3.0 逐字节一致（红线）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_hops: Vec<ExtraHopSpec>,
}

/// 追加 hop 规格（批次8）：NEWAPI 接口 / aifast 以自身 provider id 入链，
/// model 为完整 id（`{provider}/{model}`），display_name 为端点显示名（轨迹用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtraHopSpec {
    pub provider_id: String,
    pub model: String,
    pub display_name: String,
}

/// 一次 hop 尝试的失败记录（终态汇总人话轨迹的数据源）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainAttempt {
    pub provider_id: String,
    pub model: String,
    pub error_class: String,
    pub error: String,
    /// 端点显示名（批次8，extra hop 才有）：轨迹里 NEWAPI 接口显示用户起的名字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// job 行 chain_meta_json 列的落库结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainMeta {
    pub quality: String,
    pub hops: Vec<Hop>,
    pub current: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempts: Vec<ChainAttempt>,
    /// 原始请求（保留用户最初选择的模型 id）；hop 重提交以此为底、仅替换模型名。
    /// 终态时置 None——参考图可能含大 dataURL，防止长期滞留 DB。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<GenerateRequest>,
    /// 当前 hop 起始时刻（unix ms）。总时限兜底（JOB_MAX_RUNNING_MS）对链任务
    /// 按 hop 起点计时而非 job 创建时间——否则推进到 hop2 会被上 hop 耗掉的
    /// 时间立刻判超时、连锁烧穿整条链。None（旧数据/缺失）回退 created_at。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop_started_at_ms: Option<i64>,
    /// 软降权说明（模块 C）：提交时按最近探活把 down 渠道挪链尾，写一条人话说明
    /// （如「GRSAI 当前不可用，本次自动从 666API 开始」）。running 期经前端
    /// 批次5 的黄色警示通道透出（get 时注入 DTO.error，不改 DTO 形状）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ChainMeta {
    pub fn from_plan(plan: &ChainPlan, quality: &str, request: GenerateRequest) -> Self {
        Self {
            quality: quality.to_string(),
            hops: plan.hops.clone(),
            current: plan.current,
            attempts: Vec::new(),
            request: Some(request),
            hop_started_at_ms: Some(now_unix_ms()),
            note: None,
        }
    }

    /// hop 推进时刷新 hop 时钟（随 chain_meta 一起 CAS 落库）。
    pub fn touch_hop_clock(&mut self) {
        self.hop_started_at_ms = Some(now_unix_ms());
    }

    /// 链任务的兜底计时起点（无 hop 时钟回退 job 创建时间）。
    pub fn deadline_clock_start(&self, fallback_created_at: i64) -> i64 {
        self.hop_started_at_ms.unwrap_or(fallback_created_at)
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// build_chain 的产物（提交时刻的执行计划）。
#[derive(Debug, Clone)]
pub struct ChainPlan {
    pub hops: Vec<Hop>,
    pub current: usize,
}

impl ChainPlan {
    pub fn current_hop(&self) -> &Hop {
        &self.hops[self.current.min(self.hops.len() - 1)]
    }
}

/// 收集全部静态链成员的裸模型名（去 provider 前缀）——extra hop 同名准入判断用。
pub fn chain_member_bare_model_names() -> HashSet<&'static str> {
    let chains = [
        CHAIN_T2I_STANDARD,
        CHAIN_T2I_PRO,
        CHAIN_I2I_STANDARD,
        // 批次13（R5）：GPT 系三链成员也纳入同名准入集合。
        CHAIN_GPT_STANDARD,
        CHAIN_GPT_PRO,
        CHAIN_GPT_TRANSPARENT,
    ];
    let mut names = HashSet::new();
    for chain_specs in chains {
        for spec in chain_specs.iter() {
            if let Some((_, model)) = spec.model.split_once('/') {
                names.insert(model);
            }
        }
    }
    names
}

/// 构建执行链。
///
/// 过滤规则：① provider 已注册 ② 在 available_providers（前端已配 key）
/// ③ 参考图非空选 i2i 链并执行"grsai gpt 系不上 i2i"铁律 ④ (provider, model) 去重。
/// **空链退化单点（用请求原模型），永不因链配置拒绝生成。**
///
/// extra_hops（批次8）：NEWAPI 接口 / aifast 的追加档，仅当内置链非空时**按原序
/// 拼接到内置链尾部**（软降权之前）；Rust 侧防御——未注册 provider、裸模型名与
/// 内置链成员不同名、(provider, model) 重复的统统跳过，不同名绝不进链。
pub fn build_chain(
    request: &GenerateRequest,
    quality: &str,
    available_providers: &[String],
    registry: &ProviderRegistry,
    extra_hops: &[ExtraHopSpec],
) -> ChainPlan {
    let is_i2i = request
        .reference_images
        .as_ref()
        .is_some_and(|images| !images.is_empty());
    // R6（批次13）选链顺序：GPT 档位判断提到 is_i2i 之前——gpt-standard/pro/transparent
    // 无论有无参考图都走各自 GPT 链；Gemini 档位（standard/pro）维持现状（i2i→CHAIN_I2I_STANDARD）。
    let (specs, gpt_chain_selected): (&[HopSpec], bool) =
        if quality.eq_ignore_ascii_case(QUALITY_GPT_STANDARD) {
            (CHAIN_GPT_STANDARD, true)
        } else if quality.eq_ignore_ascii_case(QUALITY_GPT_PRO) {
            (CHAIN_GPT_PRO, true)
        } else if quality.eq_ignore_ascii_case(QUALITY_GPT_TRANSPARENT) {
            (CHAIN_GPT_TRANSPARENT, true)
        } else if is_i2i {
            (CHAIN_I2I_STANDARD, false)
        } else if quality.eq_ignore_ascii_case(QUALITY_PRO) {
            (CHAIN_T2I_PRO, false)
        } else {
            (CHAIN_T2I_STANDARD, false)
        };

    let mut hops: Vec<Hop> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for spec in specs {
        // 铁律防御：i2i 永不尝试 grsai gpt 系（慢线，实测不可生产）。
        // 批次13：该过滤只对 Gemini 链生效——选链结果是 GPT 链时（含参考图也合法）不走此过滤。
        if !gpt_chain_selected
            && is_i2i
            && spec.provider_id == "grsai"
            && spec.model.contains("gpt-image")
        {
            continue;
        }
        if registry.get_provider(spec.provider_id).is_none() {
            continue;
        }
        if !available_providers
            .iter()
            .any(|available| available == spec.provider_id)
        {
            continue;
        }
        if !seen.insert((spec.provider_id.to_string(), spec.model.to_string())) {
            continue;
        }
        hops.push(Hop::from_spec(spec));
    }

    // 追加档（批次8）：内置链为空（含退化单点）时不拼——"追加到内置链尾部"无尾部可接，
    // 单点直连语义保持不变。
    if !hops.is_empty() && !extra_hops.is_empty() {
        let member_names = chain_member_bare_model_names();
        for extra in extra_hops {
            if registry.get_provider(&extra.provider_id).is_none() {
                continue; // 防御：未注册 provider 跳过
            }
            if !available_providers.iter().any(|id| id == &extra.provider_id) {
                continue; // 防御：前端快照里没有该端点（未配 key / 未开入链）
            }
            let bare = extra
                .model
                .split_once('/')
                .map(|(_, model)| model)
                .unwrap_or(extra.model.as_str());
            if !member_names.contains(bare) {
                continue; // 铁律：与内置链成员模型名不完全同名绝不进链
            }
            if !seen.insert((extra.provider_id.clone(), extra.model.clone())) {
                continue; // 去重：同 provider+model 只保留第一档
            }
            hops.push(Hop::from_extra(extra, 240));
        }
    }

    if hops.is_empty() {
        return ChainPlan {
            hops: vec![Hop::from_request_model(&request.model)],
            current: 0,
        };
    }
    ChainPlan { hops, current: 0 }
}

/// 软降权（模块 C）：把最近探活 status=down 的渠道成员**稳定挪到链尾**——
/// 仅重排，绝不剔除、不拉黑（探活有盲区，10 分钟前的 down 不代表现在仍 down）。
/// 链成员全 down 或无 down 记录 → 保持原序（changed=false）。
/// 返回 (重排后的链, 是否发生了降权)。
pub fn demote_down_hops(hops: Vec<Hop>, down_provider_ids: &HashSet<String>) -> (Vec<Hop>, bool) {
    if down_provider_ids.is_empty() || hops.len() <= 1 {
        return (hops, false);
    }
    let mut healthy: Vec<Hop> = Vec::new();
    let mut demoted: Vec<Hop> = Vec::new();
    for hop in hops {
        if down_provider_ids.contains(&hop.provider_id) {
            demoted.push(hop);
        } else {
            healthy.push(hop);
        }
    }
    let changed = !healthy.is_empty() && !demoted.is_empty();
    healthy.extend(demoted);
    (healthy, changed)
}

// ──────────────────────────────────────────────────────────────────────
// 人话轨迹汇总
// ──────────────────────────────────────────────────────────────────────

/// 渠道展示名（终态失败轨迹与前端提示共用）。
/// NEWAPI 接口（newapi_*）不走本表——extra hop 的 display_name 携带用户起的端点名。
pub fn provider_display_name(provider_id: &str) -> &str {
    match provider_id {
        "grsai" => "GRSAI",
        "666api" => "666API",
        "juyouapi" => "巨游API",
        "aifast" => "aifast",
        "kie" => "KIE",
        "ppio" => "派欧云",
        "fal" => "fal",
        "agnes" => "Agnes AI",
        "ollama" => "Ollama",
        other => other,
    }
}

/// 错误类别的中文短标签（与 error_classify 的 snake_case 值对应）。
pub fn error_class_label(error_class: &str) -> &str {
    match error_class {
        "timeout" => "超时",
        "channel_down" => "渠道无响应",
        "auth" => "密钥无效",
        "quota" => "余额不足",
        "content_filter" => "内容过滤",
        _ => "未知错误",
    }
}

/// 按字符数截断（错误摘要入库用，防大 JSON 滞留）。
pub fn truncate_chars(input: &str, max_chars: usize) -> String {
    input.chars().take(max_chars).collect()
}

/// 全链尽墨的终态错误文案：
/// "已尝试 N 个渠道均失败：GRSAI·nano-banana-2（超时）→ 666API·gemini-3.1-flash-image-preview（余额不足）→ …。最后错误：…"
pub fn summarize_attempts(attempts: &[ChainAttempt], last_error: &str) -> String {
    if attempts.is_empty() {
        return truncate_chars(last_error, 300);
    }
    let trace = attempts
        .iter()
        .map(|attempt| {
            // NEWAPI 接口（extra hop）优先显示用户起的端点名；内置渠道走静态表。
            let display = attempt
                .display_name
                .as_deref()
                .unwrap_or_else(|| provider_display_name(&attempt.provider_id));
            format!(
                "{}·{}（{}）",
                display,
                short_hop_model(&attempt.model),
                error_class_label(&attempt.error_class)
            )
        })
        .collect::<Vec<_>>()
        .join(" → ");
    format!(
        "已尝试 {} 个渠道均失败：{}。最后错误：{}",
        attempts.len(),
        trace,
        truncate_chars(last_error, 300)
    )
}

/// `provider/model` → `model`（轨迹里渠道名已单列，模型只留短名）。
pub fn short_hop_model(model: &str) -> &str {
    model.split_once('/').map(|(_, short)| short).unwrap_or(model)
}

// ──────────────────────────────────────────────────────────────────────
// chain_meta 序列化
// ──────────────────────────────────────────────────────────────────────

pub fn chain_meta_to_json(meta: &ChainMeta) -> Option<String> {
    serde_json::to_string(meta).ok()
}

pub fn parse_chain_meta(raw: Option<&str>) -> Option<ChainMeta> {
    let raw = raw?; // None 列值 = 非链任务（单点直连）
    serde_json::from_str(raw).ok()
}

// ──────────────────────────────────────────────────────────────────────
// 单测：链构建纯逻辑（过滤 / 空链退化 / quality 分档 / 无 key 跳过 / i2i 铁律）
// ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::error::AIError;
    use crate::ai::AIProvider;
    use std::sync::Arc;

    /// 最小 stub provider：只响应名字路由，供注册表过滤测试。
    struct StubProvider(&'static str);

    #[async_trait::async_trait]
    impl AIProvider for StubProvider {
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
        fn name(&self) -> &str {
            self.0
        }
        fn supports_model(&self, model: &str) -> bool {
            model.starts_with(&format!("{}/", self.0))
        }
        async fn generate(&self, _request: GenerateRequest) -> Result<String, AIError> {
            Ok(String::new())
        }
    }

    fn registry_with(providers: &[&'static str]) -> ProviderRegistry {
        let registry = ProviderRegistry::new();
        for name in providers {
            registry.register_provider(Arc::new(StubProvider(name)));
        }
        registry
    }

    fn all_available() -> Vec<String> {
        ["grsai", "aifast", "666api", "juyouapi", "kie"]
            .iter()
            .map(|name| name.to_string())
            .collect()
    }

    fn t2i_request(model: &str) -> GenerateRequest {
        GenerateRequest {
            prompt: "a tiny cat".to_string(),
            model: model.to_string(),
            size: "2K".to_string(),
            aspect_ratio: "1:1".to_string(),
            reference_images: None,
            extra_params: None,
        }
    }

    fn i2i_request(model: &str) -> GenerateRequest {
        GenerateRequest {
            reference_images: Some(vec!["/tmp/ref.png".to_string()]),
            ..t2i_request(model)
        }
    }

    fn hop_models(plan: &ChainPlan) -> Vec<String> {
        plan.hops.iter().map(|hop| hop.model.clone()).collect()
    }

    fn down_set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn hop_chain(providers: &[&str]) -> Vec<Hop> {
        providers
            .iter()
            .map(|provider| Hop {
                provider_id: provider.to_string(),
                model: format!("{}/model", provider),
                timeout_hint_s: 0,
                display_name: None,
                extra_params_overlay: None,
            })
            .collect()
    }

    fn extra_hop(provider_id: &str, model: &str, display_name: &str) -> ExtraHopSpec {
        ExtraHopSpec {
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            display_name: display_name.to_string(),
        }
    }

    #[test]
    fn demote_moves_down_provider_to_tail_stably() {
        let hops = hop_chain(&["grsai", "666api", "juyouapi", "kie"]);
        let (reordered, changed) = demote_down_hops(hops, &down_set(&["grsai"]));
        assert!(changed);
        let providers: Vec<String> = reordered.iter().map(|h| h.provider_id.clone()).collect();
        assert_eq!(providers, vec!["666api", "juyouapi", "kie", "grsai"]);
    }

    #[test]
    fn demote_keeps_relative_order_on_both_sides() {
        let hops = hop_chain(&["grsai", "666api", "juyouapi", "kie"]);
        let (reordered, changed) =
            demote_down_hops(hops, &down_set(&["666api", "kie"]));
        assert!(changed);
        let providers: Vec<String> = reordered.iter().map(|h| h.provider_id.clone()).collect();
        // 健康侧保持原相对序，降权侧保持原相对序。
        assert_eq!(providers, vec!["grsai", "juyouapi", "666api", "kie"]);
    }

    #[test]
    fn demote_noop_when_all_down_or_no_down_or_single_hop() {
        let hops = hop_chain(&["grsai", "666api"]);
        // 全 down：原序，无变化
        let (reordered, changed) =
            demote_down_hops(hop_chain(&["grsai", "666api"]), &down_set(&["grsai", "666api"]));
        assert!(!changed);
        assert_eq!(
            reordered.iter().map(|h| h.provider_id.clone()).collect::<Vec<_>>(),
            hops.iter().map(|h| h.provider_id.clone()).collect::<Vec<_>>()
        );
        // 无 down 记录：原样
        let (reordered, changed) = demote_down_hops(hop_chain(&["grsai", "666api"]), &down_set(&[]));
        assert!(!changed);
        assert_eq!(reordered.len(), 2);
        // 单元素链：不重排
        let (_, changed) = demote_down_hops(hop_chain(&["grsai"]), &down_set(&["grsai"]));
        assert!(!changed);
    }

    #[test]
    fn chain_meta_note_roundtrips_and_defaults_absent() {
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &all_available(), &registry, &[]);
        let mut meta = ChainMeta::from_plan(&plan, QUALITY_STANDARD, t2i_request("auto/standard"));
        assert!(meta.note.is_none());
        meta.note = Some("GRSAI 当前不可用，本次自动从 666API 开始".to_string());
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("本次自动从"));
        let parsed: ChainMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.note.as_deref(), Some("GRSAI 当前不可用，本次自动从 666API 开始"));
        // 旧数据（无 note 字段）兼容：serde default → None
        let legacy_json = serde_json::to_string(&{
            let mut legacy = meta.clone();
            legacy.note = None;
            legacy
        })
        .unwrap();
        let parsed_legacy: ChainMeta = serde_json::from_str(&legacy_json).unwrap();
        assert!(parsed_legacy.note.is_none());
    }

    #[test]
    fn t2i_standard_full_availability_order() {
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &all_available(), &registry, &[]);
        assert_eq!(
            hop_models(&plan),
            vec![
                "grsai/nano-banana-2",
                "666api/gemini-3.1-flash-image-preview",
                "juyouapi/gemini-3.1-flash-image",
                "kie/nano-banana-2",
            ]
        );
        assert_eq!(plan.current, 0);
    }

    #[test]
    fn skips_providers_without_key() {
        // grsai 未配 key → 从 666api 起跳；juyouapi 未配 key → 跳过
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        let available = vec!["666api".to_string(), "kie".to_string()];
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &available, &registry, &[]);
        assert_eq!(
            hop_models(&plan),
            vec!["666api/gemini-3.1-flash-image-preview", "kie/nano-banana-2"]
        );
    }

    #[test]
    fn skips_unregistered_providers() {
        // kie 未注册（registry 只有 666api）→ 即使有 key 也被过滤
        let registry = registry_with(&["666api"]);
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &all_available(), &registry, &[]);
        assert_eq!(hop_models(&plan), vec!["666api/gemini-3.1-flash-image-preview"]);
    }

    #[test]
    fn quality_pro_head_is_pro_model() {
        let registry = registry_with(&["grsai", "aifast", "666api", "juyouapi", "kie"]);
        let plan = build_chain(&t2i_request("auto/pro"), QUALITY_PRO, &all_available(), &registry, &[]);
        // 批次10 链序：grsai pro 打头（游戏资产风）→ aifast pro 第二（首次进内置链）
        assert_eq!(plan.hops[0].model, "grsai/nano-banana-pro");
        assert_eq!(plan.hops[1].model, "aifast/gemini-3-pro-image-preview");
        assert_eq!(plan.hops[2].model, "666api/gemini-3-pro-image");
        // Pro 尽墨后仍落回标准链尾部兜底
        assert!(plan.hops.iter().any(|hop| hop.model == "kie/nano-banana-2"));
    }

    #[test]
    fn quality_pro_skips_aifast_without_key() {
        // aifast 未配 key → build_chain available_providers 过滤自动跳过，
        // pro 链自然降级为 grsai-pro → 666api-pro → 标准尾部（不变式锁定）
        let registry = registry_with(&["grsai", "aifast", "666api", "juyouapi", "kie"]);
        let available: Vec<String> = ["grsai", "666api", "juyouapi", "kie"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        let plan = build_chain(&t2i_request("auto/pro"), QUALITY_PRO, &available, &registry, &[]);
        assert_eq!(
            hop_models(&plan),
            vec![
                "grsai/nano-banana-pro",
                "666api/gemini-3-pro-image",
                "666api/gemini-3.1-flash-image-preview",
                "juyouapi/gemini-3.1-flash-image",
                "kie/nano-banana-2",
            ]
        );
    }

    #[test]
    fn empty_chain_degrades_to_single_point() {
        // 无任何 key：空链 → 退化为请求原模型单点，永不拒绝生成
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        let plan = build_chain(&t2i_request("666api/gemini-3.1-flash-image-preview"), QUALITY_STANDARD, &[], &registry, &[]);
        assert_eq!(plan.hops.len(), 1);
        assert_eq!(plan.hops[0].model, "666api/gemini-3.1-flash-image-preview");
        assert_eq!(plan.hops[0].provider_id, "666api");
        assert_eq!(plan.current_hop().model, "666api/gemini-3.1-flash-image-preview");
    }

    #[test]
    fn i2i_uses_i2i_chain_and_never_grsai_gpt() {
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        let plan = build_chain(&i2i_request("auto/standard"), QUALITY_STANDARD, &all_available(), &registry, &[]);
        assert_eq!(plan.hops[0].model, "grsai/nano-banana-2");
        // 铁律锁定：i2i 链与全部静态链均不含 grsai gpt 系
        for hop in &plan.hops {
            assert!(
                !(hop.provider_id == "grsai" && hop.model.contains("gpt-image")),
                "grsai gpt 系混入 i2i 链: {}",
                hop.model
            );
        }
        for spec in CHAIN_I2I_STANDARD {
            assert!(!(spec.provider_id == "grsai" && spec.model.contains("gpt-image")));
        }
    }

    #[test]
    fn t2i_request_with_pro_quality_i2i_chain_wins_by_reference_images() {
        // 有参考图时 i2i 链优先于 quality 分档（quality 只影响 t2i 选链）
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        let plan = build_chain(&i2i_request("auto/pro"), QUALITY_PRO, &all_available(), &registry, &[]);
        assert_eq!(plan.hops[0].model, "grsai/nano-banana-2");
        assert!(!plan.hops.iter().any(|hop| hop.model == "666api/gemini-3-pro-image"));
    }

    #[test]
    fn summarize_attempts_human_trajectory() {
        let attempts = vec![
            ChainAttempt {
                provider_id: "grsai".to_string(),
                model: "grsai/nano-banana-2".to_string(),
                error_class: "timeout".to_string(),
                error: "渠道响应超时".to_string(),
                display_name: None,
            },
            ChainAttempt {
                provider_id: "666api".to_string(),
                model: "666api/gemini-3.1-flash-image-preview".to_string(),
                error_class: "quota".to_string(),
                error: "402 payment required".to_string(),
                display_name: None,
            },
        ];
        let summary = summarize_attempts(&attempts, "402 payment required");
        assert!(summary.contains("已尝试 2 个渠道均失败"));
        assert!(summary.contains("GRSAI·nano-banana-2（超时）"));
        assert!(summary.contains("666API·gemini-3.1-flash-image-preview（余额不足）"));
        assert!(summary.contains("最后错误：402 payment required"));
    }

    #[test]
    fn extra_hops_matching_names_append_at_tail_in_order() {
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie", "newapi_x1", "aifast"]);
        let extras = vec![
            extra_hop("newapi_x1", "newapi_x1/gemini-3.1-flash-image-preview", "小胡API"),
            extra_hop("aifast", "aifast/nano-banana-2", "aifast"),
        ];
        let mut available = all_available();
        available.push("newapi_x1".to_string());
        available.push("aifast".to_string());
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &available, &registry, &extras);
        let models = hop_models(&plan);
        // 追加档按原序拼在内置链尾部，内置链序不动
        assert_eq!(
            models,
            vec![
                "grsai/nano-banana-2",
                "666api/gemini-3.1-flash-image-preview",
                "juyouapi/gemini-3.1-flash-image",
                "kie/nano-banana-2",
                "newapi_x1/gemini-3.1-flash-image-preview",
                "aifast/nano-banana-2",
            ]
        );
        // extra hop 携带端点显示名（轨迹用）
        assert_eq!(plan.hops[4].display_name.as_deref(), Some("小胡API"));
        assert_eq!(plan.hops[5].display_name.as_deref(), Some("aifast"));
        assert_eq!(plan.hops[0].display_name, None);
    }

    #[test]
    fn extra_hops_different_model_names_never_join() {
        let registry = registry_with(&["grsai", "666api", "newapi_x1"]);
        let extras = vec![
            extra_hop("newapi_x1", "newapi_x1/gemini-2.5-flash-image", "小胡API"),
            extra_hop("newapi_x1", "newapi_x1/some-custom-model", "小胡API"),
        ];
        let mut available = all_available();
        available.push("newapi_x1".to_string());
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &available, &registry, &extras);
        // 不同名（哪怕 provider 有 key）绝不进链
        assert_eq!(
            hop_models(&plan),
            vec!["grsai/nano-banana-2", "666api/gemini-3.1-flash-image-preview"]
        );
    }

    #[test]
    fn extra_hops_dedupe_and_skip_unregistered_or_unavailable() {
        let registry = registry_with(&["grsai", "666api", "newapi_x1"]);
        let extras = vec![
            // 未注册 provider：跳过
            extra_hop("newapi_ghost", "newapi_ghost/nano-banana-2", "幽灵API"),
            // 注册了但前端快照无 key（不在 available）：跳过
            extra_hop("newapi_x1", "newapi_x1/nano-banana-2", "小胡API"),
            extra_hop("newapi_x1", "newapi_x1/nano-banana-2", "小胡API"), // 重复档
        ];
        let plan = build_chain(
            &t2i_request("auto/standard"),
            QUALITY_STANDARD,
            &all_available(),
            &registry,
            &extras,
        );
        // newapi_x1 不在 available → 全部跳过；同 provider+model 重复也不会进
        assert_eq!(
            hop_models(&plan),
            vec!["grsai/nano-banana-2", "666api/gemini-3.1-flash-image-preview"]
        );

        // 加入 available 后：同 provider+model 去重，只保留第一档
        let mut available = all_available();
        available.push("newapi_x1".to_string());
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &available, &registry, &extras);
        assert_eq!(
            hop_models(&plan),
            vec![
                "grsai/nano-banana-2",
                "666api/gemini-3.1-flash-image-preview",
                "newapi_x1/nano-banana-2",
            ]
        );
    }

    #[test]
    fn extra_hops_ignored_when_builtin_chain_empty() {
        // 内置链空（无人配 key）→ 退化单点，追加档不拼（"追加到内置链尾部"无尾部可接）
        let registry = registry_with(&["newapi_x1"]);
        let extras = vec![extra_hop("newapi_x1", "newapi_x1/nano-banana-2", "小胡API")];
        let available = vec!["newapi_x1".to_string()];
        let plan = build_chain(
            &t2i_request("666api/gemini-3.1-flash-image-preview"),
            QUALITY_STANDARD,
            &available,
            &registry,
            &extras,
        );
        assert_eq!(plan.hops.len(), 1);
        assert_eq!(plan.hops[0].model, "666api/gemini-3.1-flash-image-preview");
    }

    #[test]
    fn hop_display_name_roundtrips_and_legacy_json_compatible() {
        let registry = registry_with(&["grsai", "newapi_x1"]);
        let extras = vec![extra_hop("newapi_x1", "newapi_x1/nano-banana-2", "小胡API")];
        let mut available = all_available();
        available.push("newapi_x1".to_string());
        let plan = build_chain(&t2i_request("auto/standard"), QUALITY_STANDARD, &available, &registry, &extras);
        let mut meta = ChainMeta::from_plan(&plan, QUALITY_STANDARD, t2i_request("auto/standard"));
        // 失败轨迹携带端点显示名
        meta.attempts.push(ChainAttempt {
            provider_id: "newapi_x1".to_string(),
            model: "newapi_x1/nano-banana-2".to_string(),
            error_class: "timeout".to_string(),
            error: "渠道响应超时".to_string(),
            display_name: Some("小胡API".to_string()),
        });
        let json = chain_meta_to_json(&meta).expect("serialize chain meta");
        let parsed = parse_chain_meta(Some(json.as_str())).expect("parse chain meta");
        assert_eq!(parsed.hops.last().and_then(|hop| hop.display_name.clone()), Some("小胡API".to_string()));

        // 轨迹汇总：extra hop 显示端点名而非 newapi_<hash>
        let summary = summarize_attempts(&parsed.attempts, "timeout");
        assert!(summary.contains("小胡API·nano-banana-2（超时）"), "summary: {}", summary);
        assert!(!summary.contains("newapi_x1"), "summary: {}", summary);

        // 旧落库数据（hop/attempts 无 display_name 字段）serde default 兼容 → None
        let legacy: ChainMeta = serde_json::from_str(
            r#"{"quality":"standard","hops":[{"provider_id":"grsai","model":"grsai/nano-banana-2","timeout_hint_s":300}],"current":0,
                "attempts":[{"provider_id":"grsai","model":"grsai/nano-banana-2","error_class":"timeout","error":"超时"}]}"#,
        )
        .expect("parse legacy chain meta");
        assert_eq!(legacy.hops[0].display_name, None);
        assert_eq!(legacy.attempts[0].display_name, None);
        // 旧数据轨迹走静态展示名表
        let legacy_summary = summarize_attempts(&legacy.attempts, "timeout");
        assert!(legacy_summary.contains("GRSAI·nano-banana-2（超时）"));
    }

    #[test]
    fn chain_meta_roundtrip_and_request_strip() {
        let registry = registry_with(&["grsai", "666api"]);
        let request = t2i_request("auto/standard");
        let plan = build_chain(&request, QUALITY_STANDARD, &all_available(), &registry, &[]);
        let mut meta = ChainMeta::from_plan(&plan, QUALITY_STANDARD, request);
        meta.attempts.push(ChainAttempt {
            provider_id: "grsai".to_string(),
            model: "grsai/nano-banana-2".to_string(),
            error_class: "timeout".to_string(),
            error: "超时".to_string(),
            display_name: None,
        });
        let json = chain_meta_to_json(&meta).expect("serialize chain meta");
        let parsed = parse_chain_meta(Some(json.as_str())).expect("parse chain meta");
        assert_eq!(parsed.hops, meta.hops);
        assert_eq!(parsed.current, 0);
        assert_eq!(parsed.attempts.len(), 1);
        assert!(parsed.request.is_some());
        // hop 时钟存在且兜底回退语义正确
        let hop_clock = parsed.hop_started_at_ms.expect("hop clock set");
        assert!(parsed.deadline_clock_start(0) == hop_clock);
        let clockless = ChainMeta {
            hop_started_at_ms: None,
            ..parsed.clone()
        };
        assert_eq!(clockless.deadline_clock_start(123), 123);

        // 终态剥请求后仍可解析（attempts 轨迹保留）
        meta.request = None;
        let stripped = chain_meta_to_json(&meta).expect("serialize stripped meta");
        let parsed = parse_chain_meta(Some(stripped.as_str())).expect("parse stripped meta");
        assert!(parsed.request.is_none());
        assert_eq!(parsed.attempts.len(), 1);
        assert!(!stripped.contains("/tmp/ref.png"));
    }

    #[test]
    fn parse_chain_meta_none_for_non_chain_job() {
        assert!(parse_chain_meta(None).is_none());
        assert!(parse_chain_meta(Some("not-json")).is_none());
    }

    // ── 批次13：GPT 系三档链 ────────────────────────────────────────────

    #[test]
    fn gpt_standard_chain_selected_regardless_of_reference_images() {
        let registry = registry_with(&["grsai"]);
        let available = vec!["grsai".to_string()];
        // t2i
        let plan = build_chain(
            &t2i_request("auto/gpt-standard"),
            QUALITY_GPT_STANDARD,
            &available,
            &registry,
            &[],
        );
        assert_eq!(hop_models(&plan), vec!["grsai/gpt-image-2.5-flare"]);
        // i2i（带参考图）：GPT 档位判断优先于 i2i，仍走 GPT 链而非 CHAIN_I2I_STANDARD
        let plan = build_chain(
            &i2i_request("auto/gpt-standard"),
            QUALITY_GPT_STANDARD,
            &available,
            &registry,
            &[],
        );
        assert_eq!(hop_models(&plan), vec!["grsai/gpt-image-2.5-flare"]);
    }

    #[test]
    fn gpt_pro_chain_selected_regardless_of_reference_images() {
        let registry = registry_with(&["grsai"]);
        let available = vec!["grsai".to_string()];
        let plan = build_chain(
            &i2i_request("auto/gpt-pro"),
            QUALITY_GPT_PRO,
            &available,
            &registry,
            &[],
        );
        assert_eq!(hop_models(&plan), vec!["grsai/gpt-image-2.5-sunburst"]);
    }

    #[test]
    fn gpt_transparent_chain_with_reference_images_not_killed_by_i2i_filter() {
        // 单测锁（任务书 R6）：GPT 透明链含参考图不被"i2i 不跑 grsai gpt 系"防御误杀。
        let registry = registry_with(&["grsai", "666api", "juyouapi"]);
        let available: Vec<String> = ["grsai", "666api", "juyouapi"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        let plan = build_chain(
            &i2i_request("auto/gpt-transparent"),
            QUALITY_GPT_TRANSPARENT,
            &available,
            &registry,
            &[],
        );
        assert_eq!(
            hop_models(&plan),
            vec!["grsai/gpt-image-2", "666api/gpt-image-2", "juyouapi/gpt-image-2"]
        );
    }

    #[test]
    fn gpt_transparent_hops_carry_bool_overlay() {
        // R1/R4：三 hop 全部带 {"transparent_background": Bool(true)}（Bool 不是字符串）
        let registry = registry_with(&["grsai", "666api", "juyouapi"]);
        let available: Vec<String> = ["grsai", "666api", "juyouapi"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        let plan = build_chain(
            &t2i_request("auto/gpt-transparent"),
            QUALITY_GPT_TRANSPARENT,
            &available,
            &registry,
            &[],
        );
        assert_eq!(plan.hops.len(), 3);
        for hop in &plan.hops {
            let overlay = hop
                .extra_params_overlay
                .as_ref()
                .expect("transparent hop overlay");
            assert_eq!(
                overlay.get("transparent_background"),
                Some(&serde_json::Value::Bool(true))
            );
        }
        // 非透明链 hop 不带 overlay
        let plan = build_chain(
            &t2i_request("auto/standard"),
            QUALITY_STANDARD,
            &all_available(),
            &registry_with(&["grsai", "666api", "juyouapi", "kie"]),
            &[],
        );
        assert!(plan.hops.iter().all(|hop| hop.extra_params_overlay.is_none()));
    }

    #[test]
    fn hop_overlay_roundtrips_and_legacy_json_defaults_none() {
        // overlay 随 chain_meta_json 落库往返；旧数据无该字段 → serde default None
        let legacy: ChainMeta = serde_json::from_str(
            r#"{"quality":"gpt-transparent","hops":[{"provider_id":"grsai","model":"grsai/gpt-image-2","timeout_hint_s":300}],"current":0}"#,
        )
        .expect("parse legacy chain meta");
        assert_eq!(legacy.hops[0].extra_params_overlay, None);

        let registry = registry_with(&["grsai", "666api", "juyouapi"]);
        let available: Vec<String> = ["grsai", "666api", "juyouapi"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        let plan = build_chain(
            &t2i_request("auto/gpt-transparent"),
            QUALITY_GPT_TRANSPARENT,
            &available,
            &registry,
            &[],
        );
        let meta = ChainMeta::from_plan(&plan, QUALITY_GPT_TRANSPARENT, t2i_request("auto/gpt-transparent"));
        let json = chain_meta_to_json(&meta).expect("serialize");
        assert!(json.contains("transparent_background"));
        let parsed = parse_chain_meta(Some(json.as_str())).expect("parse");
        assert_eq!(parsed.hops, meta.hops);
    }

    #[test]
    fn chain_member_names_include_gpt_models() {
        // R5：三条新链成员裸模型名纳入同名准入集合
        let names = chain_member_bare_model_names();
        assert!(names.contains("gpt-image-2"));
        assert!(names.contains("gpt-image-2.5-flare"));
        assert!(names.contains("gpt-image-2.5-sunburst"));
    }

    #[test]
    fn gemini_i2i_still_skips_grsai_gpt_models() {
        // 既有铁律不变式锁定：Gemini 档位 i2i 链仍跳过 gpt 系
        let registry = registry_with(&["grsai", "666api", "juyouapi", "kie"]);
        for quality in [QUALITY_STANDARD, QUALITY_PRO] {
            let plan = build_chain(&i2i_request("auto/standard"), quality, &all_available(), &registry, &[]);
            assert!(
                plan.hops
                    .iter()
                    .all(|hop| !(hop.provider_id == "grsai" && hop.model.contains("gpt-image"))),
                "quality {} i2i 链混入 grsai gpt 系",
                quality
            );
        }
    }
}
