use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{AIProvider, GenerateRequest};

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
struct OpenAiImagesResponse {
    data: Option<Vec<OpenAiImagesItem>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImagesItem {
    #[serde(rename = "b64_json")]
    b64_json: Option<String>,
    url: Option<String>,
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
    let (w, h) = match aspect_ratio.trim() {
        "16:9" | "3:2" | "4:3" | "5:4" => (1536, 1024),
        "9:16" | "2:3" | "3:4" | "4:5" => (1024, 1536),
        _ => {
            if request_size.trim() == "4K" {
                (1536, 1536)
            } else {
                (1024, 1024)
            }
        }
    };
    format!("{}x{}", w, h)
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
            "parts": parts
        }],
        "generationConfig": {
            "responseMimeType": "image/png"
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

async fn generate_via_openai_images(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model_name: &str,
    request: GenerateRequest,
) -> Result<String, AIError> {
    let images = request.reference_images.unwrap_or_default();
    if !images.is_empty() {
        return Err(AIError::InvalidRequest(
            "该模型暂不支持参考图编辑，请移除参考图后重试".to_string(),
        ));
    }

    let endpoint = format!("{}/v1/images/generations", base_url);
    let resolved_size = resolve_openai_image_size(&request.size, &request.aspect_ratio);
    let body = json!({
        "model": model_name,
        "prompt": request.prompt,
        "size": resolved_size,
        "response_format": "b64_json"
    });

    info!("[666API OpenAI Images] URL: {}", endpoint);

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

    let result: OpenAiImagesResponse = response.json().await?;
    let item = result
        .data
        .unwrap_or_default()
        .into_iter()
        .next()
        .ok_or_else(|| AIError::Provider("No image payload in response".to_string()))?;

    if let Some(b64) = item.b64_json {
        if b64.trim().is_empty() {
            return Err(AIError::Provider("No image payload in response".to_string()));
        }
        return Ok(format!("data:image/png;base64,{}", b64));
    }

    if let Some(url) = item.url {
        if url.trim().is_empty() {
            return Err(AIError::Provider("No image payload in response".to_string()));
        }
        return Ok(url);
    }

    Err(AIError::Provider("No image payload in response".to_string()))
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
            "666api/gemini-3.1-pro-preview".to_string(),
            "666api/gpt-image-2".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        Api666Provider::set_api_key(self, api_key).await;
        Ok(())
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
            return generate_via_openai_images(
                &self.client,
                &self.base_url,
                &api_key,
                &model_name,
                request,
            )
            .await;
        }

        Err(AIError::ModelNotSupported(format!(
            "666api/{}",
            model_name
        )))
    }
}
