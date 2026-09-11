//! A folder on the user's machine for source material — PDFs, notes, images —
//! that Recall reads from and writes to.
//!
//! The folder's location is remembered in `config.json`; a caller can point it
//! anywhere with the native picker. Everything else here is a thin wrapper over
//! `std::fs` on that one directory, with file names constrained to a single path
//! component so nothing can be read or written outside it.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::claude::Error;

#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    size: u64,
    modified_ms: u64,
}

/* ---------- folder location ---------- */

fn config_path(app: &AppHandle) -> Result<PathBuf, Error> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::store(format!("Could not locate the app data directory: {e}")))?;
    Ok(dir.join("config.json"))
}

fn default_folder(app: &AppHandle) -> Result<PathBuf, Error> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| Error::store(format!("Could not locate a home directory: {e}")))?;
    Ok(base.join("Recall"))
}

/// The configured files folder, falling back to `~/Documents/Recall`. The folder
/// is created if it is missing, so every other function here can assume it
/// exists.
fn folder(app: &AppHandle) -> Result<PathBuf, Error> {
    let dir = match read_configured_folder(app)? {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => default_folder(app)?,
    };
    fs::create_dir_all(&dir)
        .map_err(|e| Error::store(format!("Could not create {}: {e}", dir.display())))?;
    Ok(dir)
}

fn read_configured_folder(app: &AppHandle) -> Result<Option<PathBuf>, Error> {
    let path = config_path(app)?;
    match fs::read_to_string(&path) {
        Ok(s) => {
            let v: serde_json::Value = serde_json::from_str(&s)
                .map_err(|e| Error::store(format!("Could not parse {}: {e}", path.display())))?;
            Ok(v.get("filesDir")
                .and_then(|x| x.as_str())
                .map(PathBuf::from))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::store(format!(
            "Could not read {}: {e}",
            path.display()
        ))),
    }
}

fn write_configured_folder(app: &AppHandle, files_dir: &Path) -> Result<(), Error> {
    let path = config_path(app)?;
    let dir = path.parent().expect("the config path always has a parent");
    fs::create_dir_all(dir)
        .map_err(|e| Error::store(format!("Could not create {}: {e}", dir.display())))?;

    let body = serde_json::json!({ "filesDir": files_dir.to_string_lossy() }).to_string();
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)
        .map_err(|e| Error::store(format!("Could not write {}: {e}", tmp.display())))?;
    fs::rename(&tmp, &path)
        .map_err(|e| Error::store(format!("Could not replace {}: {e}", path.display())))?;
    Ok(())
}

/// Rejects anything that is not a bare file name, so a caller cannot reach
/// outside the folder with `../` or an absolute path.
fn resolve(app: &AppHandle, name: &str) -> Result<PathBuf, Error> {
    let trimmed = name.trim();
    let one_component = Path::new(trimmed).components().count() == 1;
    if trimmed.is_empty()
        || trimmed.starts_with('.')
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || !one_component
    {
        return Err(Error::store(format!(
            "\"{name}\" is not a valid file name."
        )));
    }
    Ok(folder(app)?.join(trimmed))
}

/// A destination in `dir` that does not collide: `note.md`, then `note (2).md`.
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let as_path = Path::new(name);
    let stem = as_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = as_path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{ext}", std::process::id()))
}

/* ---------- commands ---------- */

/// The absolute path of the folder Recall is currently reading from and writing
/// to.
#[tauri::command]
pub fn files_folder(app: AppHandle) -> Result<String, Error> {
    Ok(folder(&app)?.to_string_lossy().into_owned())
}

/// Opens a native folder picker. On a choice, remembers it and returns the new
/// path; returns `None` if the user cancels.
#[tauri::command]
pub async fn files_folder_pick(app: AppHandle) -> Result<Option<String>, Error> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| Error::store(format!("That folder path could not be read: {e}")))?;
    fs::create_dir_all(&path)
        .map_err(|e| Error::store(format!("Could not use {}: {e}", path.display())))?;
    write_configured_folder(&app, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Every regular file in the folder, newest first. Dotfiles are skipped.
#[tauri::command]
pub fn files_list(app: AppHandle) -> Result<Vec<FileEntry>, Error> {
    let dir = folder(&app)?;
    let reader = fs::read_dir(&dir)
        .map_err(|e| Error::store(format!("Could not read {}: {e}", dir.display())))?;

    let mut out = Vec::new();
    for entry in reader {
        let entry =
            entry.map_err(|e| Error::store(format!("Could not read {}: {e}", dir.display())))?;
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(FileEntry {
            name,
            size: meta.len(),
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// Opens a native multi-file picker and copies the chosen files into the folder.
/// Returns the names they landed under (may be suffixed to avoid a collision).
#[tauri::command]
pub async fn files_import(app: AppHandle) -> Result<Vec<String>, Error> {
    let Some(picked) = app.dialog().file().blocking_pick_files() else {
        return Ok(Vec::new());
    };
    let dir = folder(&app)?;

    let mut added = Vec::new();
    for file in picked {
        let src = file
            .into_path()
            .map_err(|e| Error::store(format!("A chosen file could not be read: {e}")))?;
        let name = src
            .file_name()
            .ok_or_else(|| Error::store("A chosen file has no name.".to_string()))?
            .to_string_lossy()
            .into_owned();
        let dest = unique_dest(&dir, &name);
        fs::copy(&src, &dest)
            .map_err(|e| Error::store(format!("Could not copy {} in: {e}", src.display())))?;
        added.push(
            dest.file_name()
                .expect("a freshly built destination has a file name")
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(added)
}

/// Opens one file in whatever app the OS uses for it.
#[tauri::command]
pub fn files_open(app: AppHandle, name: String) -> Result<(), Error> {
    let path = resolve(&app, &name)?;
    if !path.exists() {
        return Err(Error::store(format!(
            "\"{name}\" is not in the files folder."
        )));
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| Error::store(format!("Could not open \"{name}\": {e}")))
}

/// Reveals the folder itself in the system file browser.
#[tauri::command]
pub fn files_reveal(app: AppHandle) -> Result<(), Error> {
    let dir = folder(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| Error::store(format!("Could not open the folder: {e}")))
}

/// Deletes one file. Deleting something already gone is a success.
#[tauri::command]
pub fn files_delete(app: AppHandle, name: String) -> Result<(), Error> {
    let path = resolve(&app, &name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::store(format!(
            "Could not delete {}: {e}",
            path.display()
        ))),
    }
}
