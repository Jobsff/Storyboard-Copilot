use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use reqwest::multipart::{Form, Part};
use reqwest::Response;
use image::GenericImageView;
use image::ImageFormat;
use serde::Deserialize;
use serde_json::{json, Value};
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
    base_url: Arc<RwLock<String>>,
    provider_id: String,
}

async fn post_json_with_retry(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    body: &Value,
) -> Result<Response, AIError> {
    let retry_codes: [u16; 4] = [502, 503, 504, 524];
    for attempt in 0..3 {
        let response = client
            .post(endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await;
        match response {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if retry_codes.contains(&code) && attempt < 2 {
                    sleep(Duration::from_millis(800 * (attempt as u64 + 1))).await;
                    continue;
                }
                return Ok(resp);
            }
            Err(err) => {
                if attempt < 2 {
                    sleep(Duration::from_millis(800 * (attempt as u64 + 1))).await;
                    continue;
                }
                return Err(AIError::Provider(format!("request failed: {}", err)));
            }
        }
    }
    Err(AIError::Provider("request failed".to_string()))
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

#[derive(Debug, Deserialize)]
struct OpenAiImageResponse {
    data: Option<Vec<OpenAiImageItem>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageItem {
    #[serde(rename = "b64_json")]
    b64_json: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionResponse {
    choices: Option<Vec<OpenAiChatCompletionChoice>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionChoice {
    message: Option<OpenAiChatCompletionMessage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionMessage {
    content: Option<String>,
    refusal: Option<String>,
}

impl Api666Provider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: Arc::new(RwLock::new("https://www.666api.ai".to_string())),
            provider_id: "666api".to_string(),
        }
    }

    pub fn new_with_config(provider_id: &str, base_url: &str) -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: Arc::new(RwLock::new(base_url.to_string())),
            provider_id: provider_id.to_string(),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
    }

    pub async fn set_base_url(&self, url: String) {
        let mut base = self.base_url.write().await;
        *base = url;
    }

    pub async fn craft_image_prompt(
        &self,
        user_input: &str,
        category: Option<&str>,
    ) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let base_url = self.base_url.read().await.clone();

        craft_image_prompt(
            &self.client,
            &base_url,
            &api_key,
            user_input,
            category,
            None,
            None,
        )
        .await
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

fn prepare_reverse_prompt_image_data_url(source: &str) -> Result<String, AIError> {
    let (_mime, payload) = resolve_inline_image_payload(source)
        .ok_or_else(|| AIError::InvalidRequest("invalid reverse prompt image".to_string()))?;
    let bytes = STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| AIError::InvalidRequest("invalid base64 image payload".to_string()))?;

    let image = image::load_from_memory(&bytes)
        .map_err(|err| AIError::InvalidRequest(format!("invalid image: {}", err)))?;
    let (w, h) = image.dimensions();
    let max_dim = 768_u32;
    let resized = if w > max_dim || h > max_dim {
        let scale = max_dim as f32 / (w.max(h) as f32);
        let target_w = ((w as f32) * scale).round().max(1.0) as u32;
        let target_h = ((h as f32) * scale).round().max(1.0) as u32;
        image.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };

    let mut out = Vec::new();
    resized.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Jpeg)?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(out)))
}

async fn reverse_prompt_via_chat_completions(
    client: &Client,
    base_url: &str,
    api_key: &str,
    image_source: &str,
    language: Option<&str>,
    format: Option<&str>,
    model_override: Option<&str>,
) -> Result<String, AIError> {
    let data_url = prepare_reverse_prompt_image_data_url(image_source)?;
    let endpoint = format!("{}/v1/chat/completions", base_url);
    let resolved_language = language.unwrap_or("zh").trim().to_ascii_lowercase();
    let resolved_format = format.unwrap_or("text").trim().to_ascii_lowercase();
    let resolved_model = if let Some(m) = model_override {
        m.to_string()
    } else if resolved_format == "json" {
        "doubao-seed-2-0-mini-260215".to_string()
    } else if resolved_language == "en" {
        "gemini-3.1-flash-image-preview".to_string()
    } else {
        "doubao-seed-2-0-mini-260215".to_string()
    };

    let system_text = if resolved_format == "json" {
        "You are a prompt engineer and a layout/visual design analyst. Analyze the image and output strictly valid JSON. Output JSON only: no explanations, no markdown, no code fences."
    } else if resolved_language == "en" {
        "You are a prompt engineer. Given an image, output a single image-generation prompt. Output ONLY the prompt, no explanation, no quotes, no markdown."
    } else {
        "你是提示词工程师。根据图片内容输出一段可直接用于图像生成的提示词。必须使用简体中文输出。只输出提示词本身，不要解释，不要加引号，不要使用 Markdown。"
    };

    let user_text = if resolved_format == "json" {
        r##"Analyze the image's structure and visual style, then produce a reusable structured prompt in JSON.

Output MUST be a single JSON object (include ALL and ONLY these top-level fields):
- title
- canvas
- composition
- color_palette
- visual_style
- key_elements
- typography
- information_hierarchy
- constraints
- use_case

Hard rules:
- Output JSON only. No extra text, no explanations, no markdown, no code fences.
- All string values MUST be Simplified Chinese (except proper nouns/brand names).
- canvas MUST include: width_px, height_px, aspect_ratio (e.g. 16:9), orientation (landscape/portrait/square).
- composition MUST include: layout_type, grid_or_columns, alignment, margins_and_padding, focal_points, depth_and_layers.
- color_palette MUST include:
  - dominant_colors: array of { name, hex, percentage, role }. Color percentages should sum close to 100%.
  - accent_colors: array of { name, hex, percentage, role }
  - background_color: MUST be a hex color value (e.g. "#2d5c20"), NOT a description string
  - text_colors: array
  - overall_balance: warm/cool/neutral + ratio description
- Each item in key_elements MUST include:
  - name, role, position (relative description), bbox { x, y, w, h } where values are 0-1 decimals,
  - size_weight: MUST include approximate area percentage (e.g. "约占总面积40%"),
  - style_notes
- typography MUST include:
  - font_families_guess: array
  - text_blocks: array of { content_type, hierarchy_level, font_size_px_range, weight, color, position, bbox }
  - readability_notes
- information_hierarchy MUST include:
  - levels: array starting at 1, describing content type, visual emphasis, position, and why it is prioritized
  - scan_path (e.g. Z-pattern, radial, etc.)
- constraints MUST include:
  - must_have, avoid, layout_rules, color_rules, typography_rules, accessibility (contrast, font sizes, etc.)
- use_case MUST include:
  - scenario: string
  - target_platform: array of strings (e.g. ["社交平台分享", "壁纸"])
  - audience: array of strings (e.g. ["宠物爱好者", "摄影爱好者"])
  - editable_parts: array of strings (e.g. ["可添加文字说明", "可裁剪为不同长宽比"])
  - recreation_goal: string
- Prefer approximate ranges for numeric values when needed."##
    } else if resolved_language == "en" {
        "Generate a prompt describing the image with style, composition, subject, lighting, and details. Output only the prompt."
    } else {
        "请根据图片生成提示词，包含主体、场景、风格、光照、构图、细节。必须使用简体中文，只输出提示词本身。"
    };

    let base_body = json!({
        "model": resolved_model,
        "messages": [
            {"role": "system", "content": system_text},
            {"role": "user", "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": data_url}}
            ]}
        ],
        "temperature": if resolved_format == "json" { 0.0 } else { 0.1 },
        "max_tokens": if resolved_format == "json" { 2600 } else { 512 }
    });

    info!("[666API] reverse prompt model: {} format: {} URL: {}", resolved_model, resolved_format, endpoint);
    let response = if resolved_format == "json" {
        let body_with_response_format = {
            let mut value = base_body.clone();
            if let Some(map) = value.as_object_mut() {
                map.insert("response_format".to_string(), json!({"type": "json_object"}));
            }
            value
        };

        let primary = client
            .post(&endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(&body_with_response_format)
            .send()
            .await?;

        if primary.status().is_success() {
            primary
        } else {
            let status = primary.status();
            let raw = primary.text().await.unwrap_or_default();
            let lowered = raw.trim().to_ascii_lowercase();
            let should_fallback = lowered.contains("response_format")
                || lowered.contains("unknown field")
                || lowered.contains("unrecognized")
                || lowered.contains("unexpected")
                || lowered.contains("not allowed");
            if !should_fallback {
                let trimmed = raw.trim();
                let capped = if trimmed.len() > 2000 {
                    format!("{}...(truncated)", &trimmed[..2000])
                } else {
                    trimmed.to_string()
                };
                return Err(AIError::Provider(format!(
                    "reverse_prompt failed (status {}): {}",
                    status, capped
                )));
            }

            client
                .post(&endpoint)
                .bearer_auth(api_key)
                .header("Content-Type", "application/json")
                .json(&base_body)
                .send()
                .await?
        }
    } else {
        client
            .post(&endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(&base_body)
            .send()
            .await?
    };

    if !response.status().is_success() {
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let trimmed = raw.trim();
        let capped = if trimmed.len() > 2000 {
            format!("{}...(truncated)", &trimmed[..2000])
        } else {
            trimmed.to_string()
        };
        return Err(AIError::Provider(format!(
            "reverse_prompt failed (status {}): {}",
            status, capped
        )));
    }

    let raw_text = response.text().await.unwrap_or_default();
    let parsed: OpenAiChatCompletionResponse = serde_json::from_str(&raw_text)
        .map_err(|_| AIError::Provider(format!("invalid chat completion response: {}", raw_text)))?;
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
            "reverse_prompt returned empty content. raw response preview: {}",
            raw_text.chars().take(800).collect::<String>()
        )));
    }
    if resolved_format == "json" {
        fn strip_code_fences(source: &str) -> String {
            let s = source.trim();
            if !s.starts_with("```") {
                return s.to_string();
            }
            let mut lines = s.lines().collect::<Vec<_>>();
            if !lines.is_empty() {
                lines.remove(0);
            }
            while !lines.is_empty() && lines[lines.len() - 1].trim_start().starts_with("```") {
                lines.pop();
            }
            lines.join("\n").trim().to_string()
        }

        fn extract_json_slice(source: &str) -> Option<String> {
            let s = source.trim();
            if let (Some(start), Some(end)) = (s.find('{'), s.rfind('}')) {
                if end > start {
                    return Some(s[start..=end].to_string());
                }
            }
            if let (Some(start), Some(end)) = (s.find('['), s.rfind(']')) {
                if end > start {
                    return Some(s[start..=end].to_string());
                }
            }
            None
        }

        fn remove_trailing_commas(source: &str) -> String {
            let mut result = String::with_capacity(source.len());
            let chars = source.chars().collect::<Vec<_>>();
            let mut i = 0usize;
            while i < chars.len() {
                let ch = chars[i];
                if ch == ',' {
                    let mut j = i + 1;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                        i += 1;
                        continue;
                    }
                }
                result.push(ch);
                i += 1;
            }
            result
        }

        fn parse_json_candidates(source: &str) -> Result<serde_json::Value, AIError> {
            let cleaned = strip_code_fences(source);
            let mut candidates = Vec::new();
            if !cleaned.trim().is_empty() {
                candidates.push(cleaned);
            }
            if let Some(slice) = extract_json_slice(source) {
                if !slice.trim().is_empty() {
                    candidates.push(slice);
                }
            }
            for candidate in candidates {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate.trim()) {
                    return Ok(value);
                }
                let repaired = remove_trailing_commas(candidate.trim());
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(repaired.trim()) {
                    return Ok(value);
                }
            }
            let mut preview = source.trim().replace('\n', " ");
            if preview.len() > 400 {
                preview = format!("{}...(truncated)", &preview[..400]);
            }
            Err(AIError::Provider(format!(
                "reverse_prompt returned invalid json. output preview: {}",
                preview
            )))
        }

        let parsed_value = match parse_json_candidates(trimmed) {
            Ok(value) => value,
            Err(_) => {
                let retry_system_text = "You are a prompt engineer and a layout/visual design analyst. Output strictly valid JSON. Output JSON only: no explanations, no markdown, no code fences. Any extra characters will cause failure.";
                let retry_user_text = format!(
                    "{}\n\nImportant: the previous output was NOT valid JSON. Re-output strictly valid JSON ONLY. Start with '{{' and end with '}}'.\n\nReturn JSON in this exact top-level shape:\n{{\n  \"title\": \"\",\n  \"canvas\": {{\"width_px\": 0, \"height_px\": 0, \"aspect_ratio\": \"\", \"orientation\": \"\"}},\n  \"composition\": {{}},\n  \"color_palette\": {{}},\n  \"visual_style\": {{}},\n  \"key_elements\": [],\n  \"typography\": {{}},\n  \"information_hierarchy\": {{}},\n  \"constraints\": {{}},\n  \"use_case\": {{}}\n}}",
                    user_text
                );
                let retry_body = json!({
                    "model": resolved_model,
                    "messages": [
                        {"role": "system", "content": retry_system_text},
                        {"role": "user", "content": [
                            {"type": "text", "text": retry_user_text},
                            {"type": "image_url", "image_url": {"url": data_url}}
                        ]}
                    ],
                    "temperature": 0.0,
                    "max_tokens": 2600,
                    "response_format": {"type": "json_object"}
                });
                let retry_response = client
                    .post(&endpoint)
                    .bearer_auth(api_key)
                    .header("Content-Type", "application/json")
                    .json(&retry_body)
                    .send()
                    .await?;
                if !retry_response.status().is_success() {
                    let status = retry_response.status();
                    let raw = retry_response.text().await.unwrap_or_default();
                    let trimmed = raw.trim();
                    let capped = if trimmed.len() > 2000 {
                        format!("{}...(truncated)", &trimmed[..2000])
                    } else {
                        trimmed.to_string()
                    };
                    return Err(AIError::Provider(format!(
                        "reverse_prompt failed (status {}): {}",
                        status, capped
                    )));
                }
                let retry_raw_text = retry_response.text().await.unwrap_or_default();
                let retry_parsed: OpenAiChatCompletionResponse = serde_json::from_str(&retry_raw_text)
                    .map_err(|_| AIError::Provider(format!("invalid chat completion response: {}", retry_raw_text)))?;
                let retry_content = retry_parsed
                    .choices
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|choice| choice.message)
                    .filter_map(|message| message.content.or(message.refusal))
                    .next()
                    .unwrap_or_default();
                match parse_json_candidates(retry_content.trim()) {
                    Ok(value) => value,
                    Err(_) => {
                        let retry_source = retry_content.trim();
                        let clipped_retry_source = if retry_source.len() > 12000 {
                            format!("{}...(truncated)", &retry_source[..12000])
                        } else {
                            retry_source.to_string()
                        };
                        let repair_body = json!({
                            "model": resolved_model,
                            "messages": [
                                {"role": "system", "content": "You are a JSON repair assistant. Convert near-JSON text into strictly valid JSON. Output JSON only, no markdown."},
                                {"role": "user", "content": format!("Repair the following content into strictly valid JSON. Keep original semantics and keys.\n\n{}", clipped_retry_source)}
                            ],
                            "temperature": 0.0,
                            "max_tokens": 2600,
                            "response_format": {"type": "json_object"}
                        });
                        let repair_response = client
                            .post(&endpoint)
                            .bearer_auth(api_key)
                            .header("Content-Type", "application/json")
                            .json(&repair_body)
                            .send()
                            .await?;
                        if !repair_response.status().is_success() {
                            let status = repair_response.status();
                            let raw = repair_response.text().await.unwrap_or_default();
                            let trimmed = raw.trim();
                            let capped = if trimmed.len() > 2000 {
                                format!("{}...(truncated)", &trimmed[..2000])
                            } else {
                                trimmed.to_string()
                            };
                            return Err(AIError::Provider(format!(
                                "reverse_prompt failed (status {}): {}",
                                status, capped
                            )));
                        }
                        let repair_raw_text = repair_response.text().await.unwrap_or_default();
                        let repair_parsed: OpenAiChatCompletionResponse = serde_json::from_str(&repair_raw_text)
                            .map_err(|_| AIError::Provider(format!("invalid chat completion response: {}", repair_raw_text)))?;
                        let repair_content = repair_parsed
                            .choices
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|choice| choice.message)
                            .filter_map(|message| message.content.or(message.refusal))
                            .next()
                            .unwrap_or_default();
                        parse_json_candidates(repair_content.trim())?
                    }
                }
            }
        };

        let pretty = serde_json::to_string_pretty(&parsed_value)
            .unwrap_or_else(|_| parsed_value.to_string());
        return Ok(pretty);
    }

    Ok(trimmed.replace('\n', " ").trim().to_string())
}

const CRAFT_IMAGE_PROMPT_SYSTEM: &str = r#"你是 GPT Image 2 的提示词工程师。根据用户的简单需求，生成一段专业的英文图像生成提示词。

核心原则：
1. 画布/比例/布局放在主体前面（如"3:4 vertical poster"、"16:9 cinematic shot"）
2. 场景密度胜过形容词：用5-12个具体名词描述场景，2-4个材质/光影约束
3. 材质、光影、色调分开控制（不要笼统说"高级"或"professional"）
4. 风格锚点要具体且有限（如"MAPPA-style digital 2D animation"而非"anime style"）
5. 需要精确呈现的文字用引号包裹（如 "山川茶事" / "冷泡系列"）
6. 相机和拍摄语境解锁照片级真实感（如"RAW, unprocessed, full iPhone camera quality"、"shot from the crowd at a distance"）
7. 海报/商业图要有层级（品牌名最大→标语→SKU→CTA），使用 "Exact readable text:" 标记
8. UI提示词应像产品规格（设备尺寸、配色方案、组件系统、真实数据、导航结构）
9. 产品/美食渲染使用JSON/config风格提示词，包含 GLOBAL_SETTINGS/ENVIRONMENT/CORE_ASSETS/MOTION_OR_DETAIL_SYSTEMS/OUTPUT 结构
10. 信息图使用固定区域Schema（标题区、主图区、标注区、图例区）

输出要求：
- 只输出最终的英文提示词，不要解释，不要加引号，不要使用 Markdown
- 提示词应详细、专业、可直接用于图像生成
- 如果用户用中文描述，提示词仍用英文（除非用户要求中文文字出现在画面中）
- 画面中需要精确呈现的文字内容，保留用户的原文并用引号包裹"#;

const CRAFT_HINT_PHOTOGRAPHY: &str = " 此类别需要相机/拍摄语境。指定拍摄设备（如iPhone、DSLR）、镜头（如28mm、85mm）、光线条件（如自然晨光、霓虹灯反光）。包含5-12个具体场景物体和2-4个材质描述。避免堆砌空泛形容词。";
const CRAFT_HINT_POSTER: &str = " 使用海报层级结构：品牌/活动名最大→副标题→标语→SKU/价格→CTA。所有需要精确显示的文字用引号包裹并用 \"Exact readable text:\" 标记。指定布局比例（如3:4竖版、16:9横版）。避免模糊文字、乱码、虚假品牌logo。";
const CRAFT_HINT_PRODUCT: &str = " 使用JSON/config风格提示词，包含 GLOBAL_SETTINGS（aspect_ratio, style, render_flags）、ENVIRONMENT（background, lighting, atmosphere）、CORE_ASSETS（primary_subject, materials, composition）、MOTION_OR_DETAIL_SYSTEMS、OUTPUT（mood, avoid）结构。指定材质（如brushed metal, condensation）、光影（如directional softbox）和调色板。";
const CRAFT_HINT_UI: &str = " 像产品规格书一样描述：设备尺寸（如1290x2796 smartphone）、配色方案、组件系统（header/cards/charts/nav）、真实数据（余额/百分比/标签）、导航结构。要求 crisp typography、clean spacing、precise icon alignment、production-quality mockup。";
const CRAFT_HINT_CHARACTER: &str = " 包含角色外观细节（发型/服装/配饰/武器）、姿态和表情描述、风格锚点（如Studio Pierrot style cel-shading）。指定构图（如center composition, white background）、渲染风格（厚涂/赛璐璐/扁平化）。";
const CRAFT_HINT_ANIME: &str = " 指定风格锚点（如MAPPA/Ghibli/Pierrot style）、技法（赛璐璐cel-shading/厚涂impasto）、调色板、线条风格。描述角色表情/动作、场景氛围。如果是多面板排版，指定网格结构（如3x2 grid）和跨面板一致性约束。";
const CRAFT_HINT_GAME_ASSET: &str = " 选择风格（Q版chibi/写实realistic/扁平flat）、类型（道具/场景/UI元素/技能图标）。游戏素材通常需要：中心构图、轮廓清晰、边缘干净、适合抠图。指定描边风格（粗描边thick outline/无描边）、材质表现。";
const CRAFT_HINT_INFOGRAPHIC: &str = " 使用固定区域Schema：定义布局区域（标题区title zone、主图区main illustration zone、标注区annotation zone、图例区legend zone）。包含精确标签文字、指向线、编号标注。风格约束：museum board / scientific poster / editorial card。";
const CRAFT_HINT_ILLUSTRATION: &str = " 指定插画风格（水彩watercolor/扁平flat/等距isometric/像素pixel/剪纸papercut）、构图方式、调色板、氛围描述。包含具体材质和纹理表现要求。";

fn resolve_craft_category_hint(category: &str) -> &'static str {
    match category {
        "photography" => CRAFT_HINT_PHOTOGRAPHY,
        "poster" => CRAFT_HINT_POSTER,
        "product" => CRAFT_HINT_PRODUCT,
        "ui" => CRAFT_HINT_UI,
        "character" => CRAFT_HINT_CHARACTER,
        "anime" => CRAFT_HINT_ANIME,
        "gameAsset" => CRAFT_HINT_GAME_ASSET,
        "infographic" => CRAFT_HINT_INFOGRAPHIC,
        "illustration" => CRAFT_HINT_ILLUSTRATION,
        _ => "",
    }
}

pub async fn craft_image_prompt(
    client: &Client,
    base_url: &str,
    api_key: &str,
    user_input: &str,
    category: Option<&str>,
    model_override: Option<&str>,
    language: Option<&str>,
) -> Result<String, AIError> {
    let endpoint = format!("{}/v1/chat/completions", base_url);
    let model = model_override.unwrap_or("doubao-seed-2-0-mini-260215");

    let mut system_content = match category {
        Some(cat) if !cat.is_empty() && cat != "general" => {
            format!("{}{}", CRAFT_IMAGE_PROMPT_SYSTEM, resolve_craft_category_hint(cat))
        }
        _ => CRAFT_IMAGE_PROMPT_SYSTEM.to_string(),
    };

    if language == Some("zh") {
        system_content.push_str("\n\n特别要求：提示词必须使用中文输出。不要使用英文，所有描述都用简体中文。画面中需要精确呈现的文字内容保留原文并用引号包裹。");
    }

    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_input}
        ],
        "temperature": 0.8,
        "max_tokens": 1024
    });

    info!("[666API] craft_image_prompt model: {} category: {}", model, category.unwrap_or("general"));

    let response = post_json_with_retry(client, &endpoint, api_key, &body).await?;

    if !response.status().is_success() {
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let trimmed = raw.trim();
        let capped = if trimmed.len() > 2000 {
            format!("{}...(truncated)", &trimmed[..2000])
        } else {
            trimmed.to_string()
        };
        return Err(AIError::Provider(format!(
            "craft_image_prompt failed (status {}): {}",
            status, capped
        )));
    }

    let raw_text = response.text().await.unwrap_or_default();
    let parsed: OpenAiChatCompletionResponse = serde_json::from_str(&raw_text)
        .map_err(|_| AIError::Provider(format!("invalid chat completion response: {}", raw_text)))?;
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
            "craft_image_prompt returned empty content. raw response preview: {}",
            raw_text.chars().take(800).collect::<String>()
        )));
    }

    Ok(trimmed.to_string())
}

fn decode_image_bytes(source: &str) -> Result<Vec<u8>, AIError> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(AIError::InvalidRequest("empty reference image".to_string()));
    }

    if let Some((meta, payload)) = trimmed.split_once(',') {
        if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
            let bytes = STANDARD
                .decode(payload.as_bytes())
                .map_err(|_| AIError::InvalidRequest("invalid base64 image payload".to_string()))?;
            return Ok(bytes);
        }
    }

    let path = if trimmed.starts_with("file://") {
        PathBuf::from(decode_file_url_path(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    Ok(std::fs::read(path)?)
}

fn prepare_openai_edit_image_png(source: &str) -> Result<Vec<u8>, AIError> {
    let bytes = decode_image_bytes(source)?;
    let image = image::load_from_memory(&bytes)
        .map_err(|err| AIError::InvalidRequest(format!("invalid image: {}", err)))?;

    let (w, h) = image.dimensions();
    let size = w.min(h);
    let x = (w.saturating_sub(size)) / 2;
    let y = (h.saturating_sub(size)) / 2;
    let cropped = image.crop_imm(x, y, size, size);

    let mut target = cropped;
    if size > 1024 {
        target = target.resize_exact(1024, 1024, image::imageops::FilterType::Lanczos3);
    }

    let mut out = Vec::new();
    target.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)?;
    if out.len() <= 4 * 1024 * 1024 {
        return Ok(out);
    }

    let resized = target.resize_exact(512, 512, image::imageops::FilterType::Lanczos3);
    let mut out2 = Vec::new();
    resized.write_to(&mut std::io::Cursor::new(&mut out2), image::ImageFormat::Png)?;
    if out2.len() <= 4 * 1024 * 1024 {
        return Ok(out2);
    }

    Err(AIError::InvalidRequest(
        "reference image too large after conversion".to_string(),
    ))
}

fn extract_model_name(model: &str) -> Option<String> {
    let (_provider, name) = model.split_once('/')?;
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

fn resolve_openai_edit_output_size(request_size: &str) -> &'static str {
    match request_size.trim() {
        "4K" | "2K" | "1K" => "1024x1024",
        "0.5K" => "512x512",
        _ => "1024x1024",
    }
}

fn format_api666_images_error(
    status: reqwest::StatusCode,
    error_text: &str,
    has_reference: bool,
) -> String {
    let trimmed = error_text.trim();
    let raw = if trimmed.len() > 1600 {
        format!("{}...(truncated)", &trimmed[..1600])
    } else {
        trimmed.to_string()
    };

    if trimmed.contains("get_channel_failed") {
        if has_reference {
            return format!(
                "gpt-image-2 图生图通道暂不可用（666api: get_channel_failed）。请稍后重试，或移除参考图改为文生图，或切换 Gemini 图片模型。原始响应: {}",
                raw
            );
        }

        return format!(
            "gpt-image-2 通道暂不可用（666api: get_channel_failed）。请稍后重试或切换模型。原始响应: {}",
            raw
        );
    }

    format!("API error {}: {}", status, raw)
}

async fn post_gpt_image_2_edit_request(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    prompt: &str,
    output_size: &str,
    png_bytes: &[u8],
    response_format: Option<&str>,
) -> Result<Response, AIError> {
    let image_part = Part::bytes(png_bytes.to_vec())
        .file_name("image.png")
        .mime_str("image/png")
        .map_err(|_| AIError::InvalidRequest("invalid image mime type".to_string()))?;
    let form = Form::new()
        .part("image", image_part)
        .text("prompt", prompt.to_string())
        .text("n", "1")
        .text("size", output_size.to_string())
        .text("model", "gpt-image-2");
    let form = if let Some(format) = response_format {
        form.text("response_format", format.to_string())
    } else {
        form
    };

    client.post(endpoint).bearer_auth(api_key).multipart(form).send().await.map_err(AIError::from)
}

fn should_retry_gpt_image_2_edit_with_b64(error_text: &str) -> bool {
    let lowered = error_text.to_ascii_lowercase();
    lowered.contains("upstream did not return image output")
        || lowered.contains("did not return image")
        || lowered.contains("no image")
        || lowered.contains("image output")
}

fn parse_gpt_image_2_response_payload(raw_text: &str) -> Result<String, AIError> {
    let json_value: serde_json::Value = match serde_json::from_str(raw_text) {
        Ok(value) => value,
        Err(_) => serde_json::Value::String(raw_text.to_string()),
    };

    // Check for error in response body (some gateways return 200 with error JSON)
    if let Some(error) = json_value.get("error") {
        let msg = error.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(AIError::Provider(format!("API error: {}", msg)));
    }

    if json_value.get("code").is_some() {
        if let Ok(result) = serde_json::from_value::<Api666TaskSubmitResponse>(json_value.clone()) {
            if result.code.unwrap_or(200) == 200 {
                if let Some(item) = result.data.unwrap_or_default().into_iter().next() {
                    if let Some(task_id) = item.task_id {
                        let trimmed = task_id.trim().to_string();
                        if !trimmed.is_empty() {
                            return Ok(trimmed);
                        }
                    }
                }
            }
        }
    }

    // Try standard OpenAI image response format: data[].url or data[].b64_json
    if let Some(data_arr) = json_value.get("data").and_then(|d| d.as_array()) {
        if let Some(item) = data_arr.first() {
            if let Some(url) = item.get("url").and_then(|u| u.as_str()) {
                if !url.trim().is_empty() {
                    return Ok(url.to_string());
                }
            }
            if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
                if !b64.trim().is_empty() {
                    return Ok(format!("data:image/png;base64,{}", b64));
                }
            }
        }
    }

    // Fallback: scan JSON for any image URL
    if let Some(url) = json_value
        .pointer("/data/0/url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(url.to_string());
    }
    if let Some(b64) = json_value
        .pointer("/data/0/b64_json")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(format!("data:image/png;base64,{}", b64));
    }

    Err(AIError::Provider(format!(
        "No image payload in response. raw={}",
        if raw_text.len() > 2000 {
            format!("{}...(truncated)", &raw_text[..2000])
        } else {
            raw_text.to_string()
        }
    )))
}

async fn submit_gpt_image_2_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    request: &GenerateRequest,
) -> Result<String, AIError> {
    let images = request.reference_images.as_deref().unwrap_or(&[]);
    let has_reference = !images.is_empty();

    if has_reference {
        let endpoint = format!("{}/v1/images/edits", base_url);
        let output_size = resolve_openai_edit_output_size(&request.size);
        let png_bytes = prepare_openai_edit_image_png(&images[0])?;

        info!("[666API GPT-IMAGE-2] edit URL: {}", endpoint);
        let response = post_gpt_image_2_edit_request(
            client,
            &endpoint,
            api_key,
            &request.prompt,
            output_size,
            &png_bytes,
            None,
        )
        .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            if should_retry_gpt_image_2_edit_with_b64(&error_text) {
                info!("[GPT-IMAGE-2] edit default response format failed, retrying with b64_json");
                let retry_response = post_gpt_image_2_edit_request(
                    client,
                    &endpoint,
                    api_key,
                    &request.prompt,
                    output_size,
                    &png_bytes,
                    Some("b64_json"),
                )
                .await?;
                if !retry_response.status().is_success() {
                    let retry_status = retry_response.status();
                    let retry_error_text = retry_response.text().await.unwrap_or_default();
                    return Err(AIError::Provider(format_api666_images_error(
                        retry_status,
                        &retry_error_text,
                        has_reference,
                    )));
                }
                let retry_raw_text = retry_response.text().await.unwrap_or_default();
                info!("[GPT-IMAGE-2] edit retry response (first 500 chars): {}", &retry_raw_text.chars().take(500).collect::<String>());
                return parse_gpt_image_2_response_payload(&retry_raw_text);
            }

            return Err(AIError::Provider(format_api666_images_error(
                status,
                &error_text,
                has_reference,
            )));
        }

        let raw_text = response.text().await.unwrap_or_default();
        info!("[GPT-IMAGE-2] edit response (first 500 chars): {}", &raw_text.chars().take(500).collect::<String>());
        match parse_gpt_image_2_response_payload(&raw_text) {
            Ok(result) => return Ok(result),
            Err(AIError::Provider(message)) if should_retry_gpt_image_2_edit_with_b64(&message) => {
                info!("[GPT-IMAGE-2] edit response body contained no image, retrying with b64_json");
                let retry_response = post_gpt_image_2_edit_request(
                    client,
                    &endpoint,
                    api_key,
                    &request.prompt,
                    output_size,
                    &png_bytes,
                    Some("b64_json"),
                )
                .await?;
                if !retry_response.status().is_success() {
                    let retry_status = retry_response.status();
                    let retry_error_text = retry_response.text().await.unwrap_or_default();
                    return Err(AIError::Provider(format_api666_images_error(
                        retry_status,
                        &retry_error_text,
                        has_reference,
                    )));
                }
                let retry_raw_text = retry_response.text().await.unwrap_or_default();
                info!("[GPT-IMAGE-2] edit retry response (first 500 chars): {}", &retry_raw_text.chars().take(500).collect::<String>());
                return parse_gpt_image_2_response_payload(&retry_raw_text);
            }
            Err(error) => return Err(error),
        }
    }

    let response = {
        let endpoint = format!("{}/v1/images/generations", base_url);
        let resolved_size = resolve_openai_image_size(&request.size, &request.aspect_ratio);
        let body = json!({
            "model": "gpt-image-2",
            "prompt": request.prompt,
            "n": 1,
            "size": resolved_size
        });

        info!("[666API GPT-IMAGE-2] generate URL: {}", endpoint);
        client
            .post(&endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?
    };

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format_api666_images_error(
            status,
            &error_text,
            has_reference,
        )));
    }

    let raw_text = response.text().await.unwrap_or_default();
    info!("[GPT-IMAGE-2] response (first 500 chars): {}", &raw_text.chars().take(500).collect::<String>());
    parse_gpt_image_2_response_payload(&raw_text)
}

/// Generate image via standard OpenAI-compatible /v1/images/generations endpoint.
/// Used by non-666api providers (e.g. juyouapi) for Gemini image models.
/// Generate image via /v1/chat/completions with Gemini model through OpenAI-compatible gateway.
/// Used by non-666api providers (e.g. juyouapi) for Gemini image models.
async fn submit_gemini_via_chat_completions(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model_name: &str,
    request: &GenerateRequest,
) -> Result<String, AIError> {
    let endpoint = format!("{}/v1/chat/completions", base_url);

    let mut prompt_text = request.prompt.clone();
    let ar = request.aspect_ratio.trim();
    if !ar.is_empty() && ar != "auto" {
        prompt_text = format!("Generate an image with aspect ratio {}. {}", ar, prompt_text);
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

    let body = json!({
        "model": model_name,
        "messages": [{
            "role": "user",
            "content": content_parts
        }],
        "max_tokens": 4096
    });

    info!("[Gemini-Chat] URL: {}, model: {}", endpoint, model_name);

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

    let raw_text = response.text().await.unwrap_or_default();
    let json_value: serde_json::Value = match serde_json::from_str(&raw_text) {
        Ok(value) => value,
        Err(_) => return Err(AIError::Provider(format!("Invalid JSON response: {}", raw_text.chars().take(500).collect::<String>()))),
    };

    // Extract base64 image from chat completion response
    // The image can be in different locations depending on the gateway:
    // 1. choices[0].message.images[].image_url.url (巨游API format)
    // 2. choices[0].message.content as array of parts with type "image_url"
    // 3. choices[0].message.content as inline markdown image or data URL
    if let Some(choices) = json_value.get("choices").and_then(|c| c.as_array()) {
        if let Some(first_choice) = choices.first() {
            let message = first_choice.get("message");

            // Format 1: message.images array (巨游API format)
            if let Some(images) = message.and_then(|m| m.get("images")).and_then(|i| i.as_array()) {
                for img in images {
                    if let Some(url) = img.pointer("/image_url/url").and_then(|u| u.as_str()) {
                        if !url.is_empty() {
                            return Ok(url.to_string());
                        }
                    }
                }
            }

            if let Some(content) = message.and_then(|m| m.get("content")) {
                // Format 2: content as array of parts
                if let Some(parts) = content.as_array() {
                    for part in parts {
                        if part.get("type").and_then(|t| t.as_str()) == Some("image_url") {
                            if let Some(url) = part.pointer("/image_url/url").and_then(|u| u.as_str()) {
                                if !url.is_empty() {
                                    return Ok(url.to_string());
                                }
                            }
                        }
                    }
                }
                // Format 3: content as string with data URL or markdown image
                if let Some(text) = content.as_str() {
                    if let Some(start) = text.find("data:image/") {
                        let rest = &text[start..];
                        if let Some(end) = rest.find(')').or_else(|| rest.find('"')) {
                            return Ok(rest[..end].to_string());
                        }
                        let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
                        return Ok(rest[..end].to_string());
                    }
                    if let Some(bang_idx) = text.find("![") {
                        if let Some(paren_start) = text[bang_idx..].find("](") {
                            let url_start = bang_idx + paren_start + 2;
                            if let Some(paren_end) = text[url_start..].find(')') {
                                let url = &text[url_start..url_start + paren_end];
                                if url.starts_with("http") {
                                    return Ok(url.to_string());
                                }
                            }
                        }
                    }
                    if text.starts_with("http") && !text.contains(' ') {
                        return Ok(text.to_string());
                    }
                }
            }
        }
    }

    Err(AIError::Provider(format!(
        "No image in chat completion response. raw={}",
        if raw_text.len() > 2000 { format!("{}...(truncated)", &raw_text[..2000]) } else { raw_text }
    )))
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
        return Err(AIError::Provider(format_api666_images_error(
            status,
            &error_text,
            false,
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
        let normalized = if message.contains("get_channel_failed") {
            "gpt-image-2 通道暂不可用（666api: get_channel_failed）。请稍后重试或切换模型。"
                .to_string()
        } else {
            message
        };
        return Ok(ProviderTaskPollResult::Failed(normalized));
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

    let image_size = match request.size.trim() {
        "4K" => "4K",
        "2K" => "2K",
        "1K" => "1K",
        "0.5K" => "1K",
        other if other.is_empty() => "1K",
        _ => "1K",
    };

    let body = json!({
        "contents": [{
            "role": "user",
            "parts": parts
        }],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": request.aspect_ratio,
                "imageSize": image_size
            }
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

fn is_video_model_name(model_name: &str) -> bool {
    let trimmed = model_name.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed == "wan2.6-i2v-flash"
}

fn extract_video_task_id(value: &Value) -> Option<String> {
    let candidates = [
        value.pointer("/data/task_id"),
        value.pointer("/data/0/task_id"),
        value.pointer("/task_id"),
        value.pointer("/id"),
        value.pointer("/data/id"),
        value.pointer("/data/0/id"),
    ];
    for candidate in candidates {
        if let Some(raw_value) = candidate {
            if let Some(raw) = raw_value.as_str() {
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
                continue;
            }
            if raw_value.is_number() || raw_value.is_boolean() {
                let rendered = raw_value.to_string();
                let trimmed = rendered.trim().trim_matches('"').trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn extract_video_task_id_from_raw_text(raw_text: &str) -> Option<String> {
    let trimmed = raw_text.trim();
    if trimmed.is_empty() {
        return None;
    }

    fn extract_quoted_value_after_key(text: &str, key: &str) -> Option<String> {
        let key_index = text.find(key)?;
        let after_key = &text[key_index + key.len()..];
        let colon_index = after_key.find(':')?;
        let after_colon = after_key[colon_index + 1..].trim_start();
        let quote_start = after_colon.find('"')?;
        let after_quote = &after_colon[quote_start + 1..];
        let quote_end = after_quote.find('"')?;
        let value = after_quote[..quote_end].trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    }

    extract_quoted_value_after_key(trimmed, "\"task_id\"")
        .or_else(|| extract_quoted_value_after_key(trimmed, "\"id\""))
        .or_else(|| {
            let start = trimmed.find("task_")?;
            let after = &trimmed[start..];
            let end = after
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' ))
                .unwrap_or(after.len());
            let candidate = after[..end].trim();
            if candidate.is_empty() {
                None
            } else {
                Some(candidate.to_string())
            }
        })
}

fn resolve_video_duration_seconds(extra_params: &Option<std::collections::HashMap<String, Value>>) -> i64 {
    extra_params
        .as_ref()
        .and_then(|map| map.get("durationSeconds"))
        .and_then(|value| value.as_i64())
        .unwrap_or(5)
        .clamp(1, 60)
}

fn resolve_video_quality(extra_params: &Option<std::collections::HashMap<String, Value>>, fallback: &str) -> String {
    let quality = extra_params
        .as_ref()
        .and_then(|map| map.get("quality"))
        .and_then(|value| value.as_str())
        .unwrap_or(fallback)
        .trim()
        .to_ascii_lowercase();
    match quality.as_str() {
        "480p" => "480p".to_string(),
        "720p" => "720p".to_string(),
        "1080p" => "1080p".to_string(),
        _ => fallback.trim().to_ascii_lowercase(),
    }
}

fn parse_aspect_ratio_value(aspect_ratio: &str) -> (f32, f32) {
    let trimmed = aspect_ratio.trim();
    let mut parts = trimmed.split(':');
    let w = parts.next().and_then(|v| v.parse::<f32>().ok()).unwrap_or(16.0);
    let h = parts.next().and_then(|v| v.parse::<f32>().ok()).unwrap_or(9.0);
    if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
        (w, h)
    } else {
        (16.0, 9.0)
    }
}

fn resolve_dimensions_from_quality(aspect_ratio: &str, quality: &str) -> (i64, i64) {
    let base = match quality.trim().to_ascii_lowercase().as_str() {
        "480p" => 480_i64,
        "1080p" => 1080_i64,
        _ => 720_i64,
    };
    let (w_ratio, h_ratio) = parse_aspect_ratio_value(aspect_ratio);
    if w_ratio >= h_ratio {
        let height = base;
        let width = ((base as f32) * (w_ratio / h_ratio)).round() as i64;
        (width.max(16), height.max(16))
    } else {
        let width = base;
        let height = ((base as f32) * (h_ratio / w_ratio)).round() as i64;
        (width.max(16), height.max(16))
    }
}

fn resolve_reference_image_payload(reference_images: &Option<Vec<String>>) -> Option<String> {
    let images = reference_images.as_ref()?;
    let first = images.first()?.trim().to_string();
    if first.is_empty() {
        return None;
    }
    Some(first)
}

async fn submit_wan_video_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model_name: &str,
    prompt: &str,
    resolution: &str,
    duration: i64,
    reference_image: Option<&str>,
) -> Result<ProviderTaskHandle, AIError> {
    let endpoint = format!("{}/api/v1/services/aigc/video-generation/video-synthesis", base_url);
    let mut input = json!({
        "prompt": prompt
    });
    if let Some(image) = reference_image {
        if let Some(obj) = input.as_object_mut() {
            obj.insert("img_url".to_string(), Value::String(image.to_string()));
        }
    }
    let body = json!({
        "model": model_name,
        "input": input,
        "parameters": {
            "resolution": resolution,
            "duration": duration,
            "prompt_extend": true
        }
    });

    info!("[666API VIDEO WAN] submit URL: {}", endpoint);
    let response = post_json_with_retry(client, &endpoint, api_key, &body).await?;

    if !response.status().is_success() {
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let trimmed = raw.trim();
        let capped = if trimmed.len() > 2000 {
            format!("{}...(truncated)", &trimmed[..2000])
        } else {
            trimmed.to_string()
        };
        return Err(AIError::Provider(format!(
            "video submit failed (status {}): {}",
            status, capped
        )));
    }

    let raw_text = response.text().await.unwrap_or_default();
    let trimmed = raw_text.trim_start_matches('\u{feff}').trim();
    let json_slice = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => &trimmed[start..=end],
        _ => trimmed,
    };
    let json_value: Value = match serde_json::from_str(json_slice) {
        Ok(value) => value,
        Err(_) => Value::String(raw_text.clone()),
    };
    let task_id = extract_video_task_id(&json_value)
        .or_else(|| extract_video_task_id_from_raw_text(json_slice))
        .or_else(|| extract_video_task_id_from_raw_text(&raw_text))
        .ok_or_else(|| AIError::Provider(format!("No task_id in response: {}", raw_text)))?;
    Ok(ProviderTaskHandle {
        task_id,
        metadata: Some(json!({ "taskKind": "video_wan" })),
    })
}

async fn poll_wan_video_task(
    client: &Client,
    base_url: &str,
    api_key: &str,
    task_id: &str,
) -> Result<ProviderTaskPollResult, AIError> {
    if task_id.trim().starts_with("task_") {
        let endpoint = format!("{}/v1/video/generations/{}", base_url, task_id);
        let response = client
            .get(&endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let raw = response.text().await.unwrap_or_default();
            let trimmed = raw.trim();
            let capped = if trimmed.len() > 2000 {
                format!("{}...(truncated)", &trimmed[..2000])
            } else {
                trimmed.to_string()
            };
            return Err(AIError::Provider(format!(
                "video poll failed (status {}): {}",
                status, capped
            )));
        }

        let raw_text = response.text().await.unwrap_or_default();
        let json_value: Value = serde_json::from_str(&raw_text).map_err(|_| {
            AIError::Provider(format!("invalid wan poll response: {}", raw_text))
        })?;
        let status_text = json_value
            .pointer("/data/status")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if matches!(
            status_text.as_str(),
            "pending" | "running" | "processing" | "queued" | "not_start" | "in_progress"
        ) {
            return Ok(ProviderTaskPollResult::Running);
        }
        if matches!(
            status_text.as_str(),
            "failed" | "error" | "canceled" | "cancelled"
        ) {
            let message = json_value
                .pointer("/data/fail_reason")
                .and_then(|value| value.as_str())
                .unwrap_or("task failed")
                .to_string();
            return Ok(ProviderTaskPollResult::Failed(message));
        }
        if matches!(
            status_text.as_str(),
            "succeeded" | "success" | "suceeded" | "completed" | "done" | "finished"
        ) {
            let url = json_value
                .pointer("/data/result_url")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    json_value
                        .pointer("/data/data/output/video_url")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("")
                .trim()
                .to_string();
            if url.is_empty() {
                return Ok(ProviderTaskPollResult::Failed(
                    "completed but missing video url".to_string(),
                ));
            }
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }
        return Ok(ProviderTaskPollResult::Running);
    }

    let endpoint = format!("{}/v1/tasks/{}", base_url, task_id);
    let response = client
        .get(&endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let trimmed = raw.trim();
        let capped = if trimmed.len() > 2000 {
            format!("{}...(truncated)", &trimmed[..2000])
        } else {
            trimmed.to_string()
        };
        return Err(AIError::Provider(format!(
            "video poll failed (status {}): {}",
            status, capped
        )));
    }

    let raw_text = response.text().await.unwrap_or_default();
    let json_value: Value = serde_json::from_str(&raw_text)
        .map_err(|_| AIError::Provider(format!("invalid wan poll response: {}", raw_text)))?;
    let status_text = json_value
        .pointer("/output/task_status")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if matches!(status_text.as_str(), "pending" | "running" | "processing" | "queued") {
        return Ok(ProviderTaskPollResult::Running);
    }
    if matches!(status_text.as_str(), "failed" | "error" | "canceled" | "cancelled") {
        let message = json_value
            .pointer("/message")
            .and_then(|value| value.as_str())
            .unwrap_or("task failed")
            .to_string();
        return Ok(ProviderTaskPollResult::Failed(message));
    }
    if matches!(status_text.as_str(), "succeeded" | "success" | "completed") {
        let url = json_value
            .pointer("/output/video_url")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if url.is_empty() {
            return Ok(ProviderTaskPollResult::Failed(
                "completed but missing video_url".to_string(),
            ));
        }
        return Ok(ProviderTaskPollResult::Succeeded(url));
    }
    Ok(ProviderTaskPollResult::Running)
}

#[async_trait::async_trait]
impl AIProvider for Api666Provider {
    fn as_any(&self) -> &dyn std::any::Any { self }

    fn name(&self) -> &str {
        self.provider_id.as_str()
    }

    fn supports_model(&self, model: &str) -> bool {
        model.starts_with(&format!("{}/", self.provider_id))
    }

    fn list_models(&self) -> Vec<String> {
        let prefix = format!("{}/", self.provider_id);
        if self.provider_id == "666api" {
            vec![
                format!("{}gemini-3.1-flash-image-preview", prefix),
                format!("{}gemini-3-pro-image-preview", prefix),
                format!("{}gpt-image-2", prefix),
                format!("{}wan2.6-i2v-flash", prefix),
            ]
        } else {
            vec![
                format!("{}gemini-3.1-flash-image", prefix),
                format!("{}gpt-image-2", prefix),
                format!("{}wan2.6-i2v-flash", prefix),
            ]
        }
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
        let base_url = self.base_url.read().await.clone();

        let model_name = extract_model_name(&request.model)
            .ok_or_else(|| AIError::ModelNotSupported(request.model.clone()))?;

        if is_video_model_name(&model_name) {
            let duration = resolve_video_duration_seconds(&request.extra_params);
            let quality = resolve_video_quality(&request.extra_params, &request.size);
            let reference_image = resolve_reference_image_payload(&request.reference_images);
            let image_payload = reference_image
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| AIError::InvalidRequest("reference image required for wan2.6-i2v-flash".to_string()))?;
            let resolution = match quality.as_str() {
                "480p" => "480P",
                "1080p" => "1080P",
                _ => "720P",
            };
            let handle = submit_wan_video_task(
                &self.client,
                &base_url,
                &api_key,
                &model_name,
                &request.prompt,
                resolution,
                duration,
                Some(image_payload),
            )
            .await?;
            return Ok(ProviderTaskSubmission::Queued(handle));
        }

        if model_name == "gpt-image-2" {
            let result =
                submit_gpt_image_2_task(&self.client, &base_url, &api_key, &request).await?;
            if result.starts_with("http") || result.starts_with("data:") {
                return Ok(ProviderTaskSubmission::Succeeded(result));
            }
            return Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
                task_id: result,
                metadata: None,
            }));
        }

        if model_name.starts_with("gemini-") {
            if self.provider_id == "666api" {
                let image_source = generate_via_gemini_native(
                    &self.client,
                    &base_url,
                    &api_key,
                    &model_name,
                    request,
                )
                .await?;
                return Ok(ProviderTaskSubmission::Succeeded(image_source));
            }
            // Non-666api providers (e.g. juyouapi): use standard OpenAI image endpoint
            let result = submit_gemini_via_chat_completions(
                &self.client,
                &base_url,
                &api_key,
                &model_name,
                &request,
            )
            .await?;
            if result.starts_with("http") || result.starts_with("data:") {
                return Ok(ProviderTaskSubmission::Succeeded(result));
            }
            return Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
                task_id: result,
                metadata: None,
            }));
        }

        Err(AIError::ModelNotSupported(format!("{}/{}", self.provider_id, model_name)))
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
            .and_then(|meta| meta.get("taskKind"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if kind == "video_wan" {
            return poll_wan_video_task(&self.client, &base_url, &api_key, &handle.task_id).await;
        }
        poll_gpt_task(&self.client, &base_url, &api_key, &handle.task_id).await
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

        reverse_prompt_via_chat_completions(
            &self.client,
            &base_url,
            &api_key,
            &image,
            language.as_deref(),
            format.as_deref(),
            model.as_deref(),
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

        craft_image_prompt(&self.client, &base_url, &api_key, user_input, category, model, language).await
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

        let model_name = extract_model_name(&request.model)
            .ok_or_else(|| AIError::ModelNotSupported(request.model.clone()))?;

        if is_video_model_name(&model_name) {
            let duration = resolve_video_duration_seconds(&request.extra_params);
            let quality = resolve_video_quality(&request.extra_params, &request.size);
            let reference_image = resolve_reference_image_payload(&request.reference_images);
            let image_payload = reference_image
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| AIError::InvalidRequest("reference image required for wan2.6-i2v-flash".to_string()))?;
            let resolution = match quality.as_str() {
                "480p" => "480P",
                "1080p" => "1080P",
                _ => "720P",
            };
            let handle = submit_wan_video_task(
                &self.client,
                &base_url,
                &api_key,
                &model_name,
                &request.prompt,
                resolution,
                duration,
                Some(image_payload),
            )
            .await?;
            for _ in 0..300 {
                match poll_wan_video_task(&self.client, &base_url, &api_key, &handle.task_id).await? {
                    ProviderTaskPollResult::Running => sleep(Duration::from_secs(3)).await,
                    ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                    ProviderTaskPollResult::Failed(message) => return Err(AIError::TaskFailed(message)),
                }
            }
            return Err(AIError::Provider("Task pending too long".to_string()));
        }

        if model_name.starts_with("gemini-") {
            if self.provider_id == "666api" {
                return generate_via_gemini_native(
                    &self.client,
                    &base_url,
                    &api_key,
                    &model_name,
                    request,
                )
                .await;
            }
            // Non-666api providers (e.g. juyouapi): use standard OpenAI image endpoint
            let result = submit_gemini_via_chat_completions(
                &self.client,
                &base_url,
                &api_key,
                &model_name,
                &request,
            )
            .await?;
            if result.starts_with("http") || result.starts_with("data:") {
                return Ok(result);
            }
            for _ in 0..60 {
                match poll_gpt_task(&self.client, &base_url, &api_key, &result).await? {
                    ProviderTaskPollResult::Running => {
                        sleep(Duration::from_secs(3)).await;
                    }
                    ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                    ProviderTaskPollResult::Failed(message) => return Err(AIError::TaskFailed(message)),
                }
            }
            return Err(AIError::Provider("Task pending too long".to_string()));
        }

        if model_name == "gpt-image-2" {
            let result =
                submit_gpt_image_2_task(&self.client, &base_url, &api_key, &request).await?;
            if result.starts_with("http") || result.starts_with("data:") {
                return Ok(result);
            }
            for _ in 0..60 {
                match poll_gpt_task(&self.client, &base_url, &api_key, &result).await? {
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
            "{}/{}",
            self.provider_id, model_name
        )))
    }
}
