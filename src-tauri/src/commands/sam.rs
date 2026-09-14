//! SAM-HQ 智能抠图内网服务代理（批次16）。
//!
//! 内网 SAM-HQ 服务响应不带 CORS 头，WebView 直连 fetch 会被拦，因此统一走
//! Rust reqwest 代理。两段式：`sam_embed`（上传图片拿 embed_id）+
//! `sam_decode`（点选拿灰度蒙版 PNG，base64 回传前端；旧服务 256×256，升级后 1024×1024，
//! 尺寸由前端按 PNG 实际宽高自适应）。
//! 服务无鉴权（纯内网部署，严禁暴露公网）；沿用全局 http client，
//! 按接口各自限超时：health 5s / embed 60s / decode 30s / biref 120s。

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::ai::http::http_client;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
const EMBED_TIMEOUT: Duration = Duration::from_secs(60);
const DECODE_TIMEOUT: Duration = Duration::from_secs(30);
const BIREF_TIMEOUT: Duration = Duration::from_secs(120);

/// 服务端模型白名单（拼写错误服务端会 400，这里提前拦）。
/// 服务端升级后补 vit_l 档；前端下拉以 health.models 动态列出（运行时校验），
/// 此处仅兜底防拼写错误——旧服务只支持 vit_t/vit_b 时行为不变（health 不会列出 vit_l）。
pub(crate) const VALID_MODELS: [&str; 3] = ["vit_t", "vit_b", "vit_l"];

/// 命令级错误（decode 的 404 embed 过期需要让前端区分以自动重 embed）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamCommandError {
    /// network / http / bad_request / embed_expired
    pub kind: String,
    pub message: String,
}

impl SamCommandError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
        }
    }
}

/// 去除首尾空白与结尾斜杠（含多个），统一拼 URL。
pub(crate) fn normalize_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    trimmed.to_string()
}

pub(crate) fn validate_model(model: &str) -> Result<(), String> {
    if VALID_MODELS.contains(&model) {
        Ok(())
    } else {
        Err(format!(
            "model 必须为 {} 之一",
            VALID_MODELS.join(" / ")
        ))
    }
}

/// 点格式校验：至少 1 个点；坐标有限；label 只允许 0/1。
pub(crate) fn validate_points(points: &[[f64; 3]]) -> Result<(), String> {
    if points.is_empty() {
        return Err("points 至少需要 1 个点".to_string());
    }
    for point in points {
        let [x, y, label] = point;
        if !x.is_finite() || !y.is_finite() {
            return Err("点坐标必须为有限数值".to_string());
        }
        if *label != 0.0 && *label != 1.0 {
            return Err("点 label 必须为 0 或 1".to_string());
        }
    }
    Ok(())
}

/// decode 阶段 HTTP 状态 → 错误类别（404 = embed 过期，前端自动重 embed + 重放点）。
pub(crate) fn map_decode_error_kind(status: u16) -> &'static str {
    match status {
        404 => "embed_expired",
        400 => "bad_request",
        _ => "service",
    }
}

/// 服务端响应一律 snake_case（embed_id/vit_t/max_upload_mb），勿加 camelCase rename——
/// v0.4.4 真机事故：camelCase 找不到 `embedId` → default 空串 → 误报「异常载荷」。
#[derive(Debug, Deserialize)]
struct SamHealthResponse {
    ok: bool,
    #[serde(default)]
    service: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    device: String,
    /// 服务端升级后 models 会加 vit_l 等档——吃成 map 动态透传，不再硬编码两档。
    #[serde(default)]
    models: HashMap<String, bool>,
    #[serde(default)]
    max_upload_mb: u32,
    /// v1.1 新增：BiRefNet 端点是否可用（缺省 false = 旧服务无此端点）。
    #[serde(default)]
    birefnet: bool,
    /// v1.1 新增：decode 蒙版边长（缺省 256 = 旧服务行为）。
    #[serde(default = "default_mask_size")]
    mask_size: u32,
}

fn default_mask_size() -> u32 {
    256
}

/// health.models（name→enabled）→ 前端可用模型列表：
/// 只保留 enabled=true；已知档按 vit_t/vit_b/vit_l 固定序，未知档排后按字典序（稳定输出）。
pub(crate) fn resolve_model_list(models: &HashMap<String, bool>) -> Vec<String> {
    let mut list: Vec<String> = VALID_MODELS
        .iter()
        .filter(|name| models.get(**name).copied().unwrap_or(false))
        .map(|name| (*name).to_string())
        .collect();
    let mut unknown: Vec<String> = models
        .iter()
        .filter(|(name, enabled)| **enabled && !VALID_MODELS.contains(&name.as_str()))
        .map(|(name, _)| name.clone())
        .collect();
    unknown.sort();
    list.append(&mut unknown);
    list
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamHealthDto {
    ok: bool,
    service: String,
    version: String,
    device: String,
    /// 服务实际支持的模型档（enabled=true），前端编辑器据此动态列出切换按钮。
    models: Vec<String>,
    max_upload_mb: u32,
    /// BiRefNet 一键去底端点是否可用（v1.1+）。
    birefnet: bool,
    /// decode 蒙版边长（旧服务 256 / v1.1 为 1024）。
    mask_size: u32,
}

#[tauri::command]
pub async fn sam_health(base_url: String) -> Result<SamHealthDto, String> {
    let url = format!("{}/api/sam/health", normalize_base_url(&base_url));
    let response = http_client()
        .get(&url)
        .timeout(HEALTH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("AI 抠图服务连接失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("AI 抠图服务返回 HTTP {}", response.status()));
    }
    let health: SamHealthResponse = response
        .json()
        .await
        .map_err(|e| format!("AI 抠图服务健康响应解析失败：{e}"))?;
    Ok(SamHealthDto {
        ok: health.ok,
        service: health.service,
        version: health.version,
        device: health.device,
        models: resolve_model_list(&health.models),
        max_upload_mb: health.max_upload_mb,
        birefnet: health.birefnet,
        mask_size: health.mask_size,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamEmbedDto {
    embed_id: String,
    model: String,
    width: u32,
    height: u32,
    cached: bool,
}

#[derive(Debug, Deserialize)]
struct SamEmbedResponse {
    ok: bool,
    #[serde(default)]
    embed_id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    cached: bool,
    /// 服务端 ok:false 时的原因（原样透给用户，禁止吞成「异常载荷」）。
    #[serde(default)]
    error: String,
}

#[tauri::command]
pub async fn sam_embed(
    base_url: String,
    image_base64: String,
    model: String,
) -> Result<SamEmbedDto, String> {
    validate_model(&model)?;
    let bytes = STANDARD
        .decode(image_base64.trim())
        .map_err(|e| format!("图片 base64 解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    let url = format!("{}/api/sam/embed", normalize_base_url(&base_url));
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image")
        .mime_str("image/png")
        .map_err(|e| format!("构造上传分片失败：{e}"))?;
    let form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", model.clone());

    let response = http_client()
        .post(&url)
        .timeout(EMBED_TIMEOUT)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("AI 抠图服务连接失败：{e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("embed 失败（HTTP {}）：{body}", status));
    }
    let payload: SamEmbedResponse = response
        .json()
        .await
        .map_err(|e| format!("embed 响应解析失败：{e}"))?;
    if !payload.ok || payload.embed_id.is_empty() {
        let reason = if payload.error.is_empty() {
            "响应缺少 embed_id".to_string()
        } else {
            format!("服务返回错误：{}", payload.error)
        };
        return Err(format!("embed 失败：{reason}"));
    }
    Ok(SamEmbedDto {
        embed_id: payload.embed_id,
        model: payload.model,
        width: payload.width,
        height: payload.height,
        cached: payload.cached,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamDecodeDto {
    /// 灰度蒙版 PNG 的 base64（前景=255 背景=0）。
    /// 尺寸随服务端版本：旧服务 256×256，升级后 1024×1024，前端按 PNG 实际宽高自适应。
    mask_png_base64: String,
}

#[tauri::command]
pub async fn sam_decode(
    base_url: String,
    embed_id: String,
    model: String,
    points: Vec<[f64; 3]>,
) -> Result<SamDecodeDto, SamCommandError> {
    validate_model(&model).map_err(|message| SamCommandError::new("bad_request", message))?;
    validate_points(&points).map_err(|message| SamCommandError::new("bad_request", message))?;
    if embed_id.trim().is_empty() {
        return Err(SamCommandError::new("bad_request", "embed_id 不能为空"));
    }

    let url = format!("{}/api/sam/decode", normalize_base_url(&base_url));
    let body = serde_json::json!({
        "embed_id": embed_id,
        "model": model,
        "points": points,
    });
    let response = http_client()
        .post(&url)
        .timeout(DECODE_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|e| SamCommandError::new("network", format!("AI 抠图服务连接失败：{e}")))?;

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(SamCommandError::new(
            map_decode_error_kind(status),
            format!("decode 失败（HTTP {status}）：{body}"),
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if !content_type.starts_with("image/png") {
        return Err(SamCommandError::new(
            "service",
            format!("decode 返回了非 PNG 载荷（Content-Type: {content_type}）"),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| SamCommandError::new("network", format!("decode 载荷读取失败：{e}")))?;
    Ok(SamDecodeDto {
        mask_png_base64: STANDARD.encode(&bytes),
    })
}

/// BiRefNet 错误人话映射：503=模型未加载 / 413=超上传上限 / 其他=服务不可用。
pub(crate) fn map_biref_error(status: u16, body: &str) -> String {
    match status {
        503 => "BiRefNet 模型未加载（服务端）".to_string(),
        413 => "图片超过 50MB".to_string(),
        _ => format!("AI 去底服务不可用：HTTP {status} {body}"),
    }
}

/// BiRefNet 一键去底（v1.1 端点，零交互全分辨率）。
/// multipart file → POST {base}/api/biref/matting → 全尺寸 RGBA PNG 直返（base64）。
#[tauri::command]
pub async fn biref_matting(base_url: String, image_base64: String) -> Result<String, String> {
    let bytes = STANDARD
        .decode(image_base64.trim())
        .map_err(|e| format!("图片 base64 解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    let url = format!("{}/api/biref/matting", normalize_base_url(&base_url));
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image")
        .mime_str("image/png")
        .map_err(|e| format!("构造上传分片失败：{e}"))?;
    let form = reqwest::multipart::Form::new().part("file", file_part);

    let response = http_client()
        .post(&url)
        .timeout(BIREF_TIMEOUT)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("BiRefNet 抠图服务连接失败：{e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(map_biref_error(status.as_u16(), &body));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if !content_type.starts_with("image/png") {
        return Err(format!(
            "BiRefNet 返回了非 PNG 载荷（Content-Type: {content_type}）"
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("BiRefNet 载荷读取失败：{e}"))?;
    Ok(STANDARD.encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_trims_and_strips_trailing_slash() {
        assert_eq!(
            normalize_base_url("  http://192.168.1.188:8760/  "),
            "http://192.168.1.188:8760"
        );
        assert_eq!(normalize_base_url("http://127.0.0.1:8760"), "http://127.0.0.1:8760");
        assert_eq!(normalize_base_url("   "), "");
    }

    #[test]
    fn validate_model_accepts_whitelist_only() {
        assert!(validate_model("vit_t").is_ok());
        assert!(validate_model("vit_b").is_ok());
        // 服务端升级后新增 vit_l 档，客户端提前放行（旧服务不返回该档，行为不变）
        assert!(validate_model("vit_l").is_ok());
        assert!(validate_model("").is_err());
        assert!(validate_model("VIT_T").is_err());
        assert!(validate_model("vit_x").is_err());
    }

    #[test]
    fn validate_points_rejects_empty_and_malformed() {
        assert!(validate_points(&[]).is_err());
        assert!(validate_points(&[[512.0, 550.0, 1.0]]).is_ok());
        assert!(validate_points(&[[512.0, 550.0, 0.0], [100.0, 900.0, 1.0]]).is_ok());
        // label 只允许 0/1
        assert!(validate_points(&[[512.0, 550.0, 2.0]]).is_err());
        assert!(validate_points(&[[512.0, 550.0, 0.5]]).is_err());
        // 坐标必须有限
        assert!(validate_points(&[[f64::NAN, 550.0, 1.0]]).is_err());
        assert!(validate_points(&[[f64::INFINITY, 550.0, 1.0]]).is_err());
    }

    #[test]
    fn map_decode_error_kind_distinguishes_embed_expiry() {
        assert_eq!(map_decode_error_kind(404), "embed_expired");
        assert_eq!(map_decode_error_kind(400), "bad_request");
        assert_eq!(map_decode_error_kind(500), "service");
        assert_eq!(map_decode_error_kind(413), "service");
    }

    #[test]
    fn sam_command_error_serializes_with_kind_and_message() {
        let error = SamCommandError::new("embed_expired", "需要重新 embed");
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["kind"], "embed_expired");
        assert_eq!(json["message"], "需要重新 embed");
    }

    /// 回归锁（v0.4.4 真机事故）：服务端响应是 snake_case，响应结构体禁用 camelCase
    /// rename——否则 embed_id/vit_t/max_upload_mb 全部落 default，embed 误报「异常载荷」。
    #[test]
    fn embed_response_parses_real_server_snake_payload() {
        // 2026-09-14 内网服务真实响应原文（curl 抓包）
        let payload: SamEmbedResponse = serde_json::from_str(
            r#"{"ok":true,"embed_id":"4510c31cf6464a5eb3445b99303b2bd0","model":"vit_t","width":768,"height":1376,"cached":true}"#,
        )
        .expect("解析真实 embed 响应");
        assert!(payload.ok);
        assert_eq!(payload.embed_id, "4510c31cf6464a5eb3445b99303b2bd0");
        assert_eq!(payload.width, 768);
        assert_eq!(payload.height, 1376);
        assert!(payload.cached);
    }

    #[test]
    fn embed_response_surfaces_server_error_text() {
        let payload: SamEmbedResponse = serde_json::from_str(
            r#"{"ok":false,"error":"请求参数缺失或格式错误: file: Field required"}"#,
        )
        .expect("解析错误响应");
        assert!(!payload.ok);
        assert!(payload.error.contains("Field required"));
    }

    #[test]
    fn health_response_parses_real_server_snake_payload() {
        let payload: SamHealthResponse = serde_json::from_str(
            r#"{"ok":true,"service":"sam-hq-matting","version":"1.0","device":"directml","models":{"vit_t":true,"vit_b":true},"max_upload_mb":50}"#,
        )
        .expect("解析真实 health 响应");
        assert!(payload.ok);
        assert_eq!(payload.models.get("vit_t"), Some(&true));
        assert_eq!(payload.max_upload_mb, 50);
        // 旧服务（只回 vit_t/vit_b）→ 列表保持两档，前端行为零变化
        assert_eq!(
            resolve_model_list(&payload.models),
            vec!["vit_t".to_string(), "vit_b".to_string()]
        );
    }

    #[test]
    fn health_response_parses_upgraded_payload_with_vit_l() {
        // 升级后服务：models 含 vit_l，且 vit_b 可能下线（enabled=false 须过滤）
        let payload: SamHealthResponse = serde_json::from_str(
            r#"{"ok":true,"service":"sam-hq-matting","version":"2.0","device":"cuda","models":{"vit_t":true,"vit_b":false,"vit_l":true},"max_upload_mb":50}"#,
        )
        .expect("解析升级后 health 响应");
        assert_eq!(
            resolve_model_list(&payload.models),
            vec!["vit_t".to_string(), "vit_l".to_string()]
        );
    }

    #[test]
    fn resolve_model_list_orders_known_first_then_unknown_sorted() {
        let mut models = HashMap::new();
        models.insert("vit_l".to_string(), true);
        models.insert("vit_t".to_string(), true);
        models.insert("future_x".to_string(), true);
        models.insert("future_a".to_string(), true);
        models.insert("vit_b".to_string(), false);
        assert_eq!(
            resolve_model_list(&models),
            vec![
                "vit_t".to_string(),
                "vit_l".to_string(),
                "future_a".to_string(),
                "future_x".to_string()
            ]
        );
        // models 字段缺失（default 空 map）→ 空列表，前端走 vit_t/vit_b 兜底
        assert!(resolve_model_list(&HashMap::new()).is_empty());
    }

    /// BiRefNet 壳校验：参数校验先于网络——坏 base64 / 空载荷必须在发请求前拦截。
    #[tokio::test]
    async fn biref_matting_rejects_bad_input_before_network() {
        let bad_base64 = biref_matting("http://127.0.0.1:1".to_string(), "!!!not-base64!!!".to_string()).await;
        assert!(bad_base64.unwrap_err().contains("base64"));
        // 有效 base64 但内容为空
        let empty = biref_matting("http://127.0.0.1:1".to_string(), STANDARD.encode([])).await;
        assert!(empty.unwrap_err().contains("为空"));
        // 合法输入会走到网络层（127.0.0.1:1 必连不上；本机若有系统代理则可能拿到代理的
        // 错误状态码）→ 两种失败都证明已过参数校验、multipart/URL 构造路径可达。
        let network = biref_matting(
            "http://127.0.0.1:1/".to_string(),
            STANDARD.encode(b"png-bytes"),
        )
        .await;
        let network_err = network.unwrap_err();
        assert!(
            network_err.contains("连接失败") || network_err.contains("不可用"),
            "预期网络层错误，实际：{network_err}"
        );
    }

    #[test]
    fn map_biref_error_surfaces_human_messages() {
        assert_eq!(map_biref_error(503, "{}"), "BiRefNet 模型未加载（服务端）");
        assert_eq!(map_biref_error(413, ""), "图片超过 50MB");
        assert!(map_biref_error(500, "boom").contains("AI 去底服务不可用"));
        assert!(map_biref_error(500, "boom").contains("boom"));
    }

    /// 回归锁（v1.1 真机 curl 2026-09-14）：health 新增 birefnet/mask_size 字段。
    #[test]
    fn health_response_parses_v1_1_birefnet_payload() {
        let payload: SamHealthResponse = serde_json::from_str(
            r#"{"ok":true,"service":"sam-hq-matting","version":"1.1","device":"directml","models":{"vit_t":true,"vit_b":true},"max_upload_mb":50,"birefnet":true,"mask_size":1024}"#,
        )
        .expect("解析 v1.1 health 响应");
        assert!(payload.birefnet);
        assert_eq!(payload.mask_size, 1024);
    }

    /// 旧服务（无 birefnet/mask_size 字段）→ 缺省 false / 256，行为零变化。
    #[test]
    fn health_response_defaults_birefnet_fields_for_legacy_server() {
        let payload: SamHealthResponse = serde_json::from_str(
            r#"{"ok":true,"service":"sam-hq-matting","version":"1.0","device":"directml","models":{"vit_t":true,"vit_b":true},"max_upload_mb":50}"#,
        )
        .expect("解析旧版 health 响应");
        assert!(!payload.birefnet);
        assert_eq!(payload.mask_size, 256);
    }
}
