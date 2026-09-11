//! Where the study library lives on disk.
//!
//! The webview owns the library's shape — prose, comment threads, verdicts, the
//! library index — and serializes all of it into a single JSON string. This
//! module only moves that string to and from `library.json` in the app data
//! directory; it never parses it. Keeping the schema entirely on the frontend
//! means the store never has to change when the document model does.

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::claude::Error;

fn library_path(app: &AppHandle) -> Result<PathBuf, Error> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::store(format!("Could not locate the app data directory: {e}")))?;
    Ok(dir.join("library.json"))
}

/// The saved library as a JSON string, or `None` before anything has been saved.
#[tauri::command]
pub fn library_load(app: AppHandle) -> Result<Option<String>, Error> {
    let path = library_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::store(format!(
            "Could not read {}: {e}",
            path.display()
        ))),
    }
}

/// Writes the library, replacing any previous copy. The bytes go to a sibling
/// temp file first and are renamed into place, so a crash mid-write cannot leave
/// a half-written `library.json` behind.
#[tauri::command]
pub fn library_save(app: AppHandle, data: String) -> Result<(), Error> {
    let path = library_path(&app)?;
    let dir = path.parent().expect("the library path always has a parent");
    fs::create_dir_all(dir)
        .map_err(|e| Error::store(format!("Could not create {}: {e}", dir.display())))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes())
        .map_err(|e| Error::store(format!("Could not write {}: {e}", tmp.display())))?;
    fs::rename(&tmp, &path)
        .map_err(|e| Error::store(format!("Could not replace {}: {e}", path.display())))?;
    Ok(())
}
