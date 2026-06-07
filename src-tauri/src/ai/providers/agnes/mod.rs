use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const PROVIDER_ID: &str = "agnes";
const DEFAULT_BASE_URL: &str = "https://apihub.agnes-ai.com";
const IMAGE_MODEL: &str = "agnes-image-2.1-flash";
const TEXT_MODEL: &str = "agnes-2.0-flash";
const VIDEO_MODEL: &str = "agnes-video-v2.0";

pub struct AgnesProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    base_url: Arc<RwLock<String>>,
}

#[derive(Debug, Deserialize)]
struct ImageResponse {
    data: Option<Vec<ImageResponseItem>>,
}

#[derive(Debug, Deserialize)]
struct ImageResponseItem {
    url: Option<String>,
    #[serde(rename = "b64_json")]
    b64_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Option<Vec<ChatCompletionChoice>>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoice {
    message: Option<ChatCompletionMessage>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionMessage {
    content: Option<String>,
    refusal: Option<String>,
}

impl AgnesProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: Arc::new(RwLock::new(DEFAULT_BASE_URL.to_string())),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        let mut key = self.api_key.write().await;
        let trimmed = api_key.trim().to_string();
        *key = if trimmed.is_empty() { None } else { Some(trimmed) };
    }

    fn endpoint(base_url: &str, path: &str) -> String {
        let base = base_url.trim().trim_end_matches('/');
        if base.ends_with("/v1") {
            format!("{base}{path}")
        } else {
            format!("{base}/v1{path}")
        }
    }
}

impl Default for AgnesProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn extract_model_name(model: &str) -> &str {
    model.split_once('/').map(|(_, name)| name).unwrap_or(model)
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

fn resolve_inline_image_data_url(source: &str) -> Result<String, AIError> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(AIError::InvalidRequest("empty reference image".to_string()));
    }

    if trimmed.starts_with("data:image/") {
        return Ok(trimmed.to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }

    let path = if trimmed.starts_with("file://") {
        PathBuf::from(decode_file_url_path(trimmed))
    } else {
        PathBuf::from(trimmed)
    };

    let mime = match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        _ => "image/png",
    };

    let bytes = std::fs::read(path)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn resolve_image_size(size: &str, aspect_ratio: &str) -> String {
    let trimmed = size.trim();
    if trimmed.contains('x') {
        return trimmed.to_string();
    }

    let max_edge = match trimmed {
        "2K" => 2048.0,
        "4K" => 4096.0,
        _ => 1024.0,
    };
    let ratio = parse_aspect_ratio(aspect_ratio).unwrap_or(1.0);
    let (width, height) = if ratio >= 1.0 {
        (max_edge, max_edge / ratio)
    } else {
        (max_edge * ratio, max_edge)
    };
    format!("{}x{}", round_to_multiple(width, 8), round_to_multiple(height, 8))
}

fn resolve_video_dimensions(quality: &str, aspect_ratio: &str) -> (i64, i64) {
    let base = match quality.trim().to_ascii_lowercase().as_str() {
        "480p" => 480_i64,
        "1080p" => 1080_i64,
        _ => 720_i64,
    };
    let ratio = parse_aspect_ratio(aspect_ratio).unwrap_or(16.0 / 9.0);
    if ratio >= 1.0 {
        let height = base;
        let width = round_to_multiple(base as f64 * ratio, 8);
        (width.max(8), height.max(8))
    } else {
        let width = base;
        let height = round_to_multiple(base as f64 / ratio, 8);
        (width.max(8), height.max(8))
    }
}

fn resolve_video_duration_seconds(request: &GenerateRequest) -> i64 {
    request
        .extra_params
        .as_ref()
        .and_then(|params| params.get("durationSeconds"))
        .and_then(|value| value.as_i64())
        .unwrap_or(5)
        .clamp(1, 18)
}

fn resolve_video_num_frames(duration_seconds: i64, frame_rate: i64) -> i64 {
    let target = (duration_seconds.max(1) * frame_rate.max(1)).min(441);
    let n = ((target - 1) as f64 / 8.0).round() as i64;
    (n.max(1) * 8 + 1).min(441)
}

fn parse_aspect_ratio(value: &str) -> Option<f64> {
    let (left, right) = value.split_once(':')?;
    let width = left.trim().parse::<f64>().ok()?;
    let height = right.trim().parse::<f64>().ok()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(width / height)
}

fn round_to_multiple(value: f64, step: i64) -> i64 {
    let rounded = (value / step as f64).round() as i64 * step;
    rounded.max(step)
}

fn truncate_str(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &value[..boundary]
}

async fn post_json(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    body: &Value,
) -> Result<String, AIError> {
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await?;

    let status = response.status();
    let raw_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AIError::Provider(format!(
            "Agnes API error {}: {}",
            status,
            truncate_str(raw_text.trim(), 2000)
        )));
    }

    Ok(raw_text)
}

async fn generate_image(
    client: &Client,
    base_url: &str,
    api_key: &str,
    request: &GenerateRequest,
) -> Result<String, AIError> {
    let endpoint = AgnesProvider::endpoint(base_url, "/images/generations");
    let size = resolve_image_size(&request.size, &request.aspect_ratio);
    let reference_images = request.reference_images.as_deref().unwrap_or(&[]);
    let input_images = reference_images
        .iter()
        .map(|image| resolve_inline_image_data_url(image))
        .collect::<Result<Vec<_>, _>>()?;

    let mut body = json!({
        "model": IMAGE_MODEL,
        "prompt": &request.prompt,
        "size": size.clone(),
    });

    if input_images.is_empty() {
        body["return_base64"] = json!(true);
    } else {
        body["image"] = json!(input_images);
        body["extra_body"] = json!({
            "image": body["image"].clone(),
            "response_format": "b64_json",
        });
    }

    info!("[Agnes] image request model={} size={}", IMAGE_MODEL, size);
    let raw_text = post_json(client, &endpoint, api_key, &body).await?;
    let parsed: ImageResponse = serde_json::from_str(&raw_text).map_err(|err| {
        AIError::Provider(format!(
            "Invalid Agnes image response: {}; raw={}",
            err,
            truncate_str(&raw_text, 1000)
        ))
    })?;

    let Some(item) = parsed.data.unwrap_or_default().into_iter().next() else {
        return Err(AIError::Provider(format!(
            "Agnes image response missing data. raw={}",
            truncate_str(&raw_text, 1000)
        )));
    };

    if let Some(b64) = item.b64_json.filter(|value| !value.trim().is_empty()) {
        return Ok(format!("data:image/png;base64,{}", b64.trim()));
    }

    if let Some(url) = item.url.filter(|value| !value.trim().is_empty()) {
        return Ok(url);
    }

    Err(AIError::Provider(format!(
        "Agnes image response missing image payload. raw={}",
        truncate_str(&raw_text, 1000)
    )))
}

fn extract_task_id(value: &Value) -> Option<String> {
    [
        value.pointer("/video_id"),
        value.pointer("/data/video_id"),
        value.pointer("/task_id"),
        value.pointer("/id"),
        value.pointer("/data/task_id"),
        value.pointer("/data/id"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| value.as_str())
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn extract_video_url(value: &Value) -> Option<String> {
    [
        value.pointer("/remixed_from_video_id"),
        value.pointer("/video_url"),
        value.pointer("/url"),
        value.pointer("/data/remixed_from_video_id"),
        value.pointer("/data/video_url"),
        value.pointer("/data/url"),
        value.pointer("/output/video_url"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| value.as_str())
    .map(str::trim)
    .find(|value| value.starts_with("http://") || value.starts_with("https://"))
    .map(ToString::to_string)
}

fn extract_status_text(value: &Value) -> String {
    [
        value.pointer("/status"),
        value.pointer("/data/status"),
        value.pointer("/output/task_status"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| value.as_str())
    .next()
    .unwrap_or("")
    .trim()
    .to_ascii_lowercase()
}

fn extract_error_text(value: &Value) -> String {
    [
        value.pointer("/error"),
        value.pointer("/message"),
        value.pointer("/data/error"),
        value.pointer("/data/message"),
        value.pointer("/output/error"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| value.as_str())
    .map(str::trim)
    .find(|value| !value.is_empty())
    .unwrap_or("task failed")
    .to_string()
}

async fn submit_video_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    request: &GenerateRequest,
) -> Result<ProviderTaskHandle, AIError> {
    let endpoint = AgnesProvider::endpoint(base_url, "/videos");
    let duration_seconds = resolve_video_duration_seconds(request);
    let frame_rate = 24_i64;
    let num_frames = resolve_video_num_frames(duration_seconds, frame_rate);
    let (width, height) = resolve_video_dimensions(&request.size, &request.aspect_ratio);
    let input_images = request
        .reference_images
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|image| resolve_inline_image_data_url(image))
        .collect::<Result<Vec<_>, _>>()?;

    let mut body = json!({
        "model": VIDEO_MODEL,
        "prompt": &request.prompt,
        "height": height,
        "width": width,
        "num_frames": num_frames,
        "frame_rate": frame_rate,
    });

    if input_images.len() == 1 {
        body["image"] = json!(input_images[0]);
    } else if input_images.len() > 1 {
        body["extra_body"] = json!({ "image": input_images });
    }

    info!(
        "[Agnes] video request model={} size={}x{} frames={} fps={}",
        VIDEO_MODEL, width, height, num_frames, frame_rate
    );
    let raw_text = post_json(client, &endpoint, api_key, &body).await?;
    let json_value: Value = serde_json::from_str(&raw_text).map_err(|err| {
        AIError::Provider(format!(
            "Invalid Agnes video submit response: {}; raw={}",
            err,
            truncate_str(&raw_text, 1000)
        ))
    })?;
    let task_id = extract_task_id(&json_value).ok_or_else(|| {
        AIError::Provider(format!(
            "Agnes video submit response missing task id. raw={}",
            truncate_str(&raw_text, 1000)
        ))
    })?;

    Ok(ProviderTaskHandle {
        task_id,
        metadata: Some(json!({ "taskKind": "agnes_video" })),
    })
}

async fn poll_video_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    task_id: &str,
) -> Result<ProviderTaskPollResult, AIError> {
    let base = base_url.trim().trim_end_matches('/').trim_end_matches("/v1");
    let endpoint = if task_id.starts_with("video_") {
        format!("{base}/agnesapi?video_id={task_id}&model_name={VIDEO_MODEL}")
    } else {
        format!("{base}/v1/videos/{task_id}")
    };
    let response = client
        .get(&endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .send()
        .await?;
    let status = response.status();
    let raw_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AIError::Provider(format!(
            "Agnes video poll failed (status {}): {}",
            status,
            truncate_str(raw_text.trim(), 2000)
        )));
    }
    let json_value: Value = serde_json::from_str(&raw_text).map_err(|err| {
        AIError::Provider(format!(
            "Invalid Agnes video poll response: {}; raw={}",
            err,
            truncate_str(&raw_text, 1000)
        ))
    })?;
    let status_text = extract_status_text(&json_value);
    if matches!(
        status_text.as_str(),
        "queued" | "pending" | "running" | "processing" | "in_progress" | ""
    ) {
        return Ok(ProviderTaskPollResult::Running);
    }
    if matches!(
        status_text.as_str(),
        "failed" | "error" | "canceled" | "cancelled"
    ) {
        return Ok(ProviderTaskPollResult::Failed(extract_error_text(&json_value)));
    }
    if matches!(
        status_text.as_str(),
        "completed" | "succeeded" | "success" | "done" | "finished"
    ) {
        if let Some(url) = extract_video_url(&json_value) {
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }
        return Ok(ProviderTaskPollResult::Failed(
            "completed but missing video url".to_string(),
        ));
    }
    Ok(ProviderTaskPollResult::Running)
}

async fn chat_completion(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<Value>,
    max_tokens: u32,
) -> Result<String, AIError> {
    let endpoint = AgnesProvider::endpoint(base_url, "/chat/completions");
    let body = json!({
        "model": model,
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": max_tokens,
    });
    let raw_text = post_json(client, &endpoint, api_key, &body).await?;
    let parsed: ChatCompletionResponse = serde_json::from_str(&raw_text).map_err(|err| {
        AIError::Provider(format!(
            "Invalid Agnes chat response: {}; raw={}",
            err,
            truncate_str(&raw_text, 1000)
        ))
    })?;
    let content = parsed
        .choices
        .unwrap_or_default()
        .into_iter()
        .filter_map(|choice| choice.message)
        .filter_map(|message| message.content.or(message.refusal))
        .next()
        .unwrap_or_default();
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AIError::Provider(format!(
            "Agnes chat response returned empty content. raw={}",
            truncate_str(&raw_text, 1000)
        )));
    }
    Ok(trimmed.to_string())
}

#[async_trait::async_trait]
impl AIProvider for AgnesProvider {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn name(&self) -> &str {
        PROVIDER_ID
    }

    fn supports_model(&self, model: &str) -> bool {
        model.starts_with("agnes/") || model == IMAGE_MODEL || model == TEXT_MODEL
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            format!("{PROVIDER_ID}/{IMAGE_MODEL}"),
            format!("{PROVIDER_ID}/{TEXT_MODEL}"),
            format!("{PROVIDER_ID}/{VIDEO_MODEL}"),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        AgnesProvider::set_api_key(self, api_key).await;
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn submit_task(&self, request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;
        let base_url = self.base_url.read().await.clone();
        let model_name = extract_model_name(&request.model);
        if model_name == VIDEO_MODEL {
            let handle = submit_video_task(&self.client, &base_url, &api_key, &request).await?;
            return Ok(ProviderTaskSubmission::Queued(handle));
        }
        if model_name == IMAGE_MODEL {
            let image_source = generate_image(&self.client, &base_url, &api_key, &request).await?;
            return Ok(ProviderTaskSubmission::Succeeded(image_source));
        }
        Err(AIError::ModelNotSupported(request.model))
    }

    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;
        let base_url = self.base_url.read().await.clone();
        let kind = handle
            .metadata
            .as_ref()
            .and_then(|value| value.get("taskKind"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if kind == "agnes_video" {
            return poll_video_task(&self.client, &base_url, &api_key, &handle.task_id).await;
        }
        Err(AIError::TaskNotFound(handle.task_id))
    }

    async fn reverse_prompt(
        &self,
        image: String,
        language: Option<String>,
        format: Option<String>,
        model: Option<String>,
    ) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;
        let base_url = self.base_url.read().await.clone();
        let image_url = resolve_inline_image_data_url(&image)?;
        let resolved_language = language.unwrap_or_else(|| "zh".to_string());
        let resolved_format = format.unwrap_or_else(|| "text".to_string());
        let resolved_model = model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(TEXT_MODEL);

        let system = if resolved_format == "json" {
            "You are a visual prompt analyst. Analyze the image and output strictly valid JSON only."
        } else if resolved_language.starts_with("en") {
            "You are a prompt engineer. Given an image, output a single image-generation prompt. Output only the prompt."
        } else {
            "你是提示词工程师。根据图片内容输出一段可直接用于图像生成的提示词。必须使用简体中文，只输出提示词本身。"
        };
        let user_text = if resolved_format == "json" {
            "Analyze subject, composition, style, color, lighting, and reusable generation constraints."
        } else {
            "Describe this image as a reusable prompt for image generation."
        };

        chat_completion(
            &self.client,
            &base_url,
            &api_key,
            resolved_model,
            vec![
                json!({ "role": "system", "content": system }),
                json!({
                    "role": "user",
                    "content": [
                        { "type": "text", "text": user_text },
                        { "type": "image_url", "image_url": { "url": image_url } }
                    ]
                }),
            ],
            1200,
        )
        .await
    }

    async fn craft_image_prompt(
        &self,
        user_input: &str,
        category: Option<&str>,
        model: Option<&str>,
        language: Option<&str>,
    ) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;
        let base_url = self.base_url.read().await.clone();
        let resolved_model = model
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(TEXT_MODEL);
        let category_hint = category.unwrap_or("general");
        let mut system = format!(
            "You are a senior image prompt engineer. Turn user intent into a detailed prompt for image generation. Category: {category_hint}. Output only the final prompt, no markdown."
        );
        if language == Some("zh") {
            system.push_str(" 使用简体中文输出。画面中需要精确呈现的文字内容保留原文并用引号包裹。");
        } else {
            system.push_str(" Write in English unless exact visible text must keep the user's original language.");
        }

        chat_completion(
            &self.client,
            &base_url,
            &api_key,
            resolved_model,
            vec![
                json!({ "role": "system", "content": system }),
                json!({ "role": "user", "content": user_input }),
            ],
            1200,
        )
        .await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;
        let base_url = self.base_url.read().await.clone();
        let model_name = extract_model_name(&request.model);
        if model_name == VIDEO_MODEL {
            let handle = submit_video_task(&self.client, &base_url, &api_key, &request).await?;
            loop {
                match poll_video_task(&self.client, &base_url, &api_key, &handle.task_id).await? {
                    ProviderTaskPollResult::Running => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                    ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                    ProviderTaskPollResult::Failed(message) => {
                        return Err(AIError::TaskFailed(message));
                    }
                }
            }
        }
        if model_name != IMAGE_MODEL {
            return Err(AIError::ModelNotSupported(request.model));
        }
        generate_image(&self.client, &base_url, &api_key, &request).await
    }
}
