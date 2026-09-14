use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;
use tracing::info;
use uuid::Uuid;

use crate::ai::chain::{
    self, chain_meta_to_json, parse_chain_meta, ChainAttempt, ChainMeta, FallbackOptions, Hop,
};
use crate::ai::error::AIError;
use crate::ai::error_classify::{classify_error_message, ErrorClass};
use crate::ai::media_store;
use crate::ai::oss_store::{self, OssConfig, OssUploadError};
use crate::ai::providers::build_default_providers;
use crate::ai::providers::api666::Api666Provider;
use crate::ai::providers::ollama::OllamaProvider;
use crate::ai::{
    GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
    ProviderTaskSubmission,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

/// 连续 poll 网络级错误达到该次数即判终态失败（不再伪装 running 无限转圈）。
const POLL_ERROR_FAIL_THRESHOLD: i64 = 3;
/// 单 hop 总时长兜底：running 超过此时限直接判 failed + Timeout（链任务自动降下一 hop，
/// 且每个 hop 各享完整时限——见 chain_meta.hop_started_at_ms）。
/// 由前端 1.4s 轮询在 get_generate_image_job 入口处天然驱动。
const JOB_MAX_RUNNING_MS: i64 = 15 * 60 * 1000;

fn get_registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(|| {
        let registry = ProviderRegistry::new();
        for provider in build_default_providers() {
            registry.register_provider(provider);
        }
        registry
    })
}

fn active_non_resumable_job_ids() -> &'static Arc<RwLock<HashSet<String>>> {
    ACTIVE_NON_RESUMABLE_JOB_IDS.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
    /// 智能出图（自动降级链）选项；None/缺省 = 单点直连，现有行为完全不变。
    #[serde(default)]
    pub fallback: Option<FallbackOptions>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReversePromptRequestDto {
    pub image: String,
    pub language: Option<String>,
    pub format: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    /// 终态 failed 时填充的错误类别（timeout/channel_down/auth/quota/content_filter/unknown），
    /// 供前端行动化按钮使用；非终态省略，保持向后兼容。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    /// 实际执行渠道（批次5 generationMeta）：running = 当前 hop，succeeded = 实际命中
    /// （批次2 已回填 job 行），failed = 最后尝试的 hop。经 dto_from_record 填充。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// 实际执行的完整模型 id（语义同 provider_id）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 链轨迹（逐 hop 失败记录）；单点任务 / 无轨迹时省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<Vec<ChainAttempt>>,
    /// 公司 OSS 归档直链（批次11）：成功且已归档才有。camelCase 与前端 GenerationMeta 对齐。
    #[serde(rename = "ossUrl", skip_serializing_if = "Option::is_none")]
    pub oss_url: Option<String>,
}

/// job 行 request_json 列的落库结构（批次3 meta 台账数据源）。
/// 只留台账需要的字段——刻意剥掉 reference_images / extra_params，
/// 防止参考图大 dataURL 滞留 DB（与 chain_meta 终态剥 request 同一原则）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JobRequestSnapshot {
    prompt: String,
    model: String,
    size: String,
    aspect_ratio: String,
    /// 归档目录工程名（批次11）：前端 gateway 从 projectStore 注入 extra_params.oss_project；
    /// 重启恢复路径的归档从本快照读它。Rust 侧归档时再清洗一次兜底。
    #[serde(default)]
    oss_project: Option<String>,
}

fn job_request_snapshot_json(request: &GenerateRequest) -> Option<String> {
    let snapshot = JobRequestSnapshot {
        prompt: request.prompt.clone(),
        model: request.model.clone(),
        size: request.size.clone(),
        aspect_ratio: request.aspect_ratio.clone(),
        oss_project: request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("oss_project"))
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    serde_json::to_string(&snapshot).ok()
}

fn parse_request_snapshot(raw: Option<&str>) -> Option<JobRequestSnapshot> {
    serde_json::from_str(raw?).ok()
}

/// ai_generation_history 的查询 DTO（批次5 UI 消费；attempts_json 为
/// 链轨迹原文，前端按需解析或直接展示 summarize 文案）。
#[derive(Debug, Serialize)]
pub struct GenerationHistoryDto {
    pub job_id: String,
    pub provider_id: String,
    pub model: String,
    pub mode: String,
    pub quality: Option<String>,
    pub prompt: Option<String>,
    pub size: Option<String>,
    pub aspect_ratio: Option<String>,
    pub duration_ms: Option<i64>,
    pub attempts_json: Option<String>,
    pub status: String,
    pub error_class: Option<String>,
    pub created_at: i64,
    /// 公司 OSS 归档直链（批次11）；未归档省略。camelCase 与前端字段对齐。
    #[serde(rename = "ossUrl", skip_serializing_if = "Option::is_none")]
    pub oss_url: Option<String>,
}

#[derive(Debug, Clone)]
struct GenerationJobRecord {
    job_id: String,
    provider_id: String,
    status: String,
    resumable: bool,
    external_task_id: Option<String>,
    external_task_meta_json: Option<String>,
    result: Option<String>,
    error: Option<String>,
    created_at: i64,
    poll_error_streak: i64,
    first_poll_error_at: Option<i64>,
    /// 降级链状态（None = 单点直连任务）。hop 推进 / 轨迹汇总 / 重启恢复的数据源。
    chain_meta_json: Option<String>,
    /// 本次 job 实际请求的完整模型 id（链 job 随 hop 切换更新；成功后即"实际命中渠道"台账）。
    model: Option<String>,
    /// 原始请求精简快照（prompt/model/size/aspect_ratio/oss_project，无参考图）。history 台账数据源。
    request_json: Option<String>,
    /// 公司 OSS 归档直链（批次11）：归档成功后由 archive_result_to_oss 写回。
    oss_url: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("projects.db"))
}

fn ensure_generation_jobs_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          poll_error_streak INTEGER NOT NULL DEFAULT 0,
          first_poll_error_at INTEGER,
          chain_meta_json TEXT,
          model TEXT,
          request_json TEXT,
          oss_url TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_jobs table: {}", e))?;

    ensure_generation_history_table(conn)?;

    // 老库自愈：缺失的 poll 治理列逐个补齐（新增列均可空/有默认值，老数据不受影响）。
    let existing_columns: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(ai_generation_jobs)")
            .map_err(|e| format!("Failed to inspect ai_generation_jobs schema: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Failed to inspect ai_generation_jobs columns: {}", e))?;
        rows.filter_map(|name| name.ok()).collect()
    };

    if !existing_columns.iter().any(|name| name == "poll_error_streak") {
        conn.execute(
            "ALTER TABLE ai_generation_jobs ADD COLUMN poll_error_streak INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to add poll_error_streak column: {}", e))?;
    }
    if !existing_columns.iter().any(|name| name == "first_poll_error_at") {
        conn.execute(
            "ALTER TABLE ai_generation_jobs ADD COLUMN first_poll_error_at INTEGER",
            [],
        )
        .map_err(|e| format!("Failed to add first_poll_error_at column: {}", e))?;
    }
    if !existing_columns.iter().any(|name| name == "chain_meta_json") {
        conn.execute(
            "ALTER TABLE ai_generation_jobs ADD COLUMN chain_meta_json TEXT",
            [],
        )
        .map_err(|e| format!("Failed to add chain_meta_json column: {}", e))?;
    }
    if !existing_columns.iter().any(|name| name == "model") {
        conn.execute(
            "ALTER TABLE ai_generation_jobs ADD COLUMN model TEXT",
            [],
        )
        .map_err(|e| format!("Failed to add model column: {}", e))?;
    }
    if !existing_columns.iter().any(|name| name == "request_json") {
        conn.execute(
            "ALTER TABLE ai_generation_jobs ADD COLUMN request_json TEXT",
            [],
        )
        .map_err(|e| format!("Failed to add request_json column: {}", e))?;
    }
    if !existing_columns.iter().any(|name| name == "oss_url") {
        conn.execute(
            "ALTER TABLE ai_generation_jobs ADD COLUMN oss_url TEXT",
            [],
        )
        .map_err(|e| format!("Failed to add oss_url column: {}", e))?;
    }

    Ok(())
}

/// 生成历史台账表（批次3 模块 D）：成功失败都记，meta sidecar 产品化。
/// 新表用 CREATE IF NOT EXISTS 即幂等，无老库迁移问题。
fn ensure_generation_history_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_history (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          mode TEXT NOT NULL,
          quality TEXT,
          prompt TEXT,
          size TEXT,
          aspect_ratio TEXT,
          duration_ms INTEGER,
          attempts_json TEXT,
          status TEXT NOT NULL,
          error_class TEXT,
          created_at INTEGER NOT NULL,
          oss_url TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_history_created_at
          ON ai_generation_history(created_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_history table: {}", e))?;

    // 老库自愈（批次11）：批次3 建的老 history 表没有 oss_url 列，补齐（可空，无痛升级）。
    let existing_columns: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(ai_generation_history)")
            .map_err(|e| format!("Failed to inspect ai_generation_history schema: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Failed to inspect ai_generation_history columns: {}", e))?;
        rows.filter_map(|name| name.ok()).collect()
    };
    if !existing_columns.iter().any(|name| name == "oss_url") {
        conn.execute(
            "ALTER TABLE ai_generation_history ADD COLUMN oss_url TEXT",
            [],
        )
        .map_err(|e| format!("Failed to add oss_url column to history: {}", e))?;
    }

    Ok(())
}

/// 渠道健康台账（模块 C doctor）：每次 probe_channels upsert per provider，
/// list_channel_health 读最近结果；软降权读 status='down' 的渠道 id。
fn ensure_channel_health_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_channel_health (
          provider_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          latency_ms INTEGER,
          detail TEXT,
          chain_models_ok INTEGER,
          checked_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_channel_health table: {}", e))?;

    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to set temp_store=MEMORY: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

    ensure_generation_jobs_table(&conn)?;
    ensure_channel_health_table(&conn)?;
    Ok(conn)
}

#[allow(clippy::too_many_arguments)]
fn insert_generation_job(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    status: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
    result: Option<&str>,
    error: Option<&str>,
    model: Option<&str>,
    chain_meta_json: Option<&str>,
    request_json: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO ai_generation_jobs (
          job_id,
          provider_id,
          status,
          resumable,
          external_task_id,
          external_task_meta_json,
          result,
          error,
          created_at,
          updated_at,
          model,
          chain_meta_json,
          request_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        "#,
        params![
            job_id,
            provider_id,
            status,
            if resumable { 1_i64 } else { 0_i64 },
            external_task_id,
            external_task_meta_json,
            result,
            error,
            now,
            now,
            model,
            chain_meta_json,
            request_json
        ],
    )
    .map_err(|e| format!("Failed to insert generation job: {}", e))?;
    Ok(())
}

fn update_generation_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          error = ?3,
          updated_at = ?4,
          poll_error_streak = 0,
          first_poll_error_at = NULL
        WHERE job_id = ?5
        "#,
        params![status, result, error, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job: {}", e))?;
    Ok(())
}

/// Running 轮询成功路径：顺带重置连续错误计数（本次 poll 证明渠道可达）。
fn touch_generation_job(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET updated_at = ?1, poll_error_streak = 0, first_poll_error_at = NULL WHERE job_id = ?2",
        params![now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to touch generation job: {}", e))?;
    Ok(())
}

/// poll Err（非 TaskFailed）路径：累加连续错误计数，记录首次出错时间。
fn record_poll_error(
    app: &AppHandle,
    job_id: &str,
    streak: i64,
    first_poll_error_at: Option<i64>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET poll_error_streak = ?1, first_poll_error_at = ?2, updated_at = ?3 WHERE job_id = ?4",
        params![streak, first_poll_error_at, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to record poll error: {}", e))?;
    Ok(())
}

/// 终态收口：每条 succeeded / failed 路径都必须调用——写 ai_generation_history 台账。
///
/// 数据全部自足取自 job 行（finalize 时机晚于行写入）：
/// - provider_id / model = job 行值：成功 = 实际命中渠道（批次2回填），失败 = 最后尝试的 hop
/// - duration_ms = now - created_at
/// - mode：chain_meta 存在 = auto（有 fallback，含空链退化单点），否则 manual
/// - quality / attempts_json：来自 chain_meta（单点任务为 NULL）
/// - prompt / size / aspect_ratio：来自 request_json 精简快照（无参考图，防膨胀）
///
/// INSERT OR REPLACE 幂等：CAS 竞争 / 重复轮询多次到达同一终态时台账以最后写入为准。
fn finalize_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    error_class: Option<&str>,
) -> Result<(), String> {
    let Some(record) = get_generation_job(app, job_id)? else {
        return Ok(()); // job 行都没了，无从记台账
    };

    let meta = parse_chain_meta(record.chain_meta_json.as_deref());
    let mode = if record.chain_meta_json.is_some() {
        "auto"
    } else {
        "manual"
    };
    let quality = meta.as_ref().map(|meta| meta.quality.clone());
    let attempts_json = match meta.as_ref().map(|meta| meta.attempts.is_empty()) {
        Some(false) => meta
            .as_ref()
            .and_then(|meta| serde_json::to_string(&meta.attempts).ok()),
        _ => None,
    };
    let snapshot = parse_request_snapshot(record.request_json.as_deref());
    let prompt = snapshot
        .as_ref()
        .map(|snapshot| chain::truncate_chars(&snapshot.prompt, 512));
    let size = snapshot.as_ref().map(|snapshot| snapshot.size.clone());
    let aspect_ratio = snapshot
        .as_ref()
        .map(|snapshot| snapshot.aspect_ratio.clone());
    let duration_ms = Some(now_ms().saturating_sub(record.created_at));

    let conn = open_db(app)?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO ai_generation_history (
          job_id, provider_id, model, mode, quality, prompt,
          size, aspect_ratio, duration_ms, attempts_json, status, error_class, created_at, oss_url
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#,
        params![
            record.job_id,
            record.provider_id,
            record.model.clone().unwrap_or_default(),
            mode,
            quality,
            prompt,
            size,
            aspect_ratio,
            duration_ms,
            attempts_json,
            status,
            error_class,
            record.created_at,
            record.oss_url
        ],
    )
    .map_err(|e| format!("Failed to insert generation history: {}", e))?;
    Ok(())
}

/// 归档成功后写回 job 行 oss_url（批次11）：finalize_job 随后从 job 行
/// 读它落入 history 台账。失败仅日志，不影响出图终态。
fn set_job_oss_url(app: &AppHandle, job_id: &str, url: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET oss_url = ?1 WHERE job_id = ?2",
        params![url, job_id],
    )
    .map_err(|e| format!("Failed to set job oss_url: {}", e))?;
    Ok(())
}

// ============================== 公司 OSS 归档（批次11 + 补丁2） ==============================
//
// 出图成功后自动把结果图上传公司阿里 OSS（全渠道统一一条路，grsai 无快车道），
// key = `{工程名}/{唯一段}_{provider}_{裸模型名}.{ext}`（补丁2 扁平化，唯一段=job_id），
// 拿桶直链永久 URL。手动补传（archive_image_manual）唯一段=毫秒时间戳。
//
// 时机：**update_generation_job 标 succeeded 之前**——finalize_job 随后从 job 行
// 读 oss_url 一并落入 history 台账，成功轮询的 DTO 首包即带 ossUrl，前端无需补拉。
// 代价是成功可见时间最多让路上传耗时（HEAD 5s + PUT 60s 封顶，典型 <2s），
// 且任何失败只 warn 一行直接走终态——软失败铁律：归档绝不影响出图。

/// 下载结果图字节（热修 2026-09-12：裸 http URL 源专用）。单请求 30s 硬上限；
/// 非 2xx / 下载失败 → warn 一行返回 None（软失败铁律：绝不影响出图）。
async fn download_result_image(url: &str) -> Option<Vec<u8>> {
    match crate::ai::http::http_client()
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            if !status.is_success() {
                tracing::warn!("OSS archive: result URL download failed ({}) for {} — skipped", status, url);
                return None;
            }
            match response.bytes().await {
                Ok(bytes) => Some(bytes.to_vec()),
                Err(error) => {
                    tracing::warn!("OSS archive: result URL body read failed: {} — skipped", error);
                    None
                }
            }
        }
        Err(error) => {
            tracing::warn!("OSS archive: result URL request failed: {} — skipped", error);
            None
        }
    }
}

/// 本地文件系统绝对路径判定（Windows 盘符 / Unix 斜杠 / UNC）。
fn is_local_filesystem_path(source: &str) -> bool {
    if source.starts_with('/') || source.starts_with("\\\\") {
        return true;
    }
    let bytes = source.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// 解析归档源为 (bytes, ext, content_type)。四种形态（自动归档与手动补传共用，补丁2）：
/// - `file:media/` 标记 → 读 media 落盘文件（ext 自文件名）；
/// - 裸 http(s) URL（热修 2026-09-12：grsai 全系渠道返回 URL 结果）→ 下载后魔数嗅探；
/// - 本地绝对路径（补丁2 手动补传：节点图上传/生成结果都落盘为此形态）→ std::fs::read + 嗅探；
/// - 内联 dataURL → base64 解码（ext 自 mime）。
/// 失败返回 None（内部已日志；调用方按场景补 job 上下文）。
async fn resolve_archive_image_source(
    app: &AppHandle,
    source: &str,
) -> Option<(Vec<u8>, String, String)> {
    if let Some(marker) = source.strip_prefix(media_store::SPOOL_MARKER_PREFIX) {
        let (bytes, ext) = match media_store::load_spooled_bytes(app, marker) {
            Some(pair) => pair,
            None => {
                tracing::warn!("OSS archive: media file missing for marker {}", marker);
                return None;
            }
        };
        return match media_store::ext_to_mime(&ext) {
            Some(mime) => Some((bytes, ext, mime.to_string())),
            None => {
                tracing::debug!("OSS archive: non-image spool ext {}", ext);
                None
            }
        };
    }

    if source.starts_with("http://") || source.starts_with("https://") {
        let bytes = download_result_image(source).await?;
        let (ext, mime) = oss_store::sniff_image(&bytes)?;
        return Some((bytes, ext.to_string(), mime.to_string()));
    }

    if is_local_filesystem_path(source) {
        return match std::fs::read(source) {
            Ok(bytes) => match oss_store::sniff_image(&bytes) {
                Some((ext, mime)) => Some((bytes, ext.to_string(), mime.to_string())),
                None => {
                    tracing::debug!("OSS archive: local file not a known image: {}", source);
                    None
                }
            },
            Err(error) => {
                tracing::debug!("OSS archive: local file unreadable ({}): {}", error, source);
                None
            }
        };
    }

    match media_store::parse_base64_data_url(source) {
        Some((mime, bytes)) => match media_store::mime_to_ext(&mime) {
            Some(ext) => Some((bytes, ext.to_string(), mime)),
            None => {
                tracing::debug!("OSS archive: non-image dataURL mime {}", mime);
                None
            }
        },
        None => {
            tracing::debug!("OSS archive: source is none of spool/http/local-path/dataURL");
            None
        }
    }
}

/// 归档结果到公司 OSS；返回桶直链。未配凭据 / 数据缺失 / 上传失败 → None（内部已日志）。
async fn archive_result_to_oss(
    app: &AppHandle,
    job_id: &str,
    stored: &str,
    model: &str,
) -> Option<String> {
    let Some(config) = oss_store::current_config() else {
        tracing::debug!("OSS archive skipped (not configured): job {}", job_id);
        return None;
    };

    // 元数据自 job 行：provider_id = 实际命中渠道，
    // request_json.oss_project = 前端注入的工程名（重启恢复路径同样可读）。
    let record = match get_generation_job(app, job_id) {
        Ok(Some(record)) => record,
        _ => {
            tracing::warn!("OSS archive skipped (job row missing): job {}", job_id);
            return None;
        }
    };
    let snapshot = parse_request_snapshot(record.request_json.as_deref());
    let project = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.oss_project.as_deref())
        .unwrap_or("");

    let (bytes, ext, content_type) = match resolve_archive_image_source(app, stored).await {
        Some(triple) => triple,
        None => {
            tracing::debug!("OSS archive skipped (unsupported/unreadable source): job {}", job_id);
            return None;
        }
    };

    let key = oss_store::build_object_key(
        project,
        job_id,
        record.provider_id.as_str(),
        model,
        ext.as_str(),
    );
    match oss_store::upload_image(&config, &key, &bytes, content_type.as_str()).await {
        Some(url) => {
            // 伴档（批次12）：画廊卡片简介数据源，取自 job 行 request_json 快照。
            // 软失败——伴档丢了只是画廊没简介，不影响 oss_url 返回与出图终态。
            let meta = oss_store::ArchiveSidecarMeta {
                provider: non_empty_str(&record.provider_id),
                model: non_empty_str(model),
                aspect_ratio: snapshot
                    .as_ref()
                    .and_then(|s| non_empty_str(&s.aspect_ratio)),
                size: snapshot.as_ref().and_then(|s| non_empty_str(&s.size)),
                prompt: snapshot.as_ref().and_then(|s| non_empty_str(&s.prompt)),
                job_id: Some(job_id),
                archived_at: now_ms(),
            };
            if let Ok(meta_json) = serde_json::to_string(&meta) {
                let _ = oss_store::upload_meta_sidecar(&config, &key, &meta_json).await;
            }
            if let Err(error) = set_job_oss_url(app, job_id, &url) {
                tracing::warn!("OSS archive: failed to persist oss_url for job {}: {}", job_id, error);
            }
            Some(url)
        }
        None => None,
    }
}

/// 去首尾空白后非空才参与伴档序列化（空串一律省略字段）。
fn non_empty_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 手动补传归档（补丁2）：图片工具栏「上传归档」按钮，补传历史未归档的图。
/// 源形态与自动归档共用 resolve_archive_image_source（四种）；无 job_id，
/// key 唯一段=当前毫秒时间戳，provider 缺省 manual、model 缺省 image（取 `/` 后裸名）。
/// 返回桶直链；未配凭据 / 源不可读 / 上传失败 → Err 人话中文（前端直接展示）。
#[tauri::command]
pub async fn archive_image_manual(
    app: AppHandle,
    source: String,
    oss_project: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let Some(config) = oss_store::current_config() else {
        return Err("请先在设置 → 资产归档 填写公司密钥".to_string());
    };
    let source = source.trim();
    if source.is_empty() {
        return Err("图片源为空，无法归档".to_string());
    }

    let (bytes, ext, content_type) = resolve_archive_image_source(&app, source)
        .await
        .ok_or_else(|| "图片源不可读：本地文件不存在或不是 PNG/JPEG/WebP 图片".to_string())?;

    let project = oss_project.as_deref().map(str::trim).unwrap_or("");
    let provider = provider_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("manual");
    let model_name = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    let key = oss_store::build_object_key(project, &now_ms().to_string(), provider, model_name, ext.as_str());

    match oss_store::upload_image_detail(&config, &key, &bytes, content_type.as_str()).await {
        Ok(url) => {
            // 伴档（批次12）：手动补传无 job/请求快照，provider/model 缺省 manual/image，
            // prompt 等缺省一律省略；软失败不影响归档主结果。
            let meta = oss_store::ArchiveSidecarMeta {
                provider: Some(provider),
                model: Some(model_name),
                aspect_ratio: None,
                size: None,
                prompt: None,
                job_id: None,
                archived_at: now_ms(),
            };
            if let Ok(meta_json) = serde_json::to_string(&meta) {
                let _ = oss_store::upload_meta_sidecar(&config, &key, &meta_json).await;
            }
            Ok(url)
        }
        Err(OssUploadError::Http(status)) => {
            Err(format!("归档上传失败（OSS 返回 HTTP {status}），请检查密钥与权限"))
        }
        Err(OssUploadError::Timeout) => Err("归档上传超时，请检查网络后重试".to_string()),
        Err(OssUploadError::Network(message)) => Err(format!(
            "归档上传失败：网络不可达（{}）",
            chain::truncate_chars(&message, 160)
        )),
    }
}

#[tauri::command]
pub async fn set_oss_config(ak: String, sk: String) -> Result<(), String> {
    info!("Setting OSS archive config (enabled: {})", !ak.trim().is_empty() && !sk.trim().is_empty());
    oss_store::set_oss_config(&ak, &sk);
    Ok(())
}

/// 归档通道连通性测试：生成 1×1 PNG 上传 `未分类/.connectivity-test-{unix_ts}.png`。
/// 优先用显式传入的密钥（设置页未保存即可测），否则用已注入配置。
/// 返回人话成功信息 + URL；失败返回人话原因（403=密钥/签名错、超时、网络不可达）。
#[tauri::command]
pub async fn test_oss_archive(
    access_key: Option<String>,
    secret_key: Option<String>,
) -> Result<String, String> {
    const CONNECTIVITY_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    let config = match access_key
        .as_deref()
        .map(str::trim)
        .filter(|ak| !ak.is_empty())
        .zip(secret_key.as_deref().map(str::trim).filter(|sk| !sk.is_empty()))
    {
        Some((ak, sk)) => OssConfig {
            access_key: ak.to_string(),
            secret_key: sk.to_string(),
        },
        None => oss_store::current_config().ok_or_else(|| {
            "尚未配置 AccessKey / Secret，请先填写".to_string()
        })?,
    };

    let unix_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let key = format!("未分类/.connectivity-test-{}.png", unix_ts);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(CONNECTIVITY_PNG_B64)
        .map_err(|e| format!("test payload decode failed: {}", e))?;

    match oss_store::upload_image_detail(&config, &key, &bytes, "image/png").await {
        Ok(url) => Ok(format!("连接成功，归档通道可用：{}", url)),
        Err(OssUploadError::Http(403)) => Err(
            "连接失败：签名或密钥错误（HTTP 403），请检查 AccessKey / Secret 是否正确".to_string(),
        ),
        Err(OssUploadError::Http(status)) => Err(format!("连接失败：OSS 返回 HTTP {}", status)),
        Err(OssUploadError::Timeout) => Err("连接失败：请求超时，请检查网络后重试".to_string()),
        Err(OssUploadError::Network(message)) => {
            Err(format!("连接失败：网络不可达（{}）", chain::truncate_chars(&message, 160)))
        }
    }
}

/// 终态失败唯一出口（单点任务 / 链任务兜底路径都走这里）：写库 + 台账 + 构造带 error_class 的 DTO。
/// 链任务的拦截与 hop 推进在上层 fail_or_advance；本函数只负责把终态写死。
fn fail_job(
    app: &AppHandle,
    job_id: &str,
    message: &str,
    class: ErrorClass,
) -> Result<GenerationJobStatusDto, String> {
    update_generation_job(app, job_id, "failed", None, Some(message))?;
    if let Err(error) = finalize_job(app, job_id, "failed", Some(class.as_str())) {
        info!("Failed to write generation history for {}: {}", job_id, error);
    }
    Ok(GenerationJobStatusDto {
        job_id: job_id.to_string(),
        status: "failed".to_string(),
        result: None,
        error: Some(message.to_string()),
        error_class: Some(class.as_str().to_string()),
        provider_id: None,
        model: None,
        attempts: None,
        oss_url: None,
    })
}

/// 链终态失败：错误 = 全链人话轨迹；chain_meta 剥除原始请求（参考图可能含大 dataURL）
/// 但保留 attempts 轨迹（meta 台账数据源）。history 台账经 finalize_job 收口。
fn write_terminal_chain_failure(
    app: &AppHandle,
    job_id: &str,
    meta: &ChainMeta,
    message: &str,
    error_class: &str,
) -> Result<(), String> {
    let mut terminal_meta = meta.clone();
    terminal_meta.request = None;
    let chain_json = chain_meta_to_json(&terminal_meta)
        .ok_or_else(|| "Failed to serialize terminal chain meta".to_string())?;
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET status = 'failed',
            error = ?1,
            chain_meta_json = ?2,
            updated_at = ?3,
            poll_error_streak = 0,
            first_poll_error_at = NULL
        WHERE job_id = ?4
        "#,
        params![message, chain_json, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to write terminal chain failure: {}", e))?;
    if let Err(error) = finalize_job(app, job_id, "failed", Some(error_class)) {
        info!("Failed to write generation history for {}: {}", job_id, error);
    }
    Ok(())
}

/// 成功终态收尾：把 chain_meta_json 里的原始请求快照剥掉再存回（批次3遗留：
/// 成功路径原本不剥，参考图可能含大 dataURL 长期滞留 DB）。attempts 轨迹保留
/// （history 台账与前端 generationMeta 数据源）。单点任务 / 无请求快照时为空操作。
fn strip_chain_meta_request_on_success(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let Some(record) = get_generation_job(app, job_id)? else {
        return Ok(());
    };
    let Some(chain_json) = record.chain_meta_json else {
        return Ok(()); // 单点任务无 chain_meta
    };
    let Some(mut meta) = parse_chain_meta(Some(chain_json.as_str())) else {
        return Ok(());
    };
    if meta.request.is_none() {
        return Ok(()); // 已剥过
    }
    meta.request = None;
    let Some(new_chain_json) = chain_meta_to_json(&meta) else {
        return Ok(()); // 序列化失败宁可不剥，不影响成功结果
    };
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET chain_meta_json = ?1 WHERE job_id = ?2",
        params![new_chain_json, job_id],
    )
    .map_err(|e| format!("Failed to strip chain meta request: {}", e))?;
    Ok(())
}

/// hop 推进的 CAS 单点更新（防重入核心）：
/// WHERE 同时比对 chain_meta_json 原值与 status='running'——
/// 并发 poll / spawned 任务 / 重启恢复多方竞争时只有一个赢家，
/// 杜绝双渠道重提交（双扣费）；输家按最新行状态返回。
/// 成功同时完成：current+1 落库、provider/model 回填、外部任务句柄清空、streak 重置。
#[allow(clippy::too_many_arguments)]
/// CAS 推进 hop：WHERE 双条件（status='running' + chain_meta_json IS 旧值快照）保证多窗口
/// 并发轮询下只有一方推进成功；败者下次 get_generation_job 重载行自我修正，无需事务。
fn cas_advance_hop(
    app: &AppHandle,
    job_id: &str,
    expected_chain_json: Option<&str>,
    new_chain_json: &str,
    hop: &Hop,
    resumable: bool,
) -> Result<bool, String> {
    let conn = open_db(app)?;
    let affected = conn
        .execute(
            r#"
            UPDATE ai_generation_jobs
            SET chain_meta_json = ?1,
                provider_id = ?2,
                model = ?3,
                status = 'running',
                resumable = ?4,
                external_task_id = NULL,
                external_task_meta_json = NULL,
                error = NULL,
                updated_at = ?5,
                poll_error_streak = 0,
                first_poll_error_at = NULL
            WHERE job_id = ?6
              AND status = 'running'
              AND chain_meta_json IS ?7
            "#,
            params![
                new_chain_json,
                hop.provider_id,
                hop.model,
                if resumable { 1_i64 } else { 0_i64 },
                now_ms(),
                job_id,
                expected_chain_json
            ],
        )
        .map_err(|e| format!("Failed to advance chain hop: {}", e))?;
    Ok(affected == 1)
}

/// resumable hop 提交后写入外部任务句柄。
fn update_external_task(
    app: &AppHandle,
    job_id: &str,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET external_task_id = ?1,
            external_task_meta_json = ?2,
            updated_at = ?3,
            poll_error_streak = 0,
            first_poll_error_at = NULL
        WHERE job_id = ?4
        "#,
        params![
            external_task_id,
            external_task_meta_json,
            now_ms(),
            job_id
        ],
    )
    .map_err(|e| format!("Failed to update external task handle: {}", e))?;
    Ok(())
}

/// submit_hop 的三态结果。
enum HopSubmitOutcome {
    /// 已提交（resumable 排队 / 非 resumable 已 spawn）。
    Submitted,
    /// resumable 渠道同步完成（如 grsai 直接回图）。
    Succeeded(String),
    /// 本 hop 提交即失败（网络/鉴权等）——上层继续推进下一 hop。
    SubmitFailed(String, ErrorClass),
}

/// 批次13（R2）：把 hop 级 extra_params_overlay 逐项合并进 request.extra_params
/// （None→Some(overlay)；Some(map)→insert 各项，hop 覆盖同名键）。两处调用点：
/// submit_hop_inner（换 hop 重提交）与 submit_generate_image_job 首 hop 直接提交点。
fn apply_overlay(
    request: &mut crate::ai::GenerateRequest,
    overlay: &Option<HashMap<String, Value>>,
) {
    let Some(overlay) = overlay else {
        return; // None 不动
    };
    let params = request.extra_params.get_or_insert_with(HashMap::new);
    for (key, value) in overlay {
        params.insert(key.clone(), value.clone());
    }
}

/// 向指定 hop 提交生成（fail_or_advance 的执行臂；不递归，失败向上抛给主循环迭代）。
/// 外壳做类型擦除（dyn Future + Send）：打断 submit_hop ↔ fail_or_advance 的
/// 异步递归 Send 推断环（spawn 闭包 → fail_or_advance → submit_hop → spawn 闭包）。
fn submit_hop<'a>(
    app: &'a AppHandle,
    job_id: &'a str,
    meta: &'a ChainMeta,
    hop: &'a Hop,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = HopSubmitOutcome> + Send + 'a>> {
    Box::pin(submit_hop_inner(app, job_id, meta, hop))
}

async fn submit_hop_inner(
    app: &AppHandle,
    job_id: &str,
    meta: &ChainMeta,
    hop: &Hop,
) -> HopSubmitOutcome {
    let registry = get_registry();
    let Some(provider) = registry.resolve_provider_for_model(&hop.model) else {
        return HopSubmitOutcome::SubmitFailed(
            format!("Provider not found for hop: {}", hop.model),
            ErrorClass::Unknown,
        );
    };

    // 原始请求为底、仅替换模型名（build_chain 已保证 hop 模型可被对应 provider 路由）。
    let Some(mut request) = meta.request.clone() else {
        return HopSubmitOutcome::SubmitFailed(
            "chain meta missing original request".to_string(),
            ErrorClass::Unknown,
        );
    };
    request.model = hop.model.clone();
    // 批次13（R2）：hop 级 overlay（如透明底 transparent_background）合并进 extra_params。
    apply_overlay(&mut request, &hop.extra_params_overlay);

    if provider.supports_task_resume() {
        match provider.submit_task(request).await {
            Ok(ProviderTaskSubmission::Succeeded(image_source)) => {
                // 结果落盘（大图标记化），终态台账收口；DTO 侧还原原文，前端契约不变。
                let stored = media_store::spool_result(app, job_id, &image_source);
                // 公司 OSS 归档（批次11）：标 succeeded 之前，失败软跳过绝不阻断。
                let _ = archive_result_to_oss(app, job_id, &stored, &hop.model).await;
                let _ = update_generation_job(app, job_id, "succeeded", Some(stored.as_str()), None);
                // 成功终态：剥掉 chain_meta 里的原始请求快照（防参考图 dataURL 滞留 DB）。
                if let Err(error) = strip_chain_meta_request_on_success(app, job_id) {
                    info!("Failed to strip chain meta request for {}: {}", job_id, error);
                }
                if let Err(error) = finalize_job(app, job_id, "succeeded", None) {
                    info!("Failed to write generation history for {}: {}", job_id, error);
                }
                HopSubmitOutcome::Succeeded(image_source)
            }
            Ok(ProviderTaskSubmission::Queued(handle)) => {
                let meta_json = handle
                    .metadata
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                let _ = update_external_task(
                    app,
                    job_id,
                    Some(handle.task_id.as_str()),
                    meta_json.as_deref(),
                );
                HopSubmitOutcome::Submitted
            }
            Err(error) => {
                let message = error.to_string();
                let class = classify_error_message(&message);
                HopSubmitOutcome::SubmitFailed(message, class)
            }
        }
    } else {
        // 非 resumable hop：登记 active set（先于 spawn，堵住 poll 误判 interrupted 的窗口）
        // 后台生成；spawned 任务失败时自行走 fail_or_advance_by_job_id 续链。
        {
            let mut active_set = active_non_resumable_job_ids().write().await;
            active_set.insert(job_id.to_string());
        }
        let app_handle = app.clone();
        let spawned_job_id = job_id.to_string();
        let spawned_provider = provider.clone();
        let spawned_model = hop.model.clone();
        tauri::async_runtime::spawn(async move {
            let result = spawned_provider.generate(request).await;
            let mut keep_active = false;
            match result {
                Ok(image_source) => {
                    let stored =
                        media_store::spool_result(&app_handle, spawned_job_id.as_str(), &image_source);
                    // 公司 OSS 归档（批次11）：标 succeeded 之前，失败软跳过绝不阻断。
                    let _ = archive_result_to_oss(
                        &app_handle,
                        spawned_job_id.as_str(),
                        &stored,
                        &spawned_model,
                    )
                    .await;
                    let update_result = update_generation_job(
                        &app_handle,
                        spawned_job_id.as_str(),
                        "succeeded",
                        Some(stored.as_str()),
                        None,
                    );
                    if let Err(error) = update_result {
                        info!("Failed to update non-resumable generation job: {}", error);
                    }
                    // 成功终态：剥掉 chain_meta 里的原始请求快照（防参考图 dataURL 滞留 DB）。
                    if let Err(error) =
                        strip_chain_meta_request_on_success(&app_handle, spawned_job_id.as_str())
                    {
                        info!(
                            "Failed to strip chain meta request for {}: {}",
                            spawned_job_id, error
                        );
                    }
                    if let Err(error) =
                        finalize_job(&app_handle, spawned_job_id.as_str(), "succeeded", None)
                    {
                        info!(
                            "Failed to write generation history for {}: {}",
                            spawned_job_id, error
                        );
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    let class = classify_error_message(&message);
                    let outcome =
                        fail_or_advance_by_job_id(&app_handle, spawned_job_id.as_str(), &message, class)
                            .await;
                    match outcome {
                        // 推进成功 = active 标记已由新 hop 接管，本任务不得移除
                        Ok(outcome) if outcome.status != "failed" => keep_active = true,
                        Ok(_) => {}
                        Err(db_error) => {
                            info!("Failed to advance chain for job {}: {}", spawned_job_id, db_error);
                        }
                    }
                }
            }
            if !keep_active {
                let mut active_set = active_non_resumable_job_ids().write().await;
                active_set.remove(spawned_job_id.as_str());
            }
        });
        HopSubmitOutcome::Submitted
    }
}

/// 失败拦截 + 链推进主循环（终态失败收敛点，接批次1 fail_job 接缝）。
///
/// - 非链任务（chain_meta 为空）→ 原 fail_job 行为，一字不差。
/// - 链任务有剩余 hop → CAS 推进（防重入）+ 用原始请求重提交（模型名换 hop 模型），
///   job 保持 running、job_id 不变（前端轮询无感知）。
/// - 链任务全尽墨 → 真终态，error 为人话轨迹汇总。
async fn fail_or_advance(
    app: &AppHandle,
    record: &GenerationJobRecord,
    message: &str,
    class: ErrorClass,
) -> Result<GenerationJobStatusDto, String> {
    let mut current_record: GenerationJobRecord = record.clone();
    let mut message = message.to_string();
    let mut class = class;

    loop {
        let Some(mut meta) = parse_chain_meta(current_record.chain_meta_json.as_deref()) else {
            // 非链任务：单点直连，维持批次1行为（回归红线）。
            return fail_job(app, current_record.job_id.as_str(), &message, class);
        };

        // 记录本次失败尝试（provider/model 取自 job 行 = 当前 hop 实际使用值）。
        let attempted_model = current_record
            .model
            .clone()
            .or_else(|| meta.hops.get(meta.current).map(|hop| hop.model.clone()))
            .unwrap_or_default();
        meta.attempts.push(ChainAttempt {
            provider_id: current_record.provider_id.clone(),
            model: attempted_model,
            error_class: class.as_str().to_string(),
            error: chain::truncate_chars(&message, 200),
            // extra hop（NEWAPI 接口）携带端点显示名，轨迹汇总直接展示用户起的名字。
            display_name: meta.hops.get(meta.current).and_then(|hop| hop.display_name.clone()),
        });

        let Some(next_index) = meta.current.checked_add(1).filter(|&next| next < meta.hops.len())
        else {
            // 全链尽墨：真终态 + 人话轨迹 + history 台账。
            let summary = chain::summarize_attempts(&meta.attempts, &message);
            write_terminal_chain_failure(
                app,
                current_record.job_id.as_str(),
                &meta,
                &summary,
                class.as_str(),
            )?;
            return Ok(GenerationJobStatusDto {
                job_id: current_record.job_id.clone(),
                status: "failed".to_string(),
                result: None,
                error: Some(summary),
                error_class: Some(class.as_str().to_string()),
                provider_id: Some(current_record.provider_id.clone()),
                model: meta.attempts.last().map(|attempt| attempt.model.clone()),
                attempts: Some(meta.attempts),
                oss_url: None,
            });
        };

        // CAS 推进到下一 hop（输家 = 有人已推进/已终态，按最新行状态返回）。
        let hop = meta.hops[next_index].clone();
        meta.current = next_index;
        meta.touch_hop_clock(); // 新 hop 享受完整的总时限，不背上 hop 的耗时
        let Some(new_chain_json) = chain_meta_to_json(&meta) else {
            return fail_job(app, current_record.job_id.as_str(), &message, class);
        };
        let registry = get_registry();
        let resumable = registry
            .resolve_provider_for_model(&hop.model)
            .map(|provider| provider.supports_task_resume())
            .unwrap_or(false);
        let cas_won = cas_advance_hop(
            app,
            current_record.job_id.as_str(),
            current_record.chain_meta_json.as_deref(),
            new_chain_json.as_str(),
            &hop,
            resumable,
        )?;
        if !cas_won {
            let fresh = get_generation_job(app, current_record.job_id.as_str())?;
            let Some(fresh) = fresh else {
                return Ok(GenerationJobStatusDto {
                    job_id: current_record.job_id.clone(),
                    status: "not_found".to_string(),
                    result: None,
                    error: Some("job not found".to_string()),
                    error_class: None,
                    provider_id: None,
                    model: None,
                    attempts: None,
                    oss_url: None,
                });
            };
            return Ok(dto_from_record(app, &fresh));
        }

        // 提交新 hop；同步失败则继续推进（循环上限 = hops.len()，必然收敛）。
        match submit_hop(app, current_record.job_id.as_str(), &meta, &hop).await {
            HopSubmitOutcome::Succeeded(image_source) => {
                // 行已是 succeeded + 落盘标记：重载行走 dto_from_record，
                // 顺带携带实际命中渠道/模型/链轨迹（批次5 generationMeta）。
                if let Some(fresh) = get_generation_job(app, current_record.job_id.as_str())? {
                    return Ok(dto_from_record(app, &fresh));
                }
                return Ok(GenerationJobStatusDto {
                    job_id: current_record.job_id.clone(),
                    status: "succeeded".to_string(),
                    result: Some(image_source),
                    error: None,
                    error_class: None,
                    provider_id: Some(hop.provider_id.clone()),
                    model: Some(hop.model.clone()),
                    attempts: None,
                    oss_url: None,
                });
            }
            HopSubmitOutcome::Submitted => {
                let switch_note = format!(
                    "{}·{} 失败（{}），已自动切换 {}·{} 重试",
                    chain::provider_display_name(&current_record.provider_id),
                    current_record.model.as_deref().unwrap_or(""),
                    chain::error_class_label(class.as_str()),
                    chain::provider_display_name(&hop.provider_id),
                    chain::short_hop_model(&hop.model),
                );
                return Ok(GenerationJobStatusDto {
                    job_id: current_record.job_id.clone(),
                    status: "running".to_string(),
                    result: None,
                    error: Some(switch_note),
                    error_class: None,
                    provider_id: Some(hop.provider_id.clone()),
                    model: Some(hop.model.clone()),
                    attempts: Some(meta.attempts),
                    oss_url: None,
                });
            }
            HopSubmitOutcome::SubmitFailed(fail_message, fail_class) => {
                // 重载行（CAS 已把 chain_meta/provider/model 写成新 hop 状态）作为下一轮基线。
                let Some(fresh) = get_generation_job(app, current_record.job_id.as_str())? else {
                    return fail_job(app, current_record.job_id.as_str(), &fail_message, fail_class);
                };
                current_record = fresh;
                message = fail_message;
                class = fail_class;
            }
        }
    }
}

/// spawned 非 resumable 任务失败入口：按 job_id 重载行后走 fail_or_advance。
/// 行已终态（如被他路写成 succeeded）则原样返回，不再动作。
async fn fail_or_advance_by_job_id(
    app: &AppHandle,
    job_id: &str,
    message: &str,
    class: ErrorClass,
) -> Result<GenerationJobStatusDto, String> {
    let Some(record) = get_generation_job(app, job_id)? else {
        return Ok(GenerationJobStatusDto {
            job_id: job_id.to_string(),
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
            error_class: None,
            provider_id: None,
            model: None,
            attempts: None,
            oss_url: None,
        });
    };
    if record.status != "running" {
        return Ok(dto_from_record(app, &record));
    }
    fail_or_advance(app, &record, message, class).await
}

fn get_generation_job(app: &AppHandle, job_id: &str) -> Result<Option<GenerationJobRecord>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id,
              provider_id,
              status,
              resumable,
              external_task_id,
            external_task_meta_json,
            result,
            error,
            created_at,
            poll_error_streak,
            first_poll_error_at,
            chain_meta_json,
            model,
            request_json,
            oss_url
            FROM ai_generation_jobs
            WHERE job_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation job query: {}", e))?;

    let result = stmt.query_row(params![job_id], |row| {
        Ok(GenerationJobRecord {
            job_id: row.get(0)?,
            provider_id: row.get(1)?,
            status: row.get(2)?,
            resumable: row.get::<_, i64>(3)? != 0,
            external_task_id: row.get(4)?,
            external_task_meta_json: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
            created_at: row.get(8)?,
            poll_error_streak: row.get(9)?,
            first_poll_error_at: row.get(10)?,
            chain_meta_json: row.get(11)?,
            model: row.get(12)?,
            request_json: row.get(13)?,
            oss_url: row.get(14)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load generation job: {}", error)),
    }
}

fn dto_from_record(app: &AppHandle, record: &GenerationJobRecord) -> GenerationJobStatusDto {
    let parsed_chain_meta = parse_chain_meta(record.chain_meta_json.as_deref());
    let mut dto = GenerationJobStatusDto {
        job_id: record.job_id.clone(),
        status: record.status.clone(),
        result: record.result.clone(),
        error: record.error.clone(),
        // 从错误文本派生类别：终态 failed 反复轮询也能稳定拿到 error_class；
        // running/成功记录 error 为空 → None。
        error_class: record
            .error
            .as_deref()
            .map(classify_error_message)
            .map(|class| class.as_str().to_string()),
        // 批次5 generationMeta 数据源：渠道/模型取 job 行（链任务随 hop 更新，
        // 成功后即实际命中渠道），轨迹取 chain_meta。
        provider_id: Some(record.provider_id.clone()),
        model: record.model.clone(),
        attempts: parsed_chain_meta
            .as_ref()
            .filter(|meta| !meta.attempts.is_empty())
            .map(|meta| meta.attempts.clone()),
        oss_url: record.oss_url.clone(),
    };

    // 落盘标记还原：DB 里存的是 `file:media/...`，前端拿到的必须是完整
    // data URL（契约零改动）。文件丢失（如被 7 天清理）→ 降级为 failed
    // 错误提示，绝不返回"成功但没有图"。
    if let Some(marker) = record
        .result
        .as_deref()
        .filter(|raw| raw.starts_with(media_store::SPOOL_MARKER_PREFIX))
    {
        match media_store::load_spooled(app, marker) {
            Some(restored) => dto.result = Some(restored),
            None => {
                let message =
                    "生成结果文件已过期清理，请重新生成".to_string();
                let _ = update_generation_job(
                    app,
                    record.job_id.as_str(),
                    "failed",
                    None,
                    Some(message.as_str()),
                );
                dto.status = "failed".to_string();
                dto.result = None;
                dto.error = Some(message);
                dto.error_class = Some(ErrorClass::Unknown.as_str().to_string());
            }
        }
    }

    // 软降权说明（模块 C）：running 且行 error 为空时，把 ChainMeta.note
    // 走 error 通道透出——前端批次5 的 running 黄字通道直接显示，不改 DTO 形状。
    if dto.error.is_none() && record.status == "running" {
        if let Some(note) = parsed_chain_meta.as_ref().and_then(|meta| meta.note.clone()) {
            dto.error = Some(note);
        }
    }

    dto
}

fn normalize_openai_base_url(base_url: Option<String>, fallback: &str) -> String {
    let raw = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .trim_end_matches('/')
        .to_string();

    if raw.ends_with("/v1") {
        raw
    } else {
        format!("{}/v1", raw)
    }
}

fn normalize_ollama_base_url(base_url: Option<String>) -> String {
    base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string()
}

fn collect_remote_model_ids(value: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();

    fn push_model(value: Option<&str>, seen: &mut HashSet<String>, models: &mut Vec<String>) {
        let Some(model) = value.map(str::trim).filter(|model| !model.is_empty()) else {
            return;
        };
        let model = model
            .strip_prefix("models/")
            .unwrap_or(model)
            .to_string();
        if seen.insert(model.clone()) {
            models.push(model);
        }
    }

    if let Some(data) = value.get("data").and_then(Value::as_array) {
        for item in data {
            push_model(item.get("id").and_then(Value::as_str), &mut seen, &mut models);
        }
    }

    if let Some(data) = value.get("models").and_then(Value::as_array) {
        for item in data {
            push_model(
                item.get("id")
                    .or_else(|| item.get("name"))
                    .or_else(|| item.get("model"))
                    .and_then(Value::as_str),
                &mut seen,
                &mut models,
            );
        }
    }

    models.sort();
    models
}

async fn fetch_openai_compatible_models(
    provider: &str,
    api_key: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let fallback_base_url = match provider {
        "666api" => "https://www.666api.ai",
        "juyouapi" => "http://154.36.153.146:8317",
        "agnes" => "https://apihub.agnes-ai.com",
        // aifast：NEWAPI 兼容中转站，base 固定（批次8）
        "aifast" => "https://picture.aifast.site",
        _ => return Err(format!("Unsupported provider: {}", provider)),
    };
    let endpoint = format!("{}/models", normalize_openai_base_url(base_url, fallback_base_url));
    let mut request = crate::ai::http::http_client().get(&endpoint);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Failed to fetch models from {}: {}", provider, error))?;
    let status = response.status();
    let raw_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let capped = raw_text.chars().take(1200).collect::<String>();
        return Err(format!(
            "{} model list request failed: HTTP {} {}",
            provider, status, capped
        ));
    }

    let value = serde_json::from_str::<Value>(&raw_text)
        .map_err(|error| format!("Failed to parse {} model list: {}", provider, error))?;
    let models = collect_remote_model_ids(&value);
    if models.is_empty() {
        return Err(format!("{} returned an empty model list", provider));
    }
    Ok(models)
}

async fn fetch_ollama_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/api/tags", normalize_ollama_base_url(base_url));
    let response = crate::ai::http::http_client()
        .get(&endpoint)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Ollama models: {}", error))?;
    let status = response.status();
    let raw_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let capped = raw_text.chars().take(1200).collect::<String>();
        return Err(format!("Ollama model list request failed: HTTP {} {}", status, capped));
    }

    let value = serde_json::from_str::<Value>(&raw_text)
        .map_err(|error| format!("Failed to parse Ollama model list: {}", error))?;
    let models = collect_remote_model_ids(&value);
    if models.is_empty() {
        return Err("Ollama returned an empty model list".to_string());
    }
    Ok(models)
}

// ============================== 渠道探活（模块 C · doctor） ==============================
//
// 零生成成本：只拉模型列表（GET /models），绝不触 provider.generate/submit_task。
// 三级结果：ok（列表拉到、key 有效，记延迟）/ reachable（base 通但 key 无效或
// 列表接口 401/403/404——grsai 网关无 /v1/models，404 特判为 reachable）/ down
// （超时/5xx/DNS/连接失败）。未配 key：unconfigured，跳过网络。
// 探活请求 10s 自身超时（tokio time 包裹），不吃全局 300s 客户端时长。

/// 探活请求快照：localStorage 是 key 唯一真源（与 fallback.available_providers 同理），
/// 前端随调用注入；Rust 不持久化密钥、trait 不暴露 key 查询（契约红线）。
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelProbeRequest {
    pub provider_id: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelProbeDto {
    pub provider_id: String,
    /// ok | reachable | down | unconfigured
    pub status: String,
    pub latency_ms: Option<u64>,
    pub detail: Option<String>,
    /// 该渠道在三条静态链中的成员模型被探活列表命中的个数（ok 时才有意义）。
    pub chain_models_ok: Option<u8>,
    pub checked_at: i64,
}

/// 探活自身超时（秒）：总耗时 ≈ 最慢渠道，10s 封顶。
const PROBE_TIMEOUT_SECS: u64 = 10;
/// 并发上限：8 个内置渠道分两批。
const PROBE_CONCURRENCY: usize = 4;

/// 内置渠道的探活 base（前端可传 base_url 覆盖，如巨游自定义域名）。
/// ppio/fal 为隐藏渠道通常 unconfigured；端点形态不匹配只会降为 reachable，不会误报 down。
/// newapi_* / aifast（批次8）：不再返回空串——优先用请求传入的 base_url
/// （aifast 也有固定兜底），走 fetch_openai_compatible_models 的 /v1/models 形态。
fn probe_base_url(provider_id: &str, override_base: Option<&str>) -> String {
    let default = match provider_id {
        "grsai" => "https://grsai.dakka.com.cn",
        "kie" => "https://api.kie.ai",
        "ppio" => "https://api.ppinfra.com",
        "fal" => "https://queue.fal.run",
        "666api" => "https://www.666api.ai",
        "juyouapi" => "http://154.36.153.146:8317",
        "agnes" => "https://apihub.agnes-ai.com",
        "aifast" => "https://picture.aifast.site",
        _ => "",
    };
    override_base
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .trim_end_matches('/')
        .to_string()
}

/// grsai/kie/ppio/fal 无现成 models 拉取函数：统一 GET {base}/v1/models，
/// 失败按 "HTTP {status}" / connect 错误文本约定抛出，由 classify_probe_failure 分级。
async fn probe_generic_models(
    provider_id: &str,
    api_key: &str,
    base_url: String,
) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/v1/models", base_url);
    let mut request = crate::ai::http::http_client()
        .get(&endpoint)
        .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("{} probe connect failed: {}", provider_id, error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{} probe failed: HTTP {}", provider_id, status));
    }
    let raw_text = response.text().await.unwrap_or_default();
    let value = serde_json::from_str::<Value>(&raw_text).unwrap_or(Value::Null);
    Ok(collect_remote_model_ids(&value))
}

/// 探活失败分级：down = 超时/5xx/DNS/连接失败；reachable = key 无效或列表接口
/// 401/403/404（base 可达）。其余 4xx 视为 reachable（服务在，拒绝方式因渠道而异）。
fn classify_probe_failure(message: &str) -> &'static str {
    let lowered = message.to_lowercase();
    if lowered.contains("timed out") || lowered.contains("timeout") {
        return "down";
    }
    if lowered.contains("http 401") || lowered.contains("http 403") || lowered.contains("http 404") {
        return "reachable";
    }
    if lowered.contains("http 5") || lowered.contains("connect") || lowered.contains("dns") {
        return "down";
    }
    "reachable"
}

/// 该渠道在三条静态链中的成员模型（去 provider 前缀后的裸模型名，去重）。
fn chain_member_models_for_provider(provider_id: &str) -> Vec<&'static str> {
    let chains = [
        chain::CHAIN_T2I_STANDARD,
        chain::CHAIN_T2I_PRO,
        chain::CHAIN_I2I_STANDARD,
    ];
    let mut members: Vec<&'static str> = Vec::new();
    for chain_specs in chains {
        for spec in chain_specs.iter() {
            if spec.provider_id != provider_id {
                continue;
            }
            if let Some((_, model)) = spec.model.split_once('/') {
                if !members.contains(&model) {
                    members.push(model);
                }
            }
        }
    }
    members
}

/// 链模型交集计数（任务书：如「降级链 4 档中 3 档可用」的数据源）。
fn count_chain_models_ok(provider_id: &str, models: &[String]) -> Option<u8> {
    let members = chain_member_models_for_provider(provider_id);
    if members.is_empty() || models.is_empty() {
        return None;
    }
    Some(
        members
            .iter()
            .filter(|member| models.iter().any(|have| have.eq_ignore_ascii_case(member)))
            .count() as u8,
    )
}

/// grsai 网关无 /v1/models 的可达明细标记（批次9）：404=网关形态如此（正常），
/// 密钥有效性留到生成时验证；前端按此子串显示绿色专属文案，与真 401/403（key 无效，黄）区分。
pub const PROBE_NO_MODEL_LIST_DETAIL: &str =
    "gateway has no model-list endpoint; key will be verified on generation";

async fn probe_one_channel(request: ChannelProbeRequest) -> ChannelProbeDto {
    let checked_at = now_ms();
    let started = std::time::Instant::now();
    let provider_id = request.provider_id.clone();
    let api_key = request.api_key.trim().to_string();
    let is_ollama = provider_id == "ollama";

    // 没配 key：unconfigured，跳过网络（ollama 本地部署免 key）。
    if api_key.is_empty() && !is_ollama {
        return ChannelProbeDto {
            provider_id,
            status: "unconfigured".to_string(),
            latency_ms: None,
            detail: None,
            chain_models_ok: None,
            checked_at,
        };
    }

    // 三个分支的 future 具体类型不同 → 装箱统一（探活低频，一次堆分配可忽略）。
    let probe_future: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<String>, String>> + Send>,
    > = match provider_id.as_str() {
        "ollama" => Box::pin(fetch_ollama_models(request.base_url.clone())),
        // 批次8：aifast 与 newapi_* 都是 NEWAPI / OpenAI 兼容形态，
        // 优先用请求传入的 base_url（此前 newapi_*/aifast 落入 generic 分支拿到空 base，探活必然失败）。
        "666api" | "juyouapi" | "agnes" | "aifast" => Box::pin(fetch_openai_compatible_models(
            provider_id.as_str(),
            api_key.clone(),
            request.base_url.clone(),
        )),
        id if id.starts_with("newapi_") => Box::pin(fetch_openai_compatible_models_for_url(
            id,
            api_key.clone(),
            request.base_url.clone(),
        )),
        other => Box::pin(probe_generic_models(
            other,
            api_key.as_str(),
            probe_base_url(other, request.base_url.as_deref()),
        )),
    };
    // 10s 自身超时：探活不吃全局 300s 客户端时长，总耗时封顶。
    let outcome = tokio::time::timeout(Duration::from_secs(PROBE_TIMEOUT_SECS), probe_future).await;
    let latency_ms = Some(started.elapsed().as_millis() as u64);

    match outcome {
        Err(_) => ChannelProbeDto {
            provider_id,
            status: "down".to_string(),
            latency_ms,
            detail: Some(format!("probe timed out after {}s", PROBE_TIMEOUT_SECS)),
            chain_models_ok: None,
            checked_at,
        },
        Ok(Ok(models)) => {
            let chain_models_ok = count_chain_models_ok(provider_id.as_str(), &models);
            ChannelProbeDto {
                provider_id,
                status: "ok".to_string(),
                latency_ms,
                detail: Some(format!("{} models", models.len())),
                chain_models_ok,
                checked_at,
            }
        }
        Ok(Err(message)) => {
            let status = classify_probe_failure(&message);
            // grsai 特判（批次9 文案修正）：网关本来就没有 /v1/models，404 是形态而非故障——
            // detail 换成「正常」口径（对齐 image-studio 技能 doctor），用户不再被
            // 「密钥无效」文案吓到；真 401/403（key 无效）保持原文走黄色路径。
            let is_grsai_no_model_list =
                provider_id == "grsai" && status == "reachable" && message.contains("HTTP 404");
            let detail = if is_grsai_no_model_list {
                PROBE_NO_MODEL_LIST_DETAIL.to_string()
            } else {
                chain::truncate_chars(&message, 160)
            };
            ChannelProbeDto {
                provider_id,
                status: status.to_string(),
                latency_ms,
                detail: Some(detail),
                chain_models_ok: None,
                checked_at,
            }
        }
    }
}

fn upsert_channel_health(app: &AppHandle, dto: &ChannelProbeDto) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO ai_channel_health
          (provider_id, status, latency_ms, detail, chain_models_ok, checked_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            dto.provider_id,
            dto.status,
            dto.latency_ms.map(|value| value as i64),
            dto.detail,
            dto.chain_models_ok.map(|value| value as i64),
            dto.checked_at
        ],
    )
    .map_err(|e| format!("Failed to upsert channel health: {}", e))?;
    Ok(())
}

fn list_down_channel_ids(app: &AppHandle) -> HashSet<String> {
    let Ok(conn) = open_db(app) else {
        return HashSet::new();
    };
    let mut stmt = match conn.prepare("SELECT provider_id FROM ai_channel_health WHERE status = 'down'") {
        Ok(stmt) => stmt,
        Err(_) => return HashSet::new(),
    };
    let rows = stmt.query_map([], |row| row.get::<_, String>(0));
    let mut down = HashSet::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            down.insert(row);
        }
    }
    down
}

/// 渠道探活（模块 C doctor）：零生成成本，只拉模型列表。
/// 任务书原签名无参；因 trait 不暴露 key 查询（契约红线），改为前端传快照，
/// 与 fallback.available_providers 同一「前端快照」哲学。并发限 4（分批 spawn）。
#[tauri::command]
pub async fn probe_channels(
    app: AppHandle,
    providers: Vec<ChannelProbeRequest>,
) -> Result<Vec<ChannelProbeDto>, String> {
    let mut results: Vec<ChannelProbeDto> = Vec::new();
    for chunk in providers.chunks(PROBE_CONCURRENCY) {
        let mut handles = Vec::new();
        for request in chunk {
            let request = request.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                probe_one_channel(request).await
            }));
        }
        for handle in handles {
            let dto = handle
                .await
                .map_err(|e| format!("Probe task join failed: {}", e))?;
            if let Err(error) = upsert_channel_health(&app, &dto) {
                info!("Failed to persist channel health: {}", error);
            }
            results.push(dto);
        }
    }
    Ok(results)
}

/// 最近一次渠道健康结果（设置页面板 / 选择器圆点徽标数据源；不触发探测）。
#[tauri::command]
pub async fn list_channel_health(app: AppHandle) -> Result<Vec<ChannelProbeDto>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT provider_id, status, latency_ms, detail, chain_models_ok, checked_at
            FROM ai_channel_health
            ORDER BY provider_id
            "#,
        )
        .map_err(|e| format!("Failed to prepare channel health query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ChannelProbeDto {
                provider_id: row.get(0)?,
                status: row.get(1)?,
                latency_ms: row.get::<_, Option<i64>>(2)?.map(|value| value as u64),
                detail: row.get(3)?,
                chain_models_ok: row.get::<_, Option<i64>>(4)?.map(|value| value as u8),
                checked_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("Failed to query channel health: {}", e))?;

    let mut health = Vec::new();
    for row in rows {
        health.push(row.map_err(|e| format!("Failed to read channel health row: {}", e))?);
    }
    Ok(health)
}

#[tauri::command]
pub async fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    info!("Setting API key for provider: {}", provider);

    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    resolved_provider
        .set_api_key(api_key)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_provider_models(
    provider: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    match provider.as_str() {
        "666api" | "juyouapi" | "agnes" | "aifast" => {
            fetch_openai_compatible_models(provider.as_str(), api_key, base_url).await
        }
        "ollama" => fetch_ollama_models(base_url).await,
        // Custom runtime NEWAPI endpoints use the same OpenAI-compatible /v1/models scheme.
        id if id.starts_with("newapi_") => {
            fetch_openai_compatible_models_for_url(id, api_key, base_url).await
        }
        _ => Err(format!("Unsupported provider: {}", provider)),
    }
}

#[tauri::command]
pub async fn register_custom_endpoint(
    id: String,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    info!("Registering custom endpoint: {}", id);
    let registry = get_registry();
    let provider = Arc::new(Api666Provider::new_with_config(&id, &base_url));
    registry.register_custom_provider(id.clone(), provider);

    // Inject API key + base url into the freshly registered provider instance.
    if let Some(resolved) = registry.get_provider(&id) {
        if !api_key.trim().is_empty() {
            resolved.set_api_key(api_key).await.map_err(|e| e.to_string())?;
        }
        if let Some(api666) = resolved.as_ref().as_any().downcast_ref::<Api666Provider>() {
            api666.set_base_url(base_url).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_custom_endpoint(id: String) -> Result<(), String> {
    info!("Removing custom endpoint: {}", id);
    let registry = get_registry();
    registry.remove_custom_provider(&id);
    Ok(())
}

/// Fetch models from an arbitrary OpenAI-compatible base URL (used by custom endpoints).
/// Differs from `fetch_openai_compatible_models` only in that it requires an explicit
/// base URL rather than a hardcoded fallback per provider name.
async fn fetch_openai_compatible_models_for_url(
    provider: &str,
    api_key: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let raw = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Base URL is required for custom endpoint {}", provider))?;
    let endpoint = format!("{}/models", normalize_openai_base_url(Some(raw.to_string()), raw));
    let mut request = crate::ai::http::http_client().get(&endpoint);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Failed to fetch models from {}: {}", provider, error))?;
    let status = response.status();
    let raw_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let capped = raw_text.chars().take(1200).collect::<String>();
        return Err(format!(
            "{} model list request failed: HTTP {} {}",
            provider, status, capped
        ));
    }

    let value = serde_json::from_str::<Value>(&raw_text)
        .map_err(|error| format!("Failed to parse {} model list: {}", provider, error))?;
    let models = collect_remote_model_ids(&value);
    if models.is_empty() {
        return Err(format!("{} returned an empty model list", provider));
    }
    Ok(models)
}

#[tauri::command]
pub async fn reverse_prompt(provider: String, request: ReversePromptRequestDto) -> Result<String, String> {
    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    resolved_provider
        .reverse_prompt(request.image, request.language, request.format, request.model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn craft_image_prompt(
    provider: String,
    api_key: String,
    user_input: String,
    category: Option<String>,
    model: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    if !api_key.is_empty() {
        resolved_provider
            .set_api_key(api_key)
            .await
            .map_err(|error| error.to_string())?;
    }

    resolved_provider
        .craft_image_prompt(&user_input, category.as_deref(), model.as_deref(), language.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_juyouapi_base_url(base_url: String) -> Result<(), String> {
    let registry = get_registry();
    let resolved_provider = registry
        .get_provider("juyouapi")
        .ok_or_else(|| "Unknown provider: juyouapi".to_string())?;

    let juyou_provider = resolved_provider
        .as_ref()
        .as_any()
        .downcast_ref::<Api666Provider>()
        .ok_or_else(|| "Provider is not ApiJuyouProvider".to_string())?;

    juyou_provider
        .set_base_url(base_url)
        .await;

    Ok(())
}

#[tauri::command]
pub async fn set_ollama_base_url(base_url: String) -> Result<(), String> {
    let registry = get_registry();
    let resolved_provider = registry
        .get_provider("ollama")
        .ok_or_else(|| "Unknown provider: ollama".to_string())?;

    let ollama_provider = resolved_provider
        .as_ref()
        .as_any()
        .downcast_ref::<OllamaProvider>()
        .ok_or_else(|| "Provider is not OllamaProvider".to_string())?;

    ollama_provider.set_base_url(base_url).await;

    Ok(())
}

#[tauri::command]
pub async fn set_ollama_model(model: String) -> Result<(), String> {
    let registry = get_registry();
    let resolved_provider = registry
        .get_provider("ollama")
        .ok_or_else(|| "Unknown provider: ollama".to_string())?;

    let ollama_provider = resolved_provider
        .as_ref()
        .as_any()
        .downcast_ref::<OllamaProvider>()
        .ok_or_else(|| "Provider is not OllamaProvider".to_string())?;

    ollama_provider.set_model_name(model).await;

    Ok(())
}

#[tauri::command]
pub async fn submit_generate_image_job(
    app: AppHandle,
    request: GenerateRequestDto,
) -> Result<String, String> {
    info!("Submitting generation job with model: {}", request.model);

    let registry = get_registry();

    let mut req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
    };

    // 台账快照：用户视角的原始请求（prompt/model/size/aspect_ratio，无参考图）。
    // 链任务随 hop 切换 chain_meta，但 history 的 prompt/size 以用户原始输入为准。
    let request_json = job_request_snapshot_json(&req);

    // 智能出图（自动降级链）：有 fallback 才建链；chain_meta 保留原始请求（含用户原模型 id），
    // 实际提交从 hop[current] 起步。空链由 build_chain 退化为单点，永不拒绝生成。
    // 无 fallback = 单点直连，chain_meta 为空，后续链逻辑全部短路（回归红线）。
    let chain_meta_json: Option<String> = request
        .fallback
        .as_ref()
        .and_then(|fallback| {
            let mut plan = chain::build_chain(
                &req,
                &fallback.quality,
                &fallback.available_providers,
                registry,
                &fallback.extra_hops,
            );
            // 软降权（模块 C）：最近探活 status=down 的渠道**挪链尾**——仅重排，
            // 绝不剔除、不拉黑（探活有盲区）。全 down 或无记录 → 原序。
            // 降权说明写进 ChainMeta.note，running 期经前端批次5 黄字通道透出。
            let down_ids = list_down_channel_ids(&app);
            // down_names 以降权前的原始链成员求交集——降权后的 plan.hops 已被打乱，
            // 从重排结果反推 down 名单会依赖"down 全在尾部"这一隐式不变量。
            let original_provider_ids: Vec<String> =
                plan.hops.iter().map(|hop| hop.provider_id.clone()).collect();
            // NEWAPI 接口（extra hop）显示用户起的端点名；内置渠道走静态展示名表。
            let display_name_of = |pid: &str| -> String {
                fallback
                    .extra_hops
                    .iter()
                    .find(|hop| hop.provider_id == pid)
                    .map(|hop| hop.display_name.clone())
                    .unwrap_or_else(|| chain::provider_display_name(pid).to_string())
            };
            let (hops, demoted) = chain::demote_down_hops(plan.hops, &down_ids);
            plan.hops = hops;
            let mut meta = ChainMeta::from_plan(&plan, &fallback.quality, req.clone());
            if demoted {
                if let Some(first_hop) = plan.hops.first() {
                    let mut seen_down = HashSet::new();
                    let down_names = original_provider_ids
                        .iter()
                        .filter(|pid| down_ids.contains(pid.as_str()))
                        .map(|pid| display_name_of(pid))
                        .filter(|name| seen_down.insert(name.clone()))
                        .collect::<Vec<_>>()
                        .join("、");
                    meta.note = Some(format!(
                        "{} 当前不可用，本次自动从 {} 开始",
                        down_names,
                        display_name_of(&first_hop.provider_id)
                    ));
                }
            }
            req.model = plan.current_hop().model.clone();
            // 批次13（R2）：首 hop 直接提交点同样合并 hop 级 overlay（submit_task 之前）。
            apply_overlay(&mut req, &plan.current_hop().extra_params_overlay);
            chain_meta_to_json(&meta)
        });

    let provider = registry
        .resolve_provider_for_model(&req.model)
        .or_else(|| registry.get_default_provider())
        .ok_or_else(|| "Provider not found".to_string())?;

    let job_id = Uuid::new_v4().to_string();
    let provider_id = provider.name().to_string();
    let effective_model = req.model.clone();

    if provider.supports_task_resume() {
        match provider.submit_task(req).await {
            Ok(ProviderTaskSubmission::Succeeded(image_source)) => {
                // 大图落盘标记化；DTO 直接返回原文，前端契约不变。
                let stored = media_store::spool_result(&app, job_id.as_str(), &image_source);
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "succeeded",
                    true,
                    None,
                    None,
                    Some(stored.as_str()),
                    None,
                    Some(effective_model.as_str()),
                    chain_meta_json.as_deref(),
                    request_json.as_deref(),
                )?;
                // 公司 OSS 归档（批次11）：job 行已建、finalize 之前，失败软跳过绝不阻断。
                let _ = archive_result_to_oss(&app, job_id.as_str(), &stored, &effective_model).await;
                if let Err(error) = finalize_job(&app, job_id.as_str(), "succeeded", None) {
                    info!("Failed to write generation history for {}: {}", job_id, error);
                }
            }
            Ok(ProviderTaskSubmission::Queued(handle)) => {
                let meta_json = handle
                    .metadata
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "running",
                    true,
                    Some(handle.task_id.as_str()),
                    meta_json.as_deref(),
                    None,
                    None,
                    Some(effective_model.as_str()),
                    chain_meta_json.as_deref(),
                    request_json.as_deref(),
                )?;
            }
            Err(error) => {
                // 链任务 hop0 提交即失败（如首选渠道秒挂）：先落 job 行再走失败推进，
                // 让 hop1 接管或全尽墨终态——不能把链掐死在 submit 门口。
                // 单点任务维持原行为：直接向前端返回错误。
                if chain_meta_json.is_some() {
                    insert_generation_job(
                        &app,
                        job_id.as_str(),
                        provider_id.as_str(),
                        "running",
                        true,
                        None,
                        None,
                        None,
                        None,
                        Some(effective_model.as_str()),
                        chain_meta_json.as_deref(),
                        request_json.as_deref(),
                    )?;
                    let message = error.to_string();
                    let class = classify_error_message(&message);
                    let _ =
                        fail_or_advance_by_job_id(&app, job_id.as_str(), &message, class).await;
                    return Ok(job_id);
                }
                return Err(error.to_string());
            }
        }
        return Ok(job_id);
    }

    insert_generation_job(
        &app,
        job_id.as_str(),
        provider_id.as_str(),
        "running",
        false,
        None,
        None,
        None,
        None,
        Some(effective_model.as_str()),
        chain_meta_json.as_deref(),
        request_json.as_deref(),
    )?;
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.insert(job_id.clone());
    }

    let app_handle = app.clone();
    let spawned_job_id = job_id.clone();
    let spawned_provider = provider.clone();
    let spawned_model = effective_model.clone();
    tauri::async_runtime::spawn(async move {
        let result = spawned_provider.generate(req).await;
        match result {
            Ok(image_source) => {
                let stored = media_store::spool_result(&app_handle, spawned_job_id.as_str(), &image_source);
                // 公司 OSS 归档（批次11）：标 succeeded 之前，失败软跳过绝不阻断。
                let _ = archive_result_to_oss(
                    &app_handle,
                    spawned_job_id.as_str(),
                    &stored,
                    &spawned_model,
                )
                .await;
                let update_result = update_generation_job(
                    &app_handle,
                    spawned_job_id.as_str(),
                    "succeeded",
                    Some(stored.as_str()),
                    None,
                );
                if let Err(error) = update_result {
                    info!("Failed to update non-resumable generation job: {}", error);
                }
                if let Err(error) =
                    finalize_job(&app_handle, spawned_job_id.as_str(), "succeeded", None)
                {
                    info!(
                        "Failed to write generation history for {}: {}",
                        spawned_job_id, error
                    );
                }
                let mut active_set = active_non_resumable_job_ids().write().await;
                active_set.remove(spawned_job_id.as_str());
            }
            Err(error) => {
                // 失败统一走 fail_or_advance：链任务自动降下一档（active 标记由新 hop 接管），
                // 单点任务维持批次1终态行为。
                let message = error.to_string();
                let class = classify_error_message(&message);
                let outcome =
                    fail_or_advance_by_job_id(&app_handle, spawned_job_id.as_str(), &message, class)
                        .await;
                let keep_active = matches!(&outcome, Ok(dto) if dto.status != "failed");
                if let Err(error) = outcome {
                    info!("Failed to finalize non-resumable generation job: {}", error);
                }
                if !keep_active {
                    let mut active_set = active_non_resumable_job_ids().write().await;
                    active_set.remove(spawned_job_id.as_str());
                }
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn submit_generate_video_job(
    app: AppHandle,
    request: GenerateRequestDto,
) -> Result<String, String> {
    submit_generate_image_job(app, request).await
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
            error_class: None,
            provider_id: None,
            model: None,
            attempts: None,
            oss_url: None,
        });
    };

    if record.status == "succeeded" || record.status == "failed" {
        return Ok(dto_from_record(&app, &record));
    }

    // 超时兜底：仍在 running 且超过总时限 → 失败（链任务自动降下一 hop）。
    // 链任务按 hop 起点计时（chain_meta.hop_started_at_ms）——每个 hop 各享完整时限，
    // 不会被上一 hop 耗掉的时间连锁烧穿；非链任务按 created_at。
    // 由前端 1.4s 轮询天然驱动本检查，无需后台定时器。
    let deadline_clock_start = parse_chain_meta(record.chain_meta_json.as_deref())
        .map(|meta| meta.deadline_clock_start(record.created_at))
        .unwrap_or(record.created_at);
    if now_ms().saturating_sub(deadline_clock_start) > JOB_MAX_RUNNING_MS {
        let message = format!(
            "生成超时（任务已运行超过 {} 分钟仍未完成）",
            JOB_MAX_RUNNING_MS / 60_000
        );
        return fail_or_advance(&app, &record, &message, ErrorClass::Timeout).await;
    }

    if !record.resumable {
        let is_active = {
            let active_set = active_non_resumable_job_ids().read().await;
            active_set.contains(record.job_id.as_str())
        };
        if is_active {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&app, &record));
        }

        // 进程丢失（app 重启）。链任务：推进下一 hop 用原始请求重提交（重启即免费降级）；
        // 单点任务：维持批次1行为（failed + 原文）。
        let interrupted_message = "job interrupted by app restart".to_string();
        return fail_or_advance(
            &app,
            &record,
            &interrupted_message,
            ErrorClass::Unknown,
        )
        .await;
    }

    let provider = get_registry()
        .get_provider(record.provider_id.as_str())
        .ok_or_else(|| format!("Provider not found for job: {}", record.provider_id))?;

    let Some(task_id) = record.external_task_id.clone() else {
        // 链任务 CAS 刚切档、submit_task 在途的瞬态窗口：external_task_id 尚未落库。
        // 若提交失败会由 fail_or_advance 自行推进，这里保持 running 即可；
        // 真正的悬死（如切档后进程崩溃）由 15 分钟总上限兜底降级。
        if record.chain_meta_json.is_some() {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&app, &record));
        }
        let message = "missing external task id".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(message.as_str()),
        )?;
        if let Err(error) = finalize_job(&app, record.job_id.as_str(), "failed", Some("unknown")) {
            info!("Failed to write generation history for {}: {}", record.job_id, error);
        }
        record.status = "failed".to_string();
        record.error = Some(message);
        return Ok(dto_from_record(&app, &record));
    };

    let task_meta = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    match provider
        .poll_task(ProviderTaskHandle {
            task_id,
            metadata: task_meta,
        })
        .await
    {
        Ok(ProviderTaskPollResult::Running) => {
            // 本次 poll 成功 → 重置连续错误计数
            let _ = touch_generation_job(&app, record.job_id.as_str());
            Ok(dto_from_record(&app, &record))
        }
        Ok(ProviderTaskPollResult::Succeeded(image_source)) => {
            let stored = media_store::spool_result(&app, record.job_id.as_str(), &image_source);
            // 公司 OSS 归档（批次11）：标 succeeded 之前，失败软跳过绝不阻断。
            // 模型取 job 行（= 实际命中渠道的模型；重启恢复路径同样成立）。
            let archive_model = record.model.clone().unwrap_or_default();
            let _ = archive_result_to_oss(
                &app,
                record.job_id.as_str(),
                &stored,
                archive_model.as_str(),
            )
            .await;
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(stored.as_str()),
                None,
            )?;
            // 成功终态：剥掉 chain_meta 里的原始请求快照（防参考图 dataURL 滞留 DB）。
            if let Err(error) = strip_chain_meta_request_on_success(&app, record.job_id.as_str()) {
                info!("Failed to strip chain meta request for {}: {}", record.job_id, error);
            }
            if let Err(error) =
                finalize_job(&app, record.job_id.as_str(), "succeeded", None)
            {
                info!("Failed to write generation history for {}: {}", record.job_id, error);
            }
            // 重载行走 dto_from_record：携带实际命中渠道/模型/链轨迹（generationMeta）。
            if let Some(fresh) = get_generation_job(&app, record.job_id.as_str())? {
                return Ok(dto_from_record(&app, &fresh));
            }
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(image_source),
                error: None,
                error_class: None,
                provider_id: None,
                model: None,
                attempts: None,
                oss_url: None,
            })
        }
        Ok(ProviderTaskPollResult::Failed(message)) => {
            let class = classify_error_message(&message);
            fail_or_advance(&app, &record, &message, class).await
        }
        Err(AIError::TaskFailed(message)) => {
            let class = classify_error_message(&message);
            fail_or_advance(&app, &record, &message, class).await
        }
        Err(error) => {
            // 网络级 poll 错误：连续达到阈值才判终态，避免渠道抖动误杀已扣费任务；
            // 未达阈值保持 running，但不再静默——计数落库，错误透出给前端展示。
            let message = error.to_string();
            let streak = record.poll_error_streak + 1;
            if streak >= POLL_ERROR_FAIL_THRESHOLD {
                let class = classify_error_message(&message);
                let final_message =
                    format!("渠道连续无响应（已重试 {} 次）: {}", streak, message);
                fail_or_advance(&app, &record, &final_message, class).await
            } else {
                let first_poll_error_at = record.first_poll_error_at.or_else(|| Some(now_ms()));
                let _ = record_poll_error(&app, record.job_id.as_str(), streak, first_poll_error_at);
                Ok(GenerationJobStatusDto {
                    job_id: record.job_id,
                    status: "running".to_string(),
                    result: None,
                    error: Some(message),
                    error_class: None,
                    provider_id: None,
                    model: None,
                    attempts: None,
                    oss_url: None,
                })
            }
        }
    }
}

#[tauri::command]
pub async fn get_generate_video_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    get_generate_image_job(app, job_id).await
}

#[tauri::command]
pub async fn generate_image(request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .ok_or_else(|| "Provider not found".to_string())?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
    };

    provider.generate(req).await.map_err(|e| e.to_string())
}

/// 生成历史台账查询：按 created_at 倒序最近 N 条（默认 100，上限 500）。
/// 批次5 设置页 meta UI 消费；本批仅暴露命令。
#[tauri::command]
pub async fn list_generation_history(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<GenerationHistoryDto>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id, provider_id, model, mode, quality, prompt,
              size, aspect_ratio, duration_ms, attempts_json, status, error_class, created_at, oss_url
            FROM ai_generation_history
            ORDER BY created_at DESC
            LIMIT ?1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation history query: {}", e))?;

    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(GenerationHistoryDto {
                job_id: row.get(0)?,
                provider_id: row.get(1)?,
                model: row.get(2)?,
                mode: row.get(3)?,
                quality: row.get(4)?,
                prompt: row.get(5)?,
                size: row.get(6)?,
                aspect_ratio: row.get(7)?,
                duration_ms: row.get(8)?,
                attempts_json: row.get(9)?,
                status: row.get(10)?,
                error_class: row.get(11)?,
                created_at: row.get(12)?,
                oss_url: row.get(13)?,
            })
        })
        .map_err(|e| format!("Failed to query generation history: {}", e))?;

    let mut history = Vec::new();
    for row in rows {
        history.push(row.map_err(|e| format!("Failed to read generation history row: {}", e))?);
    }
    Ok(history)
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, String> {
    Ok(get_registry().list_models())
}

// ──────────────────────────────────────────────────────────────────────
// 单测（批次13）：hop overlay 合并纯逻辑
// ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn bare_request() -> crate::ai::GenerateRequest {
        crate::ai::GenerateRequest {
            prompt: "a tiny cat".to_string(),
            model: "auto/gpt-transparent".to_string(),
            size: "1K".to_string(),
            aspect_ratio: "1:1".to_string(),
            reference_images: None,
            extra_params: None,
        }
    }

    fn transparent_overlay() -> Option<HashMap<String, Value>> {
        let mut overlay = HashMap::new();
        overlay.insert(
            "transparent_background".to_string(),
            Value::Bool(true),
        );
        Some(overlay)
    }

    #[test]
    fn apply_overlay_none_extra_params_becomes_some() {
        let mut request = bare_request();
        apply_overlay(&mut request, &transparent_overlay());
        let params = request.extra_params.expect("overlay merged");
        assert_eq!(
            params.get("transparent_background"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn apply_overlay_merges_into_existing_map_and_overrides_same_key() {
        let mut request = bare_request();
        let mut existing = HashMap::new();
        existing.insert("oss_project".to_string(), Value::String("demo".to_string()));
        // 同名键被 hop overlay 覆盖（false → true）
        existing.insert("transparent_background".to_string(), Value::Bool(false));
        request.extra_params = Some(existing);
        apply_overlay(&mut request, &transparent_overlay());
        let params = request.extra_params.expect("overlay merged");
        assert_eq!(
            params.get("oss_project"),
            Some(&Value::String("demo".to_string()))
        );
        assert_eq!(
            params.get("transparent_background"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn apply_overlay_none_overlay_leaves_request_untouched() {
        let mut request = bare_request();
        apply_overlay(&mut request, &None);
        assert!(request.extra_params.is_none());

        let mut existing = HashMap::new();
        existing.insert("quality".to_string(), Value::String("high".to_string()));
        request.extra_params = Some(existing);
        apply_overlay(&mut request, &None);
        let params = request.extra_params.expect("untouched");
        assert_eq!(params.len(), 1);
        assert_eq!(
            params.get("quality"),
            Some(&Value::String("high".to_string()))
        );
    }
}
