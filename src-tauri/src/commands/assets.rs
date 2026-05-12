use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
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
