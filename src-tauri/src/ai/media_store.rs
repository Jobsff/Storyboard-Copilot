//! 生成结果落盘（渠道可靠性升级 · 模块 D meta 台账）。
//!
//! 4K 图的 dataURL 可达数 MB，直接写进 `ai_generation_jobs.result` 会让
//! DB 行膨胀、全表读写变慢。超过阈值的结果解码为二进制落盘
//! `app_data_dir/media/{job_id}.{ext}`，DB 只存轻量标记
//! `file:media/{job_id}.{ext}`；前端轮询终态时由 DTO 层还原成完整
//! data URL——**前端契约零改动**。
//!
//! 设计取舍：
//! - 统一 64KB 阈值：小 dataURL（缩略图/1K 小图）塞 DB 无妨，落盘的 IO
//!   与目录管理成本不划算（对应单测 `small_data_url_not_spooled`）。
//! - 已知图片 mime 解码为二进制存储（省 33% 空间、文件可直接被外部工具
//!   打开），读回时按扩展名反推 mime 重组 dataURL；未知 mime 或非 dataURL
//!   的超大文本按原文存 `.txt`，往返无损。
//! - 任何落盘 IO 失败都降级为"原样返回"（宁可塞 DB 也不丢生成结果）。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::Manager;
use tracing::{info, warn};

/// DB 中落盘标记的前缀（`file:media/{job_id}.{ext}`）。
pub const SPOOL_MARKER_PREFIX: &str = "file:media/";
/// 超过该长度的结果才落盘（字节）；以下直接存 DB。
const SPOOL_THRESHOLD_BYTES: usize = 64 * 1024;
/// 启动清理：media 目录超过该时长的文件删除。
const CLEANUP_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

// ──────────────────────────────────────────────────────────────────────
// mime ↔ ext
// ──────────────────────────────────────────────────────────────────────

/// mime → 扩展名（批次11 OSS 归档也消费，crate 内可见）。
pub(crate) fn mime_to_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpg" => Some("jpg"),
        "image/jpeg" => Some("jpeg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

pub(crate) fn ext_to_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// 解析 base64 型 data URL，返回 (mime, 解码后字节)。
pub(crate) fn parse_base64_data_url(source: &str) -> Option<(String, Vec<u8>)> {
    let rest = source.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(",")?;
    let mime = meta.strip_suffix(";base64")?.trim().to_lowercase();
    if mime.is_empty() || !mime.starts_with("image/") {
        return None;
    }
    let bytes = STANDARD.decode(payload.trim()).ok()?;
    Some((mime, bytes))
}

// ──────────────────────────────────────────────────────────────────────
// 编解码纯逻辑（可测）
// ──────────────────────────────────────────────────────────────────────

struct SpoolPayload {
    bytes: Vec<u8>,
    ext: &'static str,
}

/// 判定并编码落盘内容；None = 不落盘（原样存 DB，仅 ≤阈值时发生）。
fn encode_spool(source: &str) -> Option<SpoolPayload> {
    if source.len() <= SPOOL_THRESHOLD_BYTES {
        return None;
    }
    // 已知图片 mime：解码为二进制落盘；未知 mime 的 dataURL、解码失败或
    // 超大纯文本一律按原文存 .txt，保证读回与原文逐字节一致。
    match parse_base64_data_url(source) {
        Some((mime, bytes)) => match mime_to_ext(&mime) {
            Some(ext) => Some(SpoolPayload { bytes, ext }),
            None => Some(SpoolPayload {
                bytes: source.as_bytes().to_vec(),
                ext: "txt",
            }),
        },
        None => Some(SpoolPayload {
            bytes: source.as_bytes().to_vec(),
            ext: "txt",
        }),
    }
}

/// 按扩展名把落盘字节还原成与原始 source 一致的字符串。
fn decode_spooled(ext: &str, bytes: &[u8]) -> String {
    match ext_to_mime(ext) {
        Some(mime) => format!("data:{};base64,{}", mime, STANDARD.encode(bytes)),
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

// ──────────────────────────────────────────────────────────────────────
// 目录级 IO（AppHandle 薄封装的内核，可用临时目录测试）
// ──────────────────────────────────────────────────────────────────────

fn spool_to_dir(dir: &Path, job_id: &str, source: &str) -> Option<String> {
    let payload = encode_spool(source)?;
    let file_name = format!("{}.{}", job_id, payload.ext);
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(dir.join(&file_name), &payload.bytes).ok()?;
    Some(format!("{}{}", SPOOL_MARKER_PREFIX, file_name))
}

/// 读回落盘文件并还原为原始字符串；找不到 / 路径非法 / 读取失败 → None。
fn load_from_dir(dir: &Path, marker: &str) -> Option<String> {
    let rel = marker.strip_prefix(SPOOL_MARKER_PREFIX)?;
    // 路径穿越防护：只接受单段文件名（我们写入的形如 {uuid}.{ext}）。
    if rel.is_empty()
        || rel.contains('/')
        || rel.contains('\\')
        || rel.contains("..")
        || Path::new(rel).file_name().map(|name| name != rel).unwrap_or(true)
    {
        return None;
    }
    let ext = rel.rsplit('.').next()?;
    let bytes = std::fs::read(dir.join(rel)).ok()?;
    Some(decode_spooled(ext, &bytes))
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ──────────────────────────────────────────────────────────────────────
// AppHandle 接口
// ──────────────────────────────────────────────────────────────────────

fn media_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    Ok(app_data_dir.join("media"))
}

/// 生成结果入库前的统一入口：
/// - ≤64KB（含小 dataURL）→ 原样返回，直接存 DB；
/// - >64KB → 落盘 `media/{job_id}.{ext}`，返回标记 `file:media/{job_id}.{ext}`；
/// - 落盘失败 → 原样返回（降级塞 DB，不丢结果）。
pub fn spool_result(app: &tauri::AppHandle, job_id: &str, source: &str) -> String {
    match media_dir(app) {
        Ok(dir) => match spool_to_dir(&dir, job_id, source) {
            Some(marker) => marker,
            None => source.to_string(),
        },
        Err(error) => {
            warn!("media dir unavailable, keeping result inline: {}", error);
            source.to_string()
        }
    }
}

/// 由标记还原原始结果字符串；找不到返回 None（调用方降级为错误提示，不 panic）。
pub fn load_spooled(app: &tauri::AppHandle, marker: &str) -> Option<String> {
    let dir = media_dir(app).ok()?;
    load_from_dir(&dir, marker)
}

/// 读落盘**原始字节 + 扩展名**（批次11 OSS 归档数据源；避免 load_spooled 的
/// base64 重编码往返）。路径校验同 `load_from_dir`，找不到返回 None。
pub fn load_spooled_bytes(app: &tauri::AppHandle, marker: &str) -> Option<(Vec<u8>, String)> {
    let dir = media_dir(app).ok()?;
    let rel = marker.strip_prefix(SPOOL_MARKER_PREFIX)?;
    // 路径穿越防护：只接受单段文件名（我们写入的形如 {uuid}.{ext}）。
    if rel.is_empty()
        || rel.contains('/')
        || rel.contains('\\')
        || rel.contains("..")
        || Path::new(rel).file_name().map(|name| name != rel).unwrap_or(true)
    {
        return None;
    }
    let ext = rel.rsplit('.').next()?.to_string();
    let bytes = std::fs::read(dir.join(rel)).ok()?;
    Some((bytes, ext))
}

/// 启动清理：删除 media 目录中超过 7 天的文件。失败仅日志，不阻断启动。
pub fn cleanup_expired_media(app: &tauri::AppHandle) {
    let dir = match media_dir(app) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        // 目录尚不存在 = 从未落盘，静默返回。
        Err(_) => return,
    };

    let now = now_unix_ms();
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let age_ms = match meta.modified() {
            Ok(modified) => now
                .saturating_sub(
                    modified
                        .duration_since(UNIX_EPOCH)
                        .map(|age| age.as_millis() as i64)
                        .unwrap_or(0),
                ),
            Err(_) => continue,
        };
        if age_ms > CLEANUP_MAX_AGE.as_millis() as i64
            && std::fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    if removed > 0 {
        info!("cleaned {} expired media files (>7d)", removed);
    }
}

// ──────────────────────────────────────────────────────────────────────
// 单测：往返 / 阈值 / 未知 mime / IO 降级
// ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 1×1 px png 的 base64。
    const TINY_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn tiny_png_data_url() -> String {
        format!("data:image/png;base64,{}", TINY_PNG_B64)
    }

    fn large_png_data_url() -> String {
        // 合法 base64 大 payload：取不含 padding 的前 96 字符（4 的倍数长度）重复，
        // 直接 repeat 整串会把 padding '=' 留在中间导致解码失败。
        let chunk = &TINY_PNG_B64[..88]; // 无 padding、长度为 4 的倍数
        let payload = chunk.repeat(1100); // ~94KB > 64KB 阈值
        format!("data:image/png;base64,{}", payload)
    }

    #[test]
    fn small_data_url_not_spooled() {
        assert!(encode_spool(&tiny_png_data_url()).is_none());
        assert!(encode_spool("https://example.com/short.png").is_none());
    }

    #[test]
    fn large_base64_spools_and_restores() {
        let source = large_png_data_url();
        let payload = encode_spool(&source).expect("large data url must spool");
        assert_eq!(payload.ext, "png");
        assert!(payload.bytes.len() < source.len(), "decoded bytes smaller than base64 text");
        let restored = decode_spooled(payload.ext, &payload.bytes);
        assert_eq!(restored, source);
    }

    #[test]
    fn unknown_mime_spools_as_plain_text_roundtrip() {
        let chunk = &TINY_PNG_B64[..88]; // 无 padding、长度为 4 的倍数
        let payload_b64 = chunk.repeat(1000);
        let source = format!("data:image/xyz;base64,{}", payload_b64);
        let payload = encode_spool(&source).expect("oversize source must spool");
        assert_eq!(payload.ext, "txt");
        let restored = decode_spooled(payload.ext, &payload.bytes);
        assert_eq!(restored, source);
    }

    #[test]
    fn plain_oversize_text_spools_as_txt() {
        let source = "x".repeat(100 * 1024);
        let payload = encode_spool(&source).expect("oversize text must spool");
        assert_eq!(payload.ext, "txt");
        assert_eq!(decode_spooled(payload.ext, &payload.bytes), source);
    }

    #[test]
    fn jpeg_and_webp_ext_mapping() {
        let chunk = &TINY_PNG_B64[..88]; // 无 padding、长度为 4 的倍数
        let source = format!("data:image/jpeg;base64,{}", chunk.repeat(1000));
        assert_eq!(encode_spool(&source).unwrap().ext, "jpeg");
        let source = format!("data:image/webp;base64,{}", chunk.repeat(1000));
        assert_eq!(encode_spool(&source).unwrap().ext, "webp");
    }

    #[test]
    fn dir_roundtrip_and_missing_marker() {
        let dir = std::env::temp_dir().join(format!("sc-media-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let source = large_png_data_url();
        let marker = spool_to_dir(&dir, "job-1", &source).expect("spool to dir");
        assert!(marker.starts_with("file:media/job-1.png"));
        assert_eq!(load_from_dir(&dir, &marker).as_deref(), Some(source.as_str()));

        // 小图不落盘
        assert!(spool_to_dir(&dir, "job-2", &tiny_png_data_url()).is_none());

        // 不存在的标记 / 非法路径
        assert_eq!(load_from_dir(&dir, "file:media/job-missing.png"), None);
        assert_eq!(load_from_dir(&dir, "file:media/../projects.db"), None);
        assert_eq!(load_from_dir(&dir, "not-a-marker"), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
