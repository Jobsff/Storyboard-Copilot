use std::path::PathBuf;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::{ZipArchive, ZipWriter};
use zip::write::SimpleFileOptions;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
    pub nodes_json: String,
    pub edges_json: String,
    pub viewport_json: String,
    pub history_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPackageRecord {
    pub name: String,
    pub node_count: i64,
    pub nodes_json: String,
    pub edges_json: String,
    pub viewport_json: String,
    pub history_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPackageV1 {
    pub format_version: u32,
    pub exported_at: i64,
    pub project: ProjectPackageRecord,
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

fn ensure_projects_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          node_count INTEGER NOT NULL DEFAULT 0,
          nodes_json TEXT NOT NULL,
          edges_json TEXT NOT NULL,
          viewport_json TEXT NOT NULL,
          history_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
        CREATE TABLE IF NOT EXISTS project_image_refs (
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY(project_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_image_refs_path ON project_image_refs(path);
        "#,
    )
    .map_err(|e| format!("Failed to initialize projects table: {}", e))?;

    let mut has_node_count = false;
    let mut stmt = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| format!("Failed to inspect projects schema: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect projects columns: {}", e))?;

    for name_result in rows {
        let column_name =
            name_result.map_err(|e| format!("Failed to read projects column name: {}", e))?;
        if column_name == "node_count" {
            has_node_count = true;
            break;
        }
    }

    if !has_node_count {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to add node_count column: {}", e))?;
    }

    Ok(())
}

fn parse_image_pool(history_json: &str) -> Vec<String> {
    let parsed: serde_json::Value = match serde_json::from_str(history_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    parsed
        .get("imagePool")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str().map(|item| item.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_image_ref(value: &str, image_pool: &[String]) -> Option<String> {
    const IMAGE_REF_PREFIX: &str = "__img_ref__:";

    if let Some(index_text) = value.strip_prefix(IMAGE_REF_PREFIX) {
        let index = index_text.parse::<usize>().ok()?;
        return image_pool.get(index).cloned();
    }

    if value.trim().is_empty() {
        return None;
    }

    Some(value.to_string())
}

fn collect_image_paths_from_nodes(
    nodes: &[serde_json::Value],
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    for node in nodes {
        let data = match node.get("data").and_then(|value| value.as_object()) {
            Some(value) => value,
            None => continue,
        };

        for key in ["imageUrl", "previewImageUrl"] {
            if let Some(raw_value) = data.get(key).and_then(|value| value.as_str()) {
                if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                    paths.insert(path);
                }
            }
        }

        if let Some(frames) = data.get("frames").and_then(|value| value.as_array()) {
            for frame in frames {
                let frame_obj = match frame.as_object() {
                    Some(value) => value,
                    None => continue,
                };
                for key in ["imageUrl", "previewImageUrl"] {
                    if let Some(raw_value) = frame_obj.get(key).and_then(|value| value.as_str()) {
                        if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                            paths.insert(path);
                        }
                    }
                }
            }
        }
    }
}

fn extract_project_image_paths(nodes_json: &str, history_json: &str) -> HashSet<String> {
    let image_pool = parse_image_pool(history_json);
    let mut paths = HashSet::new();

    if let Ok(parsed_nodes) = serde_json::from_str::<serde_json::Value>(nodes_json) {
        if let Some(nodes) = parsed_nodes.as_array() {
            collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
        }
    }

    if let Ok(parsed_history) = serde_json::from_str::<serde_json::Value>(history_json) {
        for timeline_key in ["past", "future"] {
            let Some(timeline) = parsed_history.get(timeline_key).and_then(|value| value.as_array()) else {
                continue;
            };

            for snapshot in timeline {
                let Some(nodes) = snapshot.get("nodes").and_then(|value| value.as_array()) else {
                    continue;
                };
                collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
            }
        }
    }

    paths
}

fn resolve_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    let images_dir = app_data_dir.join("images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images dir: {}", e))?;
    Ok(images_dir)
}

fn prune_unreferenced_images(app: &AppHandle) -> Result<(), String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT path FROM project_image_refs")
        .map_err(|e| format!("Failed to prepare image refs query: {}", e))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query image refs: {}", e))?;

    let mut referenced = HashSet::new();
    for path_result in rows {
        let path = path_result.map_err(|e| format!("Failed to decode image ref row: {}", e))?;
        referenced.insert(path);
    }

    let images_dir = resolve_images_dir(app)?;
    let entries = std::fs::read_dir(&images_dir)
        .map_err(|e| format!("Failed to read images dir: {}", e))?;

    for entry_result in entries {
        let entry = entry_result.map_err(|e| format!("Failed to iterate images dir: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let path_string = path.to_string_lossy().to_string();
        if !referenced.contains(&path_string) {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete unreferenced image: {}", e))?;
        }
    }

    Ok(())
}

fn now_timestamp_ms() -> i64 {
    let now = std::time::SystemTime::now();
    now.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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

    ensure_projects_table(&conn)?;
    Ok(conn)
}

#[tauri::command]
pub fn list_project_summaries(app: AppHandle) -> Result<Vec<ProjectSummaryRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id,
              name,
              created_at,
              updated_at,
              node_count
            FROM projects
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|e| format!("Failed to prepare list summaries query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummaryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                node_count: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query project summaries: {}", e))?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| format!("Failed to decode summary row: {}", e))?);
    }
    Ok(projects)
}

#[tauri::command]
pub fn get_project_record(
    app: AppHandle,
    project_id: String,
) -> Result<Option<ProjectRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id,
              name,
              created_at,
              updated_at,
              node_count,
              nodes_json,
              edges_json,
              viewport_json,
              history_json
            FROM projects
            WHERE id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare get project query: {}", e))?;

    let result = stmt.query_row(params![project_id], |row| {
        Ok(ProjectRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            node_count: row.get(4)?,
            nodes_json: row.get(5)?,
            edges_json: row.get(6)?,
            viewport_json: row.get(7)?,
            history_json: row.get(8)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load project: {}", error)),
    }
}

#[tauri::command]
pub fn upsert_project_record(app: AppHandle, record: ProjectRecord) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let image_paths = extract_project_image_paths(&record.nodes_json, &record.history_json);
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    tx.execute(
        r#"
        INSERT INTO projects (
          id,
          name,
          created_at,
          updated_at,
          node_count,
          nodes_json,
          edges_json,
          viewport_json,
          history_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          node_count = excluded.node_count,
          nodes_json = excluded.nodes_json,
          edges_json = excluded.edges_json,
          viewport_json = excluded.viewport_json,
          history_json = excluded.history_json
        "#,
        params![
            record.id,
            record.name,
            record.created_at,
            record.updated_at,
            record.node_count,
            record.nodes_json,
            record.edges_json,
            record.viewport_json,
            record.history_json,
        ],
    )
    .map_err(|e| format!("Failed to upsert project: {}", e))?;

    tx.execute(
        "DELETE FROM project_image_refs WHERE project_id = ?1",
        params![record.id],
    )
    .map_err(|e| format!("Failed to clear project image refs: {}", e))?;

    for path in image_paths {
        tx.execute(
            "INSERT OR IGNORE INTO project_image_refs (project_id, path) VALUES (?1, ?2)",
            params![record.id, path],
        )
        .map_err(|e| format!("Failed to upsert project image ref: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit upsert transaction: {}", e))?;

    prune_unreferenced_images(&app)?;
    Ok(())
}

#[tauri::command]
pub fn update_project_viewport_record(
    app: AppHandle,
    project_id: String,
    viewport_json: String,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE projects SET viewport_json = ?1 WHERE id = ?2",
        params![viewport_json, project_id],
    )
    .map_err(|e| format!("Failed to update project viewport: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn rename_project_record(
    app: AppHandle,
    project_id: String,
    name: String,
    updated_at: i64,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, updated_at, project_id],
    )
    .map_err(|e| format!("Failed to rename project: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn delete_project_record(app: AppHandle, project_id: String) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin delete transaction: {}", e))?;

    tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|e| format!("Failed to delete project: {}", e))?;
    tx.execute(
        "DELETE FROM project_image_refs WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| format!("Failed to delete project image refs: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit delete transaction: {}", e))?;

    prune_unreferenced_images(&app)?;
    Ok(())
}

fn update_image_field_if_needed(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    image_name_to_path: &HashMap<String, String>,
) {
    const IMAGE_REF_PREFIX: &str = "__img_ref__:";

    let Some(value) = obj.get(key) else {
        return;
    };
    let Some(raw) = value.as_str() else {
        return;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with(IMAGE_REF_PREFIX) {
        return;
    }

    let Some(filename) = Path::new(trimmed)
        .file_name()
        .and_then(|item| item.to_str())
        .map(|item| item.to_string())
    else {
        return;
    };

    let Some(next) = image_name_to_path.get(&filename) else {
        return;
    };

    obj.insert(key.to_string(), serde_json::Value::String(next.clone()));
}

fn rewrite_nodes_value_image_paths(
    nodes_value: &mut serde_json::Value,
    image_name_to_path: &HashMap<String, String>,
) {
    let Some(nodes) = nodes_value.as_array_mut() else {
        return;
    };

    for node in nodes {
        let Some(node_obj) = node.as_object_mut() else {
            continue;
        };
        let Some(data) = node_obj.get_mut("data").and_then(|value| value.as_object_mut()) else {
            continue;
        };

        for key in ["imageUrl", "previewImageUrl"] {
            update_image_field_if_needed(data, key, image_name_to_path);
        }

        if let Some(frames) = data.get_mut("frames").and_then(|value| value.as_array_mut()) {
            for frame in frames {
                let Some(frame_obj) = frame.as_object_mut() else {
                    continue;
                };
                for key in ["imageUrl", "previewImageUrl"] {
                    update_image_field_if_needed(frame_obj, key, image_name_to_path);
                }
            }
        }
    }
}

fn rewrite_history_value_image_paths(
    history_value: &mut serde_json::Value,
    images_dir: &Path,
    image_name_to_path: &HashMap<String, String>,
) {
    if let Some(pool) = history_value.get_mut("imagePool").and_then(|value| value.as_array_mut()) {
        for item in pool.iter_mut() {
            let Some(raw) = item.as_str() else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Some(filename) = Path::new(trimmed)
                .file_name()
                .and_then(|name| name.to_str())
            else {
                continue;
            };
            let next_path = images_dir.join(filename).to_string_lossy().to_string();
            *item = serde_json::Value::String(next_path);
        }
    }

    for timeline_key in ["past", "future"] {
        let Some(timeline) = history_value.get_mut(timeline_key).and_then(|value| value.as_array_mut()) else {
            continue;
        };

        for snapshot in timeline {
            let Some(nodes) = snapshot.get_mut("nodes") else {
                continue;
            };
            rewrite_nodes_value_image_paths(nodes, image_name_to_path);
        }
    }
}

fn rewrite_project_image_paths_for_import(
    nodes_json: &str,
    history_json: &str,
    images_dir: &Path,
    image_names: &HashSet<String>,
) -> Result<(String, String, i64), String> {
    let mut image_name_to_path = HashMap::new();
    for name in image_names {
        image_name_to_path.insert(name.clone(), images_dir.join(name).to_string_lossy().to_string());
    }

    let mut parsed_nodes: serde_json::Value =
        serde_json::from_str(nodes_json).unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    rewrite_nodes_value_image_paths(&mut parsed_nodes, &image_name_to_path);

    let node_count = parsed_nodes.as_array().map(|nodes| nodes.len() as i64).unwrap_or(0);

    let mut parsed_history: serde_json::Value =
        serde_json::from_str(history_json).unwrap_or_else(|_| serde_json::json!({}));
    rewrite_history_value_image_paths(&mut parsed_history, images_dir, &image_name_to_path);

    let next_nodes_json =
        serde_json::to_string(&parsed_nodes).map_err(|e| format!("Failed to encode nodes json: {}", e))?;
    let next_history_json =
        serde_json::to_string(&parsed_history).map_err(|e| format!("Failed to encode history json: {}", e))?;

    Ok((next_nodes_json, next_history_json, node_count))
}

#[tauri::command]
pub fn export_project_package(
    app: AppHandle,
    project_id: String,
    target_path: String,
) -> Result<(), String> {
    let record = get_project_record(app.clone(), project_id)?
        .ok_or_else(|| "Project not found".to_string())?;

    let image_paths = extract_project_image_paths(&record.nodes_json, &record.history_json);
    let mut image_files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut seen_filenames = HashSet::new();
    let mut missing_images = Vec::new();

    for path in image_paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Some(filename) = Path::new(trimmed).file_name().and_then(|item| item.to_str()) else {
            continue;
        };

        if !seen_filenames.insert(filename.to_string()) {
            continue;
        }

        match std::fs::read(trimmed) {
            Ok(bytes) => image_files.push((filename.to_string(), bytes)),
            Err(_) => missing_images.push(trimmed.to_string()),
        }
    }

    if !missing_images.is_empty() {
        let mut preview = missing_images;
        if preview.len() > 6 {
            preview.truncate(6);
            preview.push("...".to_string());
        }
        return Err(format!(
            "Export failed: missing {} referenced image files: {}",
            preview.len(),
            preview.join(", ")
        ));
    }

    let package = ProjectPackageV1 {
        format_version: 1,
        exported_at: now_timestamp_ms(),
        project: ProjectPackageRecord {
            name: record.name,
            node_count: record.node_count,
            nodes_json: record.nodes_json,
            edges_json: record.edges_json,
            viewport_json: record.viewport_json,
            history_json: record.history_json,
        },
    };

    let payload =
        serde_json::to_vec(&package).map_err(|e| format!("Failed to encode project package: {}", e))?;

    if let Some(parent) = Path::new(&target_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create export directory: {}", e))?;
    }

    let file = File::create(&target_path).map_err(|e| format!("Failed to create export file: {}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();

    zip.start_file("project.json", options)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;
    zip.write_all(&payload)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;

    for (filename, bytes) in image_files {
        let entry_name = format!("images/{}", filename);
        zip.start_file(entry_name, options)
            .map_err(|e| format!("Failed to write image entry: {}", e))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("Failed to write image entry: {}", e))?;
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize project package: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn import_project_package(app: AppHandle, source_path: String) -> Result<ProjectSummaryRecord, String> {
    let file = File::open(&source_path).map_err(|e| format!("Failed to open project package: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read project package: {}", e))?;

    let package: ProjectPackageV1 = {
        let mut manifest = archive
            .by_name("project.json")
            .map_err(|e| format!("Missing project.json in package: {}", e))?;
        let mut content = String::new();
        manifest
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read project.json: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Invalid project.json: {}", e))?
    };

    let images_dir = resolve_images_dir(&app)?;
    let mut image_names: HashSet<String> = HashSet::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read package entry: {}", e))?;
        let name = entry.name().to_string();

        if !name.starts_with("images/") || name.ends_with('/') {
            continue;
        }

        let Some(filename) = Path::new(&name).file_name().and_then(|item| item.to_str()) else {
            continue;
        };

        image_names.insert(filename.to_string());
        let output_path = images_dir.join(filename);

        if output_path.exists() {
            std::io::copy(&mut entry, &mut std::io::sink())
                .map_err(|e| format!("Failed to read package image: {}", e))?;
            continue;
        }

        let mut output =
            File::create(&output_path).map_err(|e| format!("Failed to persist image: {}", e))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("Failed to persist image: {}", e))?;
    }

    let (nodes_json, history_json, node_count) = rewrite_project_image_paths_for_import(
        &package.project.nodes_json,
        &package.project.history_json,
        &images_dir,
        &image_names,
    )?;

    let now = now_timestamp_ms();
    let project_id = Uuid::new_v4().to_string();
    let node_count = if node_count > 0 { node_count } else { package.project.node_count };

    let record = ProjectRecord {
        id: project_id.clone(),
        name: package.project.name,
        created_at: now,
        updated_at: now,
        node_count,
        nodes_json,
        edges_json: package.project.edges_json,
        viewport_json: package.project.viewport_json,
        history_json,
    };

    upsert_project_record(app.clone(), record.clone())?;

    Ok(ProjectSummaryRecord {
        id: record.id,
        name: record.name,
        created_at: record.created_at,
        updated_at: record.updated_at,
        node_count: record.node_count,
    })
}
