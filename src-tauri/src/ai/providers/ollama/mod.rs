use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::AIProvider;

pub struct OllamaProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    base_url: Arc<RwLock<String>>,
    model_name: Arc<RwLock<String>>,
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
    content: Option<Value>,
}

impl OllamaProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: Arc::new(RwLock::new("http://localhost:11434".to_string())),
            model_name: Arc::new(RwLock::new(String::new())),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        let mut key = self.api_key.write().await;
        *key = if api_key.is_empty() {
            None
        } else {
            Some(api_key)
        };
    }

    pub async fn set_base_url(&self, url: String) {
        let mut base = self.base_url.write().await;
        let cleaned = url.trim_end_matches('/').trim_end_matches("/v1").to_string();
        *base = cleaned;
    }

    pub async fn set_model_name(&self, model: String) {
        let mut name = self.model_name.write().await;
        *name = model.trim().to_string();
    }

    async fn get_resolved_model(&self) -> Result<String, AIError> {
        let model = self.model_name.read().await.clone();
        if model.is_empty() {
            return Err(AIError::InvalidRequest(
                "Ollama model name not configured. Please set it in Settings.".to_string(),
            ));
        }
        Ok(model)
    }
}

impl Default for OllamaProvider {
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

    // Handle file paths (local paths or file:// URLs)
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

fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &s[..boundary]
}

async fn chat_completions(
    client: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: Vec<Value>,
    max_tokens: u32,
) -> Result<(ChatCompletionResponse, String), AIError> {
    let endpoint = format!("{}/v1/chat/completions", base_url);
    let mut body = json!({
        "model": model,
        "messages": messages,
    });
    if max_tokens > 0 {
        body["max_tokens"] = json!(max_tokens);
    }

    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .json(&body);

    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let response = req.send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format!(
            "Ollama API error {}: {}",
            status, error_text
        )));
    }

    let raw_text = response.text().await.unwrap_or_default();
    info!("[Ollama] response ({} bytes): {}", raw_text.len(), truncate_str(&raw_text, 500));
    let parsed: ChatCompletionResponse = serde_json::from_str(&raw_text).map_err(|err| {
        AIError::Provider(format!(
            "Invalid Ollama response: {}; raw={}",
            err,
            truncate_str(&raw_text, 500)
        ))
    })?;

    Ok((parsed, raw_text))
}

fn extract_image_from_content(content: &Value) -> Option<String> {
    // Format 1: content is array of parts
    if let Some(parts) = content.as_array() {
        for part in parts {
            if part.get("type").and_then(|t| t.as_str()) == Some("image_url") {
                if let Some(url) = part.pointer("/image_url/url").and_then(|u| u.as_str()) {
                    if !url.is_empty() {
                        return Some(url.to_string());
                    }
                }
            }
        }
    }

    // Format 2: content is string with data URL or markdown image
    if let Some(text) = content.as_str() {
        if let Some(start) = text.find("data:image/") {
            let rest = &text[start..];
            let end = rest
                .find(')')
                .or_else(|| rest.find('"'))
                .or_else(|| rest.find(|c: char| c.is_whitespace()))
                .unwrap_or(rest.len());
            let data_url = &rest[..end];
            if !data_url.is_empty() {
                return Some(data_url.to_string());
            }
        }
        if let Some(bang_idx) = text.find("![") {
            if let Some(paren_start) = text[bang_idx..].find("](") {
                let url_start = bang_idx + paren_start + 2;
                if let Some(paren_end) = text[url_start..].find(')') {
                    let url = &text[url_start..url_start + paren_end];
                    if url.starts_with("http") {
                        return Some(url.to_string());
                    }
                }
            }
        }
        if text.starts_with("http") && !text.contains(' ') {
            return Some(text.to_string());
        }
    }

    None
}

fn extract_text_from_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    // If content is array, concatenate text parts
    if let Some(parts) = content.as_array() {
        let mut result = String::new();
        for part in parts {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    result.push_str(text);
                }
            }
        }
        if !result.trim().is_empty() {
            return Some(result.trim().to_string());
        }
    }
    None
}

#[async_trait::async_trait]
impl AIProvider for OllamaProvider {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn name(&self) -> &str {
        "ollama"
    }

    fn supports_model(&self, model: &str) -> bool {
        model.starts_with("ollama/")
    }

    fn list_models(&self) -> Vec<String> {
        vec!["ollama/custom".to_string()]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        OllamaProvider::set_api_key(self, api_key).await;
        Ok(())
    }

    async fn generate(&self, request: crate::ai::GenerateRequest) -> Result<String, AIError> {
        let api_key = self.api_key.read().await.clone();
        let base_url = self.base_url.read().await.clone();
        let model = self.get_resolved_model().await?;

        let mut prompt_text = request.prompt.clone();
        let ar = request.aspect_ratio.trim();
        if !ar.is_empty() && ar != "auto" {
            prompt_text = format!(
                "Generate an image with aspect ratio {}. {}",
                ar, prompt_text
            );
        }

        let mut content_parts = vec![json!({ "type": "text", "text": prompt_text })];
        let images = request.reference_images.as_deref().unwrap_or(&[]);
        for image in images.iter() {
            if let Some((mime, data)) = resolve_inline_image_payload(image) {
                content_parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", mime, data) }
                }));
            }
        }

        let messages = vec![json!({
            "role": "user",
            "content": content_parts
        })];

        let (response, _raw) = chat_completions(
            &self.client,
            &base_url,
            api_key.as_deref(),
            &model,
            messages,
            4096,
        )
        .await?;

        // Try to extract image from response
        if let Some(choices) = &response.choices {
            if let Some(first) = choices.first() {
                if let Some(message) = &first.message {
                    if let Some(content) = &message.content {
                        if let Some(image_source) = extract_image_from_content(content) {
                            return Ok(image_source);
                        }
                    }
                }
            }
        }

        // If no image found, return the text content as error
        if let Some(choices) = response.choices {
            if let Some(first) = choices.first() {
                if let Some(message) = &first.message {
                    if let Some(content) = &message.content {
                        if let Some(text) = extract_text_from_content(content) {
                            return Err(AIError::Provider(format!(
                                "Ollama model '{}' returned text instead of an image: {}",
                                model,
                                truncate_str(&text, 200)
                            )));
                        }
                    }
                }
            }
        }

        Err(AIError::Provider(
            "No image or text in Ollama response".to_string(),
        ))
    }

    async fn reverse_prompt(
        &self,
        image: String,
        language: Option<String>,
        format: Option<String>,
        model_override: Option<String>,
    ) -> Result<String, AIError> {
        let api_key = self.api_key.read().await.clone();
        let base_url = self.base_url.read().await.clone();
        let model = if let Some(m) = model_override {
            if !m.trim().is_empty() { m } else { self.get_resolved_model().await? }
        } else {
            self.get_resolved_model().await?
        };

        let resolved_language = language.unwrap_or_else(|| "zh".to_string()).trim().to_ascii_lowercase();
        let resolved_format = format.unwrap_or_else(|| "text".to_string()).trim().to_ascii_lowercase();

        let system_text = if resolved_format == "json" {
            "You are a prompt engineer and a layout/visual design analyst. Analyze the image and output strictly valid JSON. Output JSON only: no explanations, no markdown, no code fences."
        } else if resolved_language == "en" {
            "You are a prompt engineer. Given an image, output a single image-generation prompt. Output ONLY the prompt, no explanation, no quotes, no markdown."
        } else {
            "你是提示词工程师。根据图片内容输出一段可直接用于图像生成的提示词。必须使用简体中文输出。只输出提示词本身，不要解释，不要加引号，不要使用 Markdown。"
        };

        let user_text = if resolved_format == "json" {
            "Analyze the image's structure and visual style, then produce a JSON prompt with: title, canvas, composition, color_palette, visual_style, key_elements, typography, information_hierarchy, constraints, use_case. Output JSON only."
        } else if resolved_language == "en" {
            "Generate a prompt describing the image with style, composition, subject, lighting, and details. Output only the prompt."
        } else {
            "请根据图片生成提示词，包含主体、场景、风格、光照、构图、细节。必须使用简体中文，只输出提示词本身。"
        };

        let image_data = if let Some((mime, data)) = resolve_inline_image_payload(&image) {
            format!("data:{};base64,{}", mime, data)
        } else {
            return Err(AIError::InvalidRequest(
                "Could not resolve image data. Provide a data URL or a valid file path.".to_string(),
            ));
        };

        let messages = vec![
            json!({"role": "system", "content": system_text}),
            json!({
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_data}}
                ]
            }),
        ];

        let (response, raw_text) = chat_completions(
            &self.client,
            &base_url,
            api_key.as_deref(),
            &model,
            messages,
            if resolved_format == "json" { 2600 } else { 2048 },
        )
        .await?;

        if let Some(choices) = response.choices {
            if let Some(first) = choices.first() {
                if let Some(message) = &first.message {
                    if let Some(content) = &message.content {
                        if let Some(text) = extract_text_from_content(content) {
                            return Ok(text);
                        }
                    }
                }
            }
        }

        let preview = truncate_str(&raw_text, 500);
        Err(AIError::Provider(format!(
            "No text content in Ollama reverse prompt response. Raw: {}",
            preview
        )))
    }

    async fn craft_image_prompt(
        &self,
        user_input: &str,
        category: Option<&str>,
        model: Option<&str>,
        language: Option<&str>,
    ) -> Result<String, AIError> {
        let api_key = self.api_key.read().await.clone();
        let base_url = self.base_url.read().await.clone();
        let resolved_model = if let Some(m) = model {
            if !m.trim().is_empty() { Some(m) } else { None }
        } else {
            None
        };

        crate::ai::providers::api666::craft_image_prompt(
            &self.client,
            &base_url,
            api_key.as_deref().unwrap_or(""),
            user_input,
            category,
            resolved_model,
            language,
        )
        .await
    }
}
