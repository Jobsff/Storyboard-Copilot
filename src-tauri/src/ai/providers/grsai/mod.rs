use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;
use base64::{engine::general_purpose::STANDARD, Engine};

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const DRAW_ENDPOINT_PATH: &str = "/v1/draw/nano-banana";
const RESULT_ENDPOINT_PATH: &str = "/v1/draw/result";
/// gpt 系模型专用端点（批次9）：同步 JSON 返回，nano 系继续走 /v1/draw 不动。
/// 移植自 image-studio 技能 _grsai_call（2026-09-10 实测）。
const GENERATE_ENDPOINT_PATH: &str = "/v1/api/generate";
const DEFAULT_BASE_URL: &str = "https://grsai.dakka.com.cn";
const DEFAULT_PRO_MODEL: &str = "nano-banana-pro";
const POLL_INTERVAL_MS: u64 = 2000;

const SUPPORTED_MODELS: [&str; 10] = [
    "nano-banana-2",
    "nano-banana-pro",
    "nano-banana-pro-vt",
    "nano-banana-pro-cl",
    "nano-banana-pro-vip",
    "nano-banana-pro-4k-vip",
    "grsai/nano-banana-pro",
    // gpt 系（批次9）：/v1/api/generate 路径
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
];

/// gpt 系走 /v1/api/generate 时 aspectRatio 一律换算像素串（官方比例参考表，
/// 2026-09-10 抓取自 apifox 文档，从 image-studio 技能 GRSAI_GPT_PX 逐格抄全）：
/// flare/sunburst 不支持比例串，支持 1-4K 像素值。
const GRSAI_GPT_PX: [(&str, [&str; 3]); 13] = [
    ("1:1", ["1024x1024", "2048x2048", "2880x2880"]),
    ("16:9", ["1280x720", "2048x1152", "3840x2160"]),
    ("9:16", ["720x1280", "1152x2048", "2160x3840"]),
    ("4:3", ["1152x864", "2304x1728", "3264x2448"]),
    ("3:4", ["864x1152", "1728x2304", "2448x3264"]),
    ("3:2", ["1536x1024", "2048x1360", "3504x2336"]),
    ("2:3", ["1024x1536", "1360x2048", "2336x3504"]),
    ("5:4", ["1120x896", "2240x1792", "3200x2560"]),
    ("4:5", ["896x1120", "1792x2240", "2560x3200"]),
    ("21:9", ["1456x624", "2912x1248", "3840x1648"]),
    ("9:21", ["624x1456", "1248x2912", "1648x3840"]),
    ("2:1", ["1536x768", "3072x1536", "3840x1920"]),
    ("1:2", ["768x1536", "1536x3072", "1920x3840"]),
];

/// gpt-image-2（无后缀）单档像素串：上限 1024 级（实测回约 1254²）。
/// 从 image-studio 技能 GRSAI_GPT2_PX 逐格抄全（10 比例）。
const GRSAI_GPT2_PX: [(&str, &str); 10] = [
    ("1:1", "1024x1024"),
    ("16:9", "1672x941"),
    ("9:16", "941x1672"),
    ("4:3", "1443x1090"),
    ("3:4", "1090x1443"),
    ("3:2", "1536x1024"),
    ("2:3", "1024x1536"),
    ("5:4", "1408x1120"),
    ("4:5", "1120x1408"),
    ("21:9", "1920x832"),
];

/// gpt-2.5 系透传质量档（仅这五个值会写进 body.quality；网关按张平价）。
const GPT25_QUALITIES: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// grsai gpt 系模型分类："single"=gpt-image-2 单档表；"multi"=gpt-image-2.5 系三档表；
/// None=非 gpt 系（nano 系走比例串 + /v1/draw）。
fn grsai_gpt_class(model: &str) -> Option<&'static str> {
    let lowered = model.trim().to_lowercase();
    if lowered == "gpt-image-2" {
        return Some("single");
    }
    if lowered.starts_with("gpt-image-2.5") {
        return Some("multi");
    }
    None
}

fn is_gpt_model(model: &str) -> bool {
    grsai_gpt_class(model).is_some()
}

/// ratio + size 档（1K/2K/4K）→ gpt 系像素串；查不到表退回原比例串
/// （对齐技能 _grsai_gpt_pixel 的 fallback 语义）。
fn resolve_gpt_pixel(aspect: &str, size: &str, gpt_class: &str) -> String {
    let aspect = aspect.trim();
    let size_index = match size.trim().to_uppercase().as_str() {
        "1K" => Some(0usize),
        "2K" => Some(1),
        "4K" => Some(2),
        _ => None,
    };
    if gpt_class == "single" {
        if let Some((_, pixel)) = GRSAI_GPT2_PX.iter().find(|(ratio, _)| *ratio == aspect) {
            return pixel.to_string();
        }
        return aspect.to_string();
    }
    if let Some(index) = size_index {
        if let Some((_, pixels)) = GRSAI_GPT_PX.iter().find(|(ratio, _)| *ratio == aspect) {
            return pixels[index].to_string();
        }
    }
    aspect.to_string()
}

fn decode_file_url_path(value: &str) -> String {
    let raw = value.trim_start_matches("file://");
    let decoded = urlencoding::decode(raw)
        .map(|result| result.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let normalized = if decoded.starts_with('/')
        && decoded.len() > 2
        && decoded.as_bytes().get(2) == Some(&b':')
    {
        &decoded[1..]
    } else {
        &decoded
    };
    normalized.to_string()
}

fn encode_reference_for_grsai(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(trimmed.to_string());
    }

    if let Some((meta, payload)) = trimmed.split_once(',') {
        if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
            return Some(payload.to_string());
        }
    }

    let likely_base64 = trimmed.len() > 256
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
    if likely_base64 {
        return Some(trimmed.to_string());
    }

    let path = if trimmed.starts_with("file://") {
        PathBuf::from(decode_file_url_path(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    let bytes = std::fs::read(path).ok()?;
    Some(STANDARD.encode(bytes))
}

/// 猜参考图 MIME（dataURL 头用；gpt 系 /v1/api/generate 专用）。
fn guess_image_mime(path: &std::path::Path, bytes: &[u8]) -> String {
    if let Some(ext) = path.extension().and_then(|ext| ext.to_str()) {
        match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => return "image/jpeg".to_string(),
            "webp" => return "image/webp".to_string(),
            "png" => return "image/png".to_string(),
            _ => {}
        }
    }
    // 魔数兜底：PNG/JPEG 常见，其余默认 png。
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png".to_string()
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg".to_string()
    } else {
        "image/png".to_string()
    }
}

/// gpt 系参考图编码（批次9 铁律：2.5 家族 i2i 参考**必须 base64 dataURL**——
/// http URL 秒挂 Upstream stream interrupted，2026-09-10 三连挂实证）。
/// dataURL 原样；本地/file 路径读文件转 dataURL；http(s) URL 下载后转 dataURL。
async fn encode_reference_as_dataurl(client: &Client, source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("data:") && trimmed.contains(";base64,") {
        return Some(trimmed.to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let response = client.get(trimmed).send().await.ok()?;
        let bytes = response.bytes().await.ok()?;
        let mime = bytes
            .get(0..3)
            .map(|head| {
                if head.starts_with(&[0x89, b'P', b'N']) {
                    "image/png"
                } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
                    "image/jpeg"
                } else {
                    "image/png"
                }
            })
            .unwrap_or("image/png");
        return Some(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)));
    }

    let path = if trimmed.starts_with("file://") {
        PathBuf::from(decode_file_url_path(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    let bytes = std::fs::read(&path).ok()?;
    let mime = guess_image_mime(&path, &bytes);
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

/// 按字符数截断（错误摘要用，防大响应体滞留日志）。
fn chain_safe_truncate(input: &str, max_chars: usize) -> String {
    input.chars().take(max_chars).collect()
}

/// gpt 系守卫谓词（对齐 nano 路径 request_draw 口径）：原始参考图列表非空
/// && 编码结果全失败（空）才报错。Some(空数组)（前端 t2i 传 referenceImages: []）
/// 与 None 均按 t2i 放行（2026-09-11 热修：修 Some(vec![]) 误报 InvalidRequest）。
fn references_all_failed_to_encode(original: &[String], encoded: &[String]) -> bool {
    !original.is_empty() && encoded.is_empty()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DrawRequestBody {
    model: String,
    prompt: String,
    aspect_ratio: String,
    image_size: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    urls: Option<Vec<String>>,
    web_hook: String,
    shut_progress: bool,
}

pub struct GrsaiProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    base_url: String,
}

impl GrsaiProvider {
    pub fn new() -> Self {
        Self {
            client: crate::ai::http::http_client().clone(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: DEFAULT_BASE_URL.to_string(),
        }
    }

    fn normalize_requested_model(&self, request: &GenerateRequest) -> String {
        let requested = request
            .model
            .split_once('/')
            .map(|(_, model)| model.to_string())
            .unwrap_or_else(|| request.model.clone());

        // gpt 系（批次9）：模型名原样透传给 /v1/api/generate，不做 nano 归一化。
        if is_gpt_model(&requested) {
            return requested;
        }

        if requested == "nano-banana-2" {
            return requested;
        }

        if requested == "nano-banana-pro" || requested.starts_with("nano-banana-pro-") {
            return request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("grsai_pro_model"))
                .and_then(|value| value.as_str())
                .map(Self::normalize_pro_variant)
                .unwrap_or_else(|| requested);
        }

        DEFAULT_PRO_MODEL.to_string()
    }

    fn normalize_pro_variant(input: &str) -> String {
        let trimmed = input.trim().to_lowercase();
        if trimmed == DEFAULT_PRO_MODEL || trimmed.starts_with("nano-banana-pro-") {
            return trimmed;
        }
        DEFAULT_PRO_MODEL.to_string()
    }

    fn resolve_task_payload<'a>(value: &'a Value) -> Result<&'a Value, AIError> {
        if let Some(code) = value.get("code").and_then(|raw| raw.as_i64()) {
            if code != 0 {
                let msg = value
                    .get("msg")
                    .and_then(|raw| raw.as_str())
                    .unwrap_or("unknown error");
                return Err(AIError::Provider(format!("GRSAI API code {}: {}", code, msg)));
            }
            return value
                .get("data")
                .ok_or_else(|| AIError::Provider("GRSAI response missing data field".to_string()));
        }

        Ok(value)
    }

    fn extract_result_url(payload: &Value) -> Option<String> {
        payload
            .get("results")
            .and_then(|results| results.as_array())
            .and_then(|results| results.first())
            .and_then(|first| first.get("url"))
            .and_then(|url| url.as_str())
            .map(|url| url.to_string())
    }

    async fn request_draw(&self, request: &GenerateRequest, model: String) -> Result<Value, AIError> {
        let body = DrawRequestBody {
            model,
            prompt: request.prompt.clone(),
            aspect_ratio: request.aspect_ratio.clone(),
            image_size: request.size.clone(),
            urls: request
                .reference_images
                .as_ref()
                .map(|images| {
                    images
                        .iter()
                        .filter_map(|image| encode_reference_for_grsai(image))
                        .collect::<Vec<_>>()
                })
                .filter(|images| !images.is_empty()),
            web_hook: "-1".to_string(),
            shut_progress: true,
        };

        if request
            .reference_images
            .as_ref()
            .map(|images| !images.is_empty())
            .unwrap_or(false)
            && body.urls.is_none()
        {
            return Err(AIError::InvalidRequest(
                "Reference images are present but none could be encoded for GRSAI".to_string(),
            ));
        }

        let endpoint = format!("{}{}", self.base_url, DRAW_ENDPOINT_PATH);
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        info!("[GRSAI API] URL: {}", endpoint);
        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "GRSAI draw request failed {}: {}",
                status, error_text
            )));
        }

        response.json::<Value>().await.map_err(AIError::from)
    }

    async fn poll_result_once(&self, task_id: &str) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}{}", self.base_url, RESULT_ENDPOINT_PATH);
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&json!({ "id": task_id }))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "GRSAI result request failed {}: {}",
                status, error_text
            )));
        }

        let poll_response = response.json::<Value>().await?;
        let payload = Self::resolve_task_payload(&poll_response)?;

        if let Some(url) = Self::extract_result_url(payload) {
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }

        match payload.get("status").and_then(|raw| raw.as_str()) {
            Some("running") | None => Ok(ProviderTaskPollResult::Running),
            Some("failed") => {
                let reason = payload
                    .get("error")
                    .and_then(|raw| raw.as_str())
                    .filter(|value| !value.is_empty())
                    .or_else(|| payload.get("failure_reason").and_then(|raw| raw.as_str()))
                    .unwrap_or("unknown failure");
                Ok(ProviderTaskPollResult::Failed(reason.to_string()))
            }
            Some(other) => Err(AIError::Provider(format!("GRSAI unexpected task status: {}", other))),
        }
    }

    async fn poll_result_until_complete(&self, task_id: &str) -> Result<String, AIError> {
        loop {
            match self.poll_result_once(task_id).await? {
                ProviderTaskPollResult::Running => sleep(Duration::from_millis(POLL_INTERVAL_MS)).await,
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::Failed(message) => return Err(AIError::TaskFailed(message)),
            }
        }
    }

    /// gpt 系调用路径（批次9）：POST /v1/api/generate，同步 JSON 返回。
    /// 协议逐条移植自 image-studio 技能 _grsai_call（2026-09-10 实测）：
    /// - images 一律 base64 dataURL（http URL 必挂）；t2i 为空数组
    /// - aspectRatio 用像素串（gpt 系不认比例串）；size 档折进像素串，不另传 imageSize
    /// - background:"transparent"（透明底参数透传，gpt-image-2 专用）
    /// - quality 仅 gpt-2.5 系透传（low/medium/high/xhigh/max）
    /// - replyType:"json" 必传，否则回 SSE data: 行
    /// - 响应 status=="succeeded" 时 results[0].url（http 或 dataURL）
    async fn request_generate(&self, request: &GenerateRequest, model: String) -> Result<String, AIError> {
        let gpt_class = grsai_gpt_class(&model).unwrap_or("multi");
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let mut images: Vec<String> = Vec::new();
        if let Some(reference_images) = request.reference_images.as_ref() {
            for image in reference_images {
                if let Some(dataurl) = encode_reference_as_dataurl(&self.client, image).await {
                    images.push(dataurl);
                }
            }
            // 守卫对齐 nano 路径（request_draw）口径：原始列表非空 && 编码结果为空才算全失败。
            // Some(空数组)（前端 t2i 会传 referenceImages: []）与 None 一律走 t2i（2026-09-11 热修）。
            if references_all_failed_to_encode(reference_images, &images) {
                return Err(AIError::InvalidRequest(
                    "Reference images are present but none could be encoded for GRSAI".to_string(),
                ));
            }
        }

        let mut body = json!({
            "model": model,
            "prompt": request.prompt.clone(),
            "images": images,
            "aspectRatio": resolve_gpt_pixel(&request.aspect_ratio, &request.size, gpt_class),
            "replyType": "json",
        });
        // 透明底参数（gpt-image-2 专用）：前端 extraParams.transparent_background 透传。
        if request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("transparent_background"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            body["background"] = json!("transparent");
        }
        // 质量档仅 gpt-2.5 系透传（五档白名单；auto/其他值不写 body）。
        if gpt_class == "multi" {
            if let Some(quality) = request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("quality"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| GPT25_QUALITIES.contains(&value.to_lowercase().as_str()))
            {
                body["quality"] = json!(quality.to_lowercase());
            }
        }

        let endpoint = format!("{}{}", self.base_url, GENERATE_ENDPOINT_PATH);
        info!(
            "[GRSAI API] generate endpoint: {}, aspectRatio: {}",
            endpoint,
            body["aspectRatio"].as_str().unwrap_or("")
        );
        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let raw_text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "GRSAI generate request failed {}: {}",
                status,
                chain_safe_truncate(&raw_text, 300)
            )));
        }

        let value: Value = serde_json::from_str(&raw_text).map_err(|error| {
            AIError::Provider(format!("GRSAI generate non-JSON response: {}", error))
        })?;

        let task_status = value.get("status").and_then(|raw| raw.as_str()).unwrap_or("");
        if task_status != "succeeded" {
            let reason = value
                .get("error")
                .and_then(|raw| raw.as_str())
                .or_else(|| value.get("failure_reason").and_then(|raw| raw.as_str()))
                .unwrap_or("unknown failure");
            return Err(AIError::TaskFailed(format!(
                "{}: {}",
                if task_status.is_empty() { "no-status" } else { task_status },
                reason
            )));
        }

        let url = value
            .get("results")
            .and_then(|results| results.as_array())
            .and_then(|results| results.first())
            .and_then(|first| first.get("url"))
            .and_then(|url| url.as_str())
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| AIError::Provider("GRSAI generate succeeded but no image url".to_string()))?;
        Ok(url.to_string())
    }
}

impl Default for GrsaiProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for GrsaiProvider {
    fn as_any(&self) -> &dyn std::any::Any { self }

    fn name(&self) -> &str {
        "grsai"
    }

    fn supports_model(&self, model: &str) -> bool {
        if model.starts_with("grsai/") {
            return true;
        }
        SUPPORTED_MODELS.contains(&model)
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "grsai/nano-banana-2".to_string(),
            "grsai/nano-banana-pro".to_string(),
            // gpt 系（批次9）
            "grsai/gpt-image-2".to_string(),
            "grsai/gpt-image-2.5-flare".to_string(),
            "grsai/gpt-image-2.5-sunburst".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn submit_task(&self, request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        let model = self.normalize_requested_model(&request);

        // gpt 系（批次9）：/v1/api/generate 同步返回，不进 webhook 轮询。
        if is_gpt_model(&model) {
            let url = self.request_generate(&request, model).await?;
            return Ok(ProviderTaskSubmission::Succeeded(url));
        }

        let draw_response = self.request_draw(&request, model).await?;
        let payload = Self::resolve_task_payload(&draw_response)?;

        if let Some(url) = Self::extract_result_url(payload) {
            return Ok(ProviderTaskSubmission::Succeeded(url));
        }

        let task_id = payload
            .get("id")
            .and_then(|raw| raw.as_str())
            .ok_or_else(|| AIError::Provider("GRSAI response missing task id".to_string()))?;
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id: task_id.to_string(),
            metadata: None,
        }))
    }

    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        self.poll_result_once(handle.task_id.as_str()).await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let model = self.normalize_requested_model(&request);
        info!(
            "[GRSAI Request] model: {}, size: {}, aspect_ratio: {}",
            model, request.size, request.aspect_ratio
        );

        // gpt 系（批次9）：/v1/api/generate 同步返回。
        if is_gpt_model(&model) {
            return self.request_generate(&request, model).await;
        }

        let draw_response = self.request_draw(&request, model).await?;
        let payload = Self::resolve_task_payload(&draw_response)?;

        if let Some(url) = Self::extract_result_url(payload) {
            return Ok(url);
        }

        let task_id = payload
            .get("id")
            .and_then(|raw| raw.as_str())
            .ok_or_else(|| AIError::Provider("GRSAI response missing task id".to_string()))?;

        self.poll_result_until_complete(task_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpt_pixel_single_table_and_fallback() {
        // gpt-image-2 单档表（1:1 → 1024x1024）；未知比例退回比例串
        assert_eq!(resolve_gpt_pixel("1:1", "1K", "single"), "1024x1024");
        assert_eq!(resolve_gpt_pixel("21:9", "1K", "single"), "1920x832");
        assert_eq!(resolve_gpt_pixel("9:21", "1K", "single"), "9:21");
    }

    #[test]
    fn gpt_pixel_multi_table_folds_size_tier() {
        // gpt-2.5 系：size 档折进像素串（3:2 4K → 3504x2336，技能实测例）
        assert_eq!(resolve_gpt_pixel("3:2", "4K", "multi"), "3504x2336");
        assert_eq!(resolve_gpt_pixel("1:1", "1K", "multi"), "1024x1024");
        assert_eq!(resolve_gpt_pixel("2:3", "2K", "multi"), "1360x2048");
        // 未知比例 / 未知档退回比例串（对齐 _grsai_gpt_pixel fallback）
        assert_eq!(resolve_gpt_pixel("7:5", "4K", "multi"), "7:5");
    }

    #[test]
    fn gpt_class_dispatch() {
        assert_eq!(grsai_gpt_class("gpt-image-2"), Some("single"));
        assert_eq!(grsai_gpt_class("GPT-Image-2.5-Flare"), Some("multi"));
        assert_eq!(grsai_gpt_class("nano-banana-2"), None);
        assert!(is_gpt_model("gpt-image-2.5-sunburst"));
        assert!(!is_gpt_model("nano-banana-pro"));
    }

    #[test]
    fn gpt_reference_guard_allows_empty_and_none() {
        // Some(空数组)：前端 t2i 传 referenceImages: []，必须放行（2026-09-11 热修回归锁）
        assert!(!references_all_failed_to_encode(&[], &[]));
        // 原始非空 && 编码全失败：才是真错误
        assert!(references_all_failed_to_encode(
            &["bad-source".to_string()],
            &[]
        ));
        // 部分编码成功：放行
        assert!(!references_all_failed_to_encode(
            &["a".to_string(), "b".to_string()],
            &["data:image/png;base64,xxx".to_string()]
        ));
    }
}
