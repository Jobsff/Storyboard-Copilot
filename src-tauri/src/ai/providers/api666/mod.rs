use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

pub struct Api666Provider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    base_url: String,
}

#[derive(Debug, Deserialize)]
struct GeminiGenerateResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Debug, Deserialize)]
struct GeminiPart {
    #[serde(rename = "inlineData")]
    inline_data: Option<GeminiInlineData>,
}

#[derive(Debug, Deserialize)]
struct GeminiInlineData {
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Api666TaskSubmitResponse {
    code: Option<i64>,
    data: Option<Vec<Api666TaskSubmitItem>>,
}

#[derive(Debug, Deserialize)]
struct Api666TaskSubmitItem {
    status: Option<String>,
    #[serde(rename = "task_id")]
    task_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Api666TaskStatusResponse {
    code: Option<i64>,
    data: Option<Api666TaskStatusData>,
}

#[derive(Debug, Deserialize)]
struct Api666TaskStatusData {
    status: Option<String>,
    result: Option<Api666TaskResult>,
    error: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Api666TaskResult {
    images: Option<Vec<Api666TaskImage>>,
}

#[derive(Debug, Deserialize)]
struct Api666TaskImage {
    url: Option<Vec<String>>,
}

impl Api666Provider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: "https://www.666api.ai".to_string(),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
    }
}

impl Default for Api666Provider {
    fn default() -> Self {
        Self::new()
    }
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

fn resolve_inline_image_payload(source: &str) -> Option<(String, String)> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((meta, payload)) = trimmed.split_once(',') {
        if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
            let mime = meta
                .trim_start_matches("data:")
                .trim_end_matches(";base64")
                .trim()
                .to_string();
            return Some((mime, payload.to_string()));
        }
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
    }
    .to_string();

    let bytes = std::fs::read(path).ok()?;
    Some((mime, STANDARD.encode(bytes)))
}

fn extract_model_name(model: &str) -> Option<String> {
    let (provider, name) = model.split_once('/')?;
    if provider != "666api" {
        return None;
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn resolve_openai_image_size(request_size: &str, aspect_ratio: &str) -> String {
    let base = match request_size.trim() {
        "4K" => 4096,
        "2K" => 2048,
        "1K" => 1024,
        "0.5K" => 512,
        _ => 1024,
    };

    let ratio = {
        let trimmed = aspect_ratio.trim();
        let mut parts = trimmed.split(':');
        let w = parts.next().and_then(|v| v.parse::<f32>().ok()).unwrap_or(1.0);
        let h = parts.next().and_then(|v| v.parse::<f32>().ok()).unwrap_or(1.0);
        if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
            w / h
        } else {
            1.0
        }
    };

    let (w, h) = if ratio > 1.18 {
        (base * 3 / 2, base)
    } else if ratio < 0.85 {
        (base, base * 3 / 2)
    } else {
        (base, base)
    };

    format!("{}x{}", w, h)
}

async fn submit_gpt_image_2_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    request: &GenerateRequest,
) -> Result<String, AIError> {
    let endpoint = format!("{}/v1/images/generations", base_url);
    let resolved_size = resolve_openai_image_size(&request.size, &request.aspect_ratio);
    let body = json!({
        "model": "gpt-image-2",
        "prompt": request.prompt,
        "n": 1,
        "size": resolved_size
    });

    info!("[666API GPT-IMAGE-2] submit URL: {}", endpoint);

    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format!(
            "API error {}: {}",
            status, error_text
        )));
    }

    let result: Api666TaskSubmitResponse = response.json().await?;
    if result.code.unwrap_or(200) != 200 {
        return Err(AIError::Provider(format!(
            "Unexpected submit response: {:?}",
            result
        )));
    }

    let item = result
        .data
        .unwrap_or_default()
        .into_iter()
        .next()
        .ok_or_else(|| AIError::Provider("No task_id in response".to_string()))?;

    let task_id = item
        .task_id
        .unwrap_or_default()
        .trim()
        .to_string();
    if task_id.is_empty() {
        return Err(AIError::Provider("No task_id in response".to_string()));
    }

    Ok(task_id)
}

async fn poll_gpt_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    task_id: &str,
) -> Result<ProviderTaskPollResult, AIError> {
    let endpoint = format!("{}/v1/tasks/{}", base_url, task_id);
    let response = client
        .get(&endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format!(
            "API error {}: {}",
            status, error_text
        )));
    }

    let result: Api666TaskStatusResponse = response.json().await?;
    let data = result
        .data
        .ok_or_else(|| AIError::Provider("Missing task status payload".to_string()))?;

    let status = data.status.unwrap_or_default().to_ascii_lowercase();
    if status == "completed" || status == "succeeded" || status == "success" {
        let url = data
            .result
            .and_then(|result| result.images)
            .and_then(|images| images.into_iter().next())
            .and_then(|image| image.url)
            .and_then(|urls| urls.into_iter().next())
            .unwrap_or_default()
            .trim()
            .to_string();
        if url.is_empty() {
            return Ok(ProviderTaskPollResult::Failed(
                "completed but missing image url".to_string(),
            ));
        }
        return Ok(ProviderTaskPollResult::Succeeded(url));
    }

    if status == "failed" || status == "error" {
        let message = data
            .error
            .or(data.message)
            .unwrap_or_else(|| "task failed".to_string());
        return Ok(ProviderTaskPollResult::Failed(message));
    }

    Ok(ProviderTaskPollResult::Running)
}

async fn generate_via_gemini_native(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model_name: &str,
    request: GenerateRequest,
) -> Result<String, AIError> {
    let endpoint = format!("{}/v1beta/models/{}:generateContent", base_url, model_name);

    let mut parts = vec![json!({ "text": request.prompt })];
    let images = request.reference_images.unwrap_or_default();
    for image in images.iter() {
        if let Some((mime, data)) = resolve_inline_image_payload(image) {
            parts.push(json!({
                "inlineData": {
                    "mimeType": mime,
                    "data": data
                }
            }));
        }
    }

    let body = json!({
        "contents": [{
            "role": "user",
            "parts": parts
        }],
        "generationConfig": {
            "aspectRatio": request.aspect_ratio
        }
    });

    info!("[666API Gemini] URL: {}", endpoint);

    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format!(
            "API error {}: {}",
            status, error_text
        )));
    }

    let result: GeminiGenerateResponse = response.json().await?;
    let inline = result
        .candidates
        .unwrap_or_default()
        .into_iter()
        .filter_map(|candidate| candidate.content)
        .flat_map(|content| content.parts.unwrap_or_default())
        .filter_map(|part| part.inline_data)
        .find(|inline| {
            inline
                .mime_type
                .as_deref()
                .map(|mime| mime.starts_with("image/"))
                .unwrap_or(false)
                && inline.data.as_deref().map(|v| !v.is_empty()).unwrap_or(false)
        })
        .ok_or_else(|| AIError::Provider("No image payload in response".to_string()))?;

    let mime = inline.mime_type.unwrap_or_else(|| "image/png".to_string());
    let data = inline
        .data
        .ok_or_else(|| AIError::Provider("No image payload in response".to_string()))?;
    Ok(format!("data:{};base64,{}", mime, data))
}

#[async_trait::async_trait]
impl AIProvider for Api666Provider {
    fn name(&self) -> &str {
        "666api"
    }

    fn supports_model(&self, model: &str) -> bool {
        model.starts_with("666api/")
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "666api/gemini-3.1-flash-image-preview".to_string(),
            "666api/gemini-3-pro-image-preview".to_string(),
            "666api/gpt-image-2".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        Api666Provider::set_api_key(self, api_key).await;
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

        let model_name = extract_model_name(&request.model)
            .ok_or_else(|| AIError::ModelNotSupported(request.model.clone()))?;

        if model_name == "gpt-image-2" {
            let task_id =
                submit_gpt_image_2_task(&self.client, &self.base_url, &api_key, &request).await?;
            return Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
                task_id,
                metadata: None,
            }));
        }

        if model_name.starts_with("gemini-") {
            let image_source = generate_via_gemini_native(
                &self.client,
                &self.base_url,
                &api_key,
                &model_name,
                request,
            )
            .await?;
            return Ok(ProviderTaskSubmission::Succeeded(image_source));
        }

        Err(AIError::ModelNotSupported(format!("666api/{}", model_name)))
    }

    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        poll_gpt_task(&self.client, &self.base_url, &api_key, &handle.task_id).await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let model_name = extract_model_name(&request.model)
            .ok_or_else(|| AIError::ModelNotSupported(request.model.clone()))?;

        if model_name.starts_with("gemini-") {
            return generate_via_gemini_native(
                &self.client,
                &self.base_url,
                &api_key,
                &model_name,
                request,
            )
            .await;
        }

        if model_name == "gpt-image-2" {
            let task_id =
                submit_gpt_image_2_task(&self.client, &self.base_url, &api_key, &request).await?;
            for _ in 0..60 {
                match poll_gpt_task(&self.client, &self.base_url, &api_key, &task_id).await? {
                    ProviderTaskPollResult::Running => {
                        sleep(Duration::from_secs(3)).await;
                    }
                    ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                    ProviderTaskPollResult::Failed(message) => return Err(AIError::TaskFailed(message)),
                }
            }
            return Err(AIError::Provider("Task pending too long".to_string()));
        }

        Err(AIError::ModelNotSupported(format!(
            "666api/{}",
            model_name
        )))
    }
}
