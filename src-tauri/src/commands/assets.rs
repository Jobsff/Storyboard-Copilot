use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::Manager;

fn resolve_spine_assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let assets_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("assets")
        .join("spine");

    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets directory: {e}"))?;

    Ok(assets_dir)
}

fn compute_package_id(files: &[(String, Vec<u8>)]) -> String {
    let mut hasher = md5::Context::new();
    for (name, bytes) in files {
        hasher.consume(name.as_bytes());
        hasher.consume(&[0u8]);
        hasher.consume(bytes);
        hasher.consume(&[0u8]);
    }
    format!("{:x}", hasher.compute())
}

#[derive(Debug, Serialize)]
pub struct PersistSpinePackageResult {
    pub package_id: String,
    pub files: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpineFrameAnimationPayload {
    pub name: Option<String>,
    pub frame_sources: Vec<String>,
    pub frame_notes: Option<Vec<String>>,
    pub fps: Option<f64>,
    pub loop_animation: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSequenceFramesAsSpinePayload {
    pub package_name: Option<String>,
    pub animations: Vec<SpineFrameAnimationPayload>,
    pub trim_transparent: Option<bool>,
    pub alpha_threshold: Option<u8>,
    pub max_texture_size: Option<u32>,
    pub target_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSequenceFramesAsSpritePackPayload {
    pub package_name: Option<String>,
    pub animation: SpineFrameAnimationPayload,
    pub trim_transparent: Option<bool>,
    pub alpha_threshold: Option<u8>,
    pub max_texture_size: Option<u32>,
    pub target_dir: Option<String>,
}

#[tauri::command]
pub fn persist_spine_package_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<PersistSpinePackageResult, String> {
    if paths.is_empty() {
        return Err("No files selected".to_string());
    }

    let mut loaded_files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    for path in &paths {
        let path_buf = PathBuf::from(path);
        let file_name = path_buf
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Invalid file name: {path}"))?
            .to_string();

        if !seen_names.insert(file_name.clone()) {
            return Err(format!("Duplicate file name selected: {file_name}"));
        }

        let bytes = std::fs::read(&path_buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
        loaded_files.push((file_name, bytes));
    }

    loaded_files.sort_by(|(a, _), (b, _)| a.cmp(b));
    let package_id = compute_package_id(&loaded_files);

    let base_dir = resolve_spine_assets_dir(&app)?.join(&package_id);
    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to create package directory: {e}"))?;

    let mut stored_files = HashMap::new();
    for (file_name, bytes) in loaded_files {
        let destination = base_dir.join(&file_name);
        if !destination.exists() {
            std::fs::write(&destination, bytes)
                .map_err(|e| format!("Failed to write {}: {e}", destination.display()))?;
        }
        stored_files.insert(
            file_name,
            destination
                .to_str()
                .ok_or_else(|| "Failed to encode destination path".to_string())?
                .to_string(),
        );
    }

    Ok(PersistSpinePackageResult {
        package_id,
        files: stored_files,
    })
}

#[derive(Debug, Clone)]
struct PreparedFrame {
    animation_name: String,
    attachment_name: String,
    image: RgbaImage,
}

#[derive(Debug, Clone)]
struct AnimationTimeline {
    name: String,
    attachment_names: Vec<String>,
    fps: f64,
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min_x: u32,
    min_y: u32,
    max_x: u32,
    max_y: u32,
}

impl Bounds {
    fn width(self) -> u32 {
        self.max_x.saturating_sub(self.min_x).saturating_add(1)
    }

    fn height(self) -> u32 {
        self.max_y.saturating_sub(self.min_y).saturating_add(1)
    }
}

fn sanitize_spine_name(raw: &str, fallback: &str) -> String {
    let mut output = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            output.push(ch);
        } else if ch.is_whitespace() {
            output.push('_');
        }
    }
    let compact = output.trim_matches('_').to_string();
    if compact.is_empty() {
        fallback.to_string()
    } else {
        compact
    }
}

fn parse_data_url(source: &str) -> Result<Vec<u8>, String> {
    let (meta, payload) = source
        .split_once(',')
        .ok_or_else(|| "Invalid data URL format".to_string())?;
    if !meta.starts_with("data:") || !meta.ends_with(";base64") {
        return Err("Only base64 data URL is supported".to_string());
    }
    STANDARD
        .decode(payload)
        .map_err(|e| format!("Failed to decode data URL: {e}"))
}

fn decode_file_url_path(value: &str) -> String {
    let raw = value.trim_start_matches("file://");
    let decoded = urlencoding::decode(raw)
        .map(|result| result.into_owned())
        .unwrap_or_else(|_| raw.to_string());

    if cfg!(target_os = "windows")
        && decoded.starts_with('/')
        && decoded.len() > 2
        && decoded.as_bytes().get(2) == Some(&b':')
    {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

async fn resolve_image_source_bytes(source: &str) -> Result<Vec<u8>, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }
    if trimmed.starts_with("data:") {
        return parse_data_url(trimmed);
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let response = reqwest::get(trimmed)
            .await
            .map_err(|e| format!("Failed to download remote image: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Failed to download remote image: {}",
                response.status()
            ));
        }
        return response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|e| format!("Failed to read remote image bytes: {e}"));
    }
    let path = if trimmed.starts_with("file://") {
        PathBuf::from(decode_file_url_path(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    std::fs::read(&path).map_err(|e| format!("Failed to read image source {}: {e}", path.display()))
}

async fn load_frame_image(source: &str) -> Result<RgbaImage, String> {
    let bytes = resolve_image_source_bytes(source).await?;
    image::load_from_memory(&bytes)
        .map(|image| image.to_rgba8())
        .map_err(|e| format!("Failed to decode frame image: {e}"))
}

fn find_alpha_bounds(image: &RgbaImage, threshold: u8) -> Option<Bounds> {
    let mut bounds: Option<Bounds> = None;
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel.0[3] <= threshold {
            continue;
        }
        bounds = Some(match bounds {
            Some(current) => Bounds {
                min_x: current.min_x.min(x),
                min_y: current.min_y.min(y),
                max_x: current.max_x.max(x),
                max_y: current.max_y.max(y),
            },
            None => Bounds {
                min_x: x,
                min_y: y,
                max_x: x,
                max_y: y,
            },
        });
    }
    bounds
}

fn union_bounds(images: &[RgbaImage], threshold: u8) -> Option<Bounds> {
    let mut result: Option<Bounds> = None;
    for image in images {
        let Some(bounds) = find_alpha_bounds(image, threshold) else {
            continue;
        };
        result = Some(match result {
            Some(current) => Bounds {
                min_x: current.min_x.min(bounds.min_x),
                min_y: current.min_y.min(bounds.min_y),
                max_x: current.max_x.max(bounds.max_x),
                max_y: current.max_y.max(bounds.max_y),
            },
            None => bounds,
        });
    }
    result
}

fn normalize_frames(
    images: Vec<RgbaImage>,
    trim_transparent: bool,
    threshold: u8,
) -> Vec<RgbaImage> {
    if images.is_empty() {
        return images;
    }

    let base_width = images[0].width().max(1);
    let base_height = images[0].height().max(1);
    let bounds = if trim_transparent {
        union_bounds(&images, threshold).unwrap_or(Bounds {
            min_x: 0,
            min_y: 0,
            max_x: base_width.saturating_sub(1),
            max_y: base_height.saturating_sub(1),
        })
    } else {
        Bounds {
            min_x: 0,
            min_y: 0,
            max_x: base_width.saturating_sub(1),
            max_y: base_height.saturating_sub(1),
        }
    };

    let target_width = bounds.width().max(1);
    let target_height = bounds.height().max(1);

    images
        .into_iter()
        .map(|image| {
            let safe_x = bounds.min_x.min(image.width().saturating_sub(1));
            let safe_y = bounds.min_y.min(image.height().saturating_sub(1));
            let safe_w = target_width
                .min(image.width().saturating_sub(safe_x))
                .max(1);
            let safe_h = target_height
                .min(image.height().saturating_sub(safe_y))
                .max(1);
            image::imageops::crop_imm(&image, safe_x, safe_y, safe_w, safe_h).to_image()
        })
        .collect()
}

fn resolve_atlas_grid(
    frame_count: usize,
    frame_width: u32,
    frame_height: u32,
    max_texture_size: u32,
) -> (u32, u32) {
    let safe_count = frame_count.max(1) as u32;
    let max_cols_by_size = (max_texture_size / frame_width.max(1)).max(1);
    let ideal_cols = (safe_count as f64).sqrt().ceil() as u32;
    let cols = ideal_cols.min(max_cols_by_size).max(1);
    let rows = ((safe_count + cols - 1) / cols).max(1);
    let _ = frame_height;
    (cols, rows)
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode Spine texture PNG: {e}"))?;
    Ok(buffer.into_inner())
}

fn build_atlas_text(
    texture_name: &str,
    texture_width: u32,
    texture_height: u32,
    frames: &[PreparedFrame],
    cols: u32,
) -> String {
    let mut text = String::new();
    text.push_str(texture_name);
    text.push('\n');
    text.push_str(&format!("size: {texture_width},{texture_height}\n"));
    text.push_str("format: RGBA8888\n");
    text.push_str("filter: Linear,Linear\n");
    text.push_str("repeat: none\n");

    for (index, frame) in frames.iter().enumerate() {
        let col = (index as u32) % cols;
        let row = (index as u32) / cols;
        let x = col.saturating_mul(frame.image.width());
        let y = row.saturating_mul(frame.image.height());
        let width = frame.image.width();
        let height = frame.image.height();
        text.push_str(&format!("{}\n", frame.attachment_name));
        text.push_str("  rotate: false\n");
        text.push_str(&format!("  xy: {x}, {y}\n"));
        text.push_str(&format!("  size: {width}, {height}\n"));
        text.push_str(&format!("  orig: {width}, {height}\n"));
        text.push_str("  offset: 0, 0\n");
        text.push_str("  index: -1\n");
    }

    text
}

fn build_spine_json(
    package_name: &str,
    frames: &[PreparedFrame],
    timelines: &[AnimationTimeline],
) -> Result<Vec<u8>, String> {
    let first_frame = frames
        .first()
        .ok_or_else(|| "No frames available for Spine JSON".to_string())?;
    let frame_width = first_frame.image.width();
    let frame_height = first_frame.image.height();

    let mut attachments = serde_json::Map::new();
    for frame in frames {
        attachments.insert(
            frame.attachment_name.clone(),
            serde_json::json!({
                "type": "region",
                "name": frame.attachment_name,
                "path": frame.attachment_name,
                "x": 0,
                "y": 0,
                "width": frame_width,
                "height": frame_height
            }),
        );
    }

    let mut animations = serde_json::Map::new();
    for timeline in timelines {
        let frame_duration = 1.0 / timeline.fps.max(1.0);
        let events = timeline
            .attachment_names
            .iter()
            .enumerate()
            .map(|(index, attachment_name)| {
                serde_json::json!({
                    "time": ((index as f64) * frame_duration * 1000.0).round() / 1000.0,
                    "name": attachment_name
                })
            })
            .collect::<Vec<_>>();

        animations.insert(
            timeline.name.clone(),
            serde_json::json!({
                "slots": {
                    "sprite": {
                        "attachment": events
                    }
                }
            }),
        );
    }

    let json = serde_json::json!({
        "skeleton": {
            "hash": package_name,
            "spine": "3.8.99",
            "x": -((frame_width as f64) / 2.0),
            "y": -((frame_height as f64) / 2.0),
            "width": frame_width,
            "height": frame_height,
            "images": ""
        },
        "bones": [
            { "name": "root" },
            { "name": "sprite_root", "parent": "root" }
        ],
        "slots": [
            {
                "name": "sprite",
                "bone": "sprite_root",
                "attachment": first_frame.attachment_name
            }
        ],
        "skins": [
            {
                "name": "default",
                "attachments": {
                    "sprite": attachments
                }
            }
        ],
        "animations": animations
    });

    serde_json::to_vec_pretty(&json).map_err(|e| format!("Failed to encode Spine JSON: {e}"))
}

fn build_sprite_pack_metadata(
    package_name: &str,
    texture_name: &str,
    frames: &[PreparedFrame],
    timeline: &AnimationTimeline,
    frame_notes: &[String],
    cols: u32,
    rows: u32,
    texture_width: u32,
    texture_height: u32,
) -> Result<Vec<u8>, String> {
    let first_frame = frames
        .first()
        .ok_or_else(|| "No frames available for sprite metadata".to_string())?;
    let frame_width = first_frame.image.width();
    let frame_height = first_frame.image.height();
    let frame_duration = 1.0 / timeline.fps.max(1.0);
    let frame_items = timeline
        .attachment_names
        .iter()
        .enumerate()
        .map(|(index, frame_name)| {
            let col = (index as u32) % cols;
            let row = (index as u32) / cols;
            serde_json::json!({
                "index": index,
                "name": frame_name,
                "file": format!("frames/{frame_name}.png"),
                "x": col.saturating_mul(frame_width),
                "y": row.saturating_mul(frame_height),
                "w": frame_width,
                "h": frame_height,
                "duration": ((frame_duration * 1000.0).round() / 1000.0),
                "note": frame_notes.get(index).cloned().unwrap_or_default()
            })
        })
        .collect::<Vec<_>>();

    let json = serde_json::json!({
        "format": "storyboard-copilot.sprite-pack.v1",
        "packageName": package_name,
        "image": texture_name,
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "frameCount": timeline.attachment_names.len(),
        "sheet": {
            "cols": cols,
            "rows": rows,
            "width": texture_width,
            "height": texture_height
        },
        "animations": [
            {
                "name": timeline.name,
                "fps": timeline.fps,
                "loop": true,
                "frames": frame_items
            }
        ],
        "pivot": {
            "x": 0.5,
            "y": 1.0
        }
    });

    serde_json::to_vec_pretty(&json)
        .map_err(|e| format!("Failed to encode sprite metadata JSON: {e}"))
}

#[tauri::command]
pub async fn export_sequence_frames_as_sprite_pack(
    app: tauri::AppHandle,
    payload: ExportSequenceFramesAsSpritePackPayload,
) -> Result<PersistSpinePackageResult, String> {
    if payload.animation.frame_sources.is_empty() {
        return Err("No frame images provided".to_string());
    }

    let package_name = sanitize_spine_name(
        payload.package_name.as_deref().unwrap_or("sprite_pack"),
        "sprite_pack",
    );
    let animation_name =
        sanitize_spine_name(payload.animation.name.as_deref().unwrap_or("anim"), "anim");
    let fps = payload.animation.fps.unwrap_or(12.0).clamp(1.0, 60.0);
    let trim_transparent = payload.trim_transparent.unwrap_or(true);
    let alpha_threshold = payload.alpha_threshold.unwrap_or(8);
    let max_texture_size = payload.max_texture_size.unwrap_or(4096).clamp(256, 8192);

    let mut images = Vec::with_capacity(payload.animation.frame_sources.len());
    for source in &payload.animation.frame_sources {
        images.push(load_frame_image(source).await?);
    }
    let normalized = normalize_frames(images, trim_transparent, alpha_threshold);
    if normalized.is_empty() {
        return Err("No valid frame images provided".to_string());
    }

    let mut prepared_frames = Vec::with_capacity(normalized.len());
    let mut attachment_names = Vec::with_capacity(normalized.len());
    for (frame_index, image) in normalized.into_iter().enumerate() {
        let attachment_name = format!("{animation_name}_{:03}", frame_index + 1);
        attachment_names.push(attachment_name.clone());
        prepared_frames.push(PreparedFrame {
            animation_name: animation_name.clone(),
            attachment_name,
            image,
        });
    }

    let frame_width = prepared_frames[0].image.width().max(1);
    let frame_height = prepared_frames[0].image.height().max(1);
    for frame in &prepared_frames {
        if frame.image.width() != frame_width || frame.image.height() != frame_height {
            return Err(format!(
                "Frame size mismatch in animation {}. Expected {}x{}, got {}x{}",
                frame.animation_name,
                frame_width,
                frame_height,
                frame.image.width(),
                frame.image.height()
            ));
        }
    }

    let (cols, rows) = resolve_atlas_grid(
        prepared_frames.len(),
        frame_width,
        frame_height,
        max_texture_size,
    );
    let texture_width = cols.saturating_mul(frame_width);
    let texture_height = rows.saturating_mul(frame_height);
    if texture_width > max_texture_size || texture_height > max_texture_size {
        return Err(format!(
            "Sprite sheet would be too large: {}x{} (limit {})",
            texture_width, texture_height, max_texture_size
        ));
    }

    let mut sheet_image = RgbaImage::new(texture_width, texture_height);
    for (index, frame) in prepared_frames.iter().enumerate() {
        let col = (index as u32) % cols;
        let row = (index as u32) / cols;
        image::imageops::overlay(
            &mut sheet_image,
            &frame.image,
            (col.saturating_mul(frame_width)) as i64,
            (row.saturating_mul(frame_height)) as i64,
        );
    }

    let timeline = AnimationTimeline {
        name: animation_name,
        attachment_names,
        fps,
    };
    let texture_name = format!("{package_name}_sheet.png");
    let metadata_name = "frames.json".to_string();
    let frame_notes = payload.animation.frame_notes.unwrap_or_default();
    let metadata_bytes = build_sprite_pack_metadata(
        &package_name,
        &texture_name,
        &prepared_frames,
        &timeline,
        &frame_notes,
        cols,
        rows,
        texture_width,
        texture_height,
    )?;

    let package_id = compute_package_id(&[
        (metadata_name.clone(), metadata_bytes.clone()),
        (texture_name.clone(), encode_png(&sheet_image)?),
    ]);
    let base_dir = match payload
        .target_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(target_dir) => PathBuf::from(target_dir).join(&package_name),
        None => resolve_spine_assets_dir(&app)?.join(&package_id),
    };
    let frames_dir = base_dir.join("frames");
    std::fs::create_dir_all(&frames_dir)
        .map_err(|e| format!("Failed to create frames directory: {e}"))?;

    let mut stored_files = HashMap::new();
    let sheet_path = base_dir.join(&texture_name);
    std::fs::write(&sheet_path, encode_png(&sheet_image)?)
        .map_err(|e| format!("Failed to write {}: {e}", sheet_path.display()))?;
    stored_files.insert(texture_name, sheet_path.to_string_lossy().to_string());

    let metadata_path = base_dir.join(&metadata_name);
    std::fs::write(&metadata_path, metadata_bytes)
        .map_err(|e| format!("Failed to write {}: {e}", metadata_path.display()))?;
    stored_files.insert(metadata_name, metadata_path.to_string_lossy().to_string());

    for frame in prepared_frames {
        let file_name = format!("{}.png", frame.attachment_name);
        let frame_path = frames_dir.join(&file_name);
        std::fs::write(&frame_path, encode_png(&frame.image)?)
            .map_err(|e| format!("Failed to write {}: {e}", frame_path.display()))?;
        stored_files.insert(
            format!("frames/{file_name}"),
            frame_path.to_string_lossy().to_string(),
        );
    }

    Ok(PersistSpinePackageResult {
        package_id,
        files: stored_files,
    })
}

#[tauri::command]
pub async fn export_sequence_frames_as_spine(
    app: tauri::AppHandle,
    payload: ExportSequenceFramesAsSpinePayload,
) -> Result<PersistSpinePackageResult, String> {
    if payload.animations.is_empty() {
        return Err("No animations provided".to_string());
    }

    let package_name = sanitize_spine_name(
        payload.package_name.as_deref().unwrap_or("sequence_frames"),
        "sequence_frames",
    );
    let trim_transparent = payload.trim_transparent.unwrap_or(true);
    let alpha_threshold = payload.alpha_threshold.unwrap_or(8);
    let max_texture_size = payload.max_texture_size.unwrap_or(4096).clamp(256, 8192);

    let mut prepared_frames: Vec<PreparedFrame> = Vec::new();
    let mut timelines: Vec<AnimationTimeline> = Vec::new();

    for (animation_index, animation) in payload.animations.iter().enumerate() {
        if animation.frame_sources.is_empty() {
            continue;
        }

        let fallback_animation_name = if animation_index == 0 {
            "run".to_string()
        } else {
            format!("anim_{}", animation_index + 1)
        };
        let animation_name = sanitize_spine_name(
            animation
                .name
                .as_deref()
                .unwrap_or(&fallback_animation_name),
            &fallback_animation_name,
        );
        let fps = animation.fps.unwrap_or(12.0).clamp(1.0, 60.0);
        let _loop_animation = animation.loop_animation.unwrap_or(true);

        let mut images = Vec::with_capacity(animation.frame_sources.len());
        for source in &animation.frame_sources {
            images.push(load_frame_image(source).await?);
        }
        let normalized = normalize_frames(images, trim_transparent, alpha_threshold);
        let mut attachment_names = Vec::with_capacity(normalized.len());
        for (frame_index, image) in normalized.into_iter().enumerate() {
            let attachment_name = format!("{animation_name}_{:03}", frame_index + 1);
            attachment_names.push(attachment_name.clone());
            prepared_frames.push(PreparedFrame {
                animation_name: animation_name.clone(),
                attachment_name,
                image,
            });
        }
        timelines.push(AnimationTimeline {
            name: animation_name,
            attachment_names,
            fps,
        });
    }

    if prepared_frames.is_empty() {
        return Err("No valid frame images provided".to_string());
    }

    let frame_width = prepared_frames[0].image.width().max(1);
    let frame_height = prepared_frames[0].image.height().max(1);
    for frame in &prepared_frames {
        if frame.image.width() != frame_width || frame.image.height() != frame_height {
            return Err(format!(
                "Frame size mismatch in animation {}. Expected {}x{}, got {}x{}",
                frame.animation_name,
                frame_width,
                frame_height,
                frame.image.width(),
                frame.image.height()
            ));
        }
    }

    let (cols, rows) = resolve_atlas_grid(
        prepared_frames.len(),
        frame_width,
        frame_height,
        max_texture_size,
    );
    let texture_width = cols.saturating_mul(frame_width);
    let texture_height = rows.saturating_mul(frame_height);
    if texture_width > max_texture_size || texture_height > max_texture_size {
        return Err(format!(
            "Texture atlas would be too large: {}x{} (limit {})",
            texture_width, texture_height, max_texture_size
        ));
    }

    let mut atlas_image = RgbaImage::new(texture_width, texture_height);
    for (index, frame) in prepared_frames.iter().enumerate() {
        let col = (index as u32) % cols;
        let row = (index as u32) / cols;
        image::imageops::overlay(
            &mut atlas_image,
            &frame.image,
            (col.saturating_mul(frame_width)) as i64,
            (row.saturating_mul(frame_height)) as i64,
        );
    }

    let texture_name = format!("{package_name}.png");
    let atlas_name = format!("{package_name}.atlas");
    let json_name = format!("{package_name}.json");
    let texture_bytes = encode_png(&atlas_image)?;
    let atlas_bytes = build_atlas_text(
        &texture_name,
        texture_width,
        texture_height,
        &prepared_frames,
        cols,
    )
    .into_bytes();
    let json_bytes = build_spine_json(&package_name, &prepared_frames, &timelines)?;

    let mut loaded_files = vec![
        (atlas_name, atlas_bytes),
        (json_name, json_bytes),
        (texture_name, texture_bytes),
    ];
    loaded_files.sort_by(|(a, _), (b, _)| a.cmp(b));

    let package_id = compute_package_id(&loaded_files);
    let base_dir = match payload
        .target_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(target_dir) => PathBuf::from(target_dir).join(&package_name),
        None => resolve_spine_assets_dir(&app)?.join(&package_id),
    };
    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to create package directory: {e}"))?;

    let mut stored_files = HashMap::new();
    for (file_name, bytes) in loaded_files {
        let destination = base_dir.join(&file_name);
        std::fs::write(&destination, bytes)
            .map_err(|e| format!("Failed to write {}: {e}", destination.display()))?;
        stored_files.insert(
            file_name,
            destination
                .to_str()
                .ok_or_else(|| "Failed to encode destination path".to_string())?
                .to_string(),
        );
    }

    Ok(PersistSpinePackageResult {
        package_id,
        files: stored_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn sample_frame(animation_name: &str, attachment_name: &str) -> PreparedFrame {
        let mut image = RgbaImage::new(8, 8);
        for pixel in image.pixels_mut() {
            *pixel = Rgba([255, 0, 0, 255]);
        }
        PreparedFrame {
            animation_name: animation_name.to_string(),
            attachment_name: attachment_name.to_string(),
            image,
        }
    }

    #[test]
    fn spine_json_uses_attachment_timeline_for_sequence_frames() {
        let frames = vec![
            sample_frame("slash", "slash_001"),
            sample_frame("slash", "slash_002"),
        ];
        let timelines = vec![AnimationTimeline {
            name: "slash".to_string(),
            attachment_names: vec!["slash_001".to_string(), "slash_002".to_string()],
            fps: 5.0,
        }];

        let bytes = build_spine_json("hero", &frames, &timelines).expect("spine json");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(value["skeleton"]["spine"], "3.8.99");
        assert_eq!(value["slots"][0]["name"], "sprite");
        assert_eq!(
            value["animations"]["slash"]["slots"]["sprite"]["attachment"][0]["name"],
            "slash_001"
        );
        assert_eq!(
            value["animations"]["slash"]["slots"]["sprite"]["attachment"][1]["time"],
            0.2
        );
    }

    #[test]
    fn sprite_pack_metadata_maps_frames_to_sheet_rects_and_files() {
        let frames = vec![
            sample_frame("idle", "idle_001"),
            sample_frame("idle", "idle_002"),
            sample_frame("idle", "idle_003"),
        ];
        let timeline = AnimationTimeline {
            name: "idle".to_string(),
            attachment_names: vec![
                "idle_001".to_string(),
                "idle_002".to_string(),
                "idle_003".to_string(),
            ],
            fps: 6.0,
        };
        let notes = vec!["start".to_string(), "middle".to_string(), "end".to_string()];

        let bytes = build_sprite_pack_metadata(
            "hero",
            "hero_sheet.png",
            &frames,
            &timeline,
            &notes,
            2,
            2,
            16,
            16,
        )
        .expect("metadata json");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(value["format"], "storyboard-copilot.sprite-pack.v1");
        assert_eq!(value["image"], "hero_sheet.png");
        assert_eq!(
            value["animations"][0]["frames"][1]["file"],
            "frames/idle_002.png"
        );
        assert_eq!(value["animations"][0]["frames"][1]["x"], 8);
        assert_eq!(value["animations"][0]["frames"][2]["y"], 8);
        assert_eq!(value["animations"][0]["frames"][2]["note"], "end");
    }
}
