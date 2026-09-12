//! Where the study library lives on disk.
//!
//! The webview owns the library's shape — prose, comment threads, verdicts, the
//! library index — and serializes all of it into a single JSON string. This
//! module only moves that string to and from `library.json` in the app data
//! directory; it never parses it. Keeping the schema entirely on the frontend
//! means the store never has to change when the document model does.
//!
//! Every save also leaves the previous copy behind as `library.json.bak`. The
//! whole library is rewritten on each save, so without that the newest write is
//! the only copy in existence — one bad write, and a year of recall is gone. The
//! backup is made by renaming rather than copying, which costs nothing on any
//! library size and cannot itself fail halfway.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::claude::Error;

fn library_dir(app: &AppHandle) -> Result<PathBuf, Error> {
    app.path()
        .app_data_dir()
        .map_err(|e| Error::store(format!("Could not locate the app data directory: {e}")))
}

fn library_path(app: &AppHandle) -> Result<PathBuf, Error> {
    Ok(library_dir(app)?.join("library.json"))
}

/// The saved library as a JSON string, or `None` before anything has been saved.
#[tauri::command]
pub fn library_load(app: AppHandle) -> Result<Option<String>, Error> {
    load_from(&library_path(&app)?)
}

/// Writes the library, keeping the copy it replaces as `library.json.bak`.
#[tauri::command]
pub fn library_save(app: AppHandle, data: String) -> Result<(), Error> {
    save_to(&library_path(&app)?, &data)
}

/// Shows the library file in the system file browser, so a reader who has been
/// told their library could not be read can get at the file and its backup.
#[tauri::command]
pub fn library_reveal(app: AppHandle) -> Result<(), Error> {
    let path = library_path(&app)?;
    // Before the first save there is no file to point at; the folder will do.
    let target = if path.exists() {
        path
    } else {
        library_dir(&app)?
    };
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| Error::store(format!("Could not show {}: {e}", target.display())))
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

fn load_from(path: &Path) -> Result<Option<String>, Error> {
    match fs::read_to_string(path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::store(format!(
            "Could not read {}: {e}",
            path.display()
        ))),
    }
}

/// The bytes go to a sibling temp file and are renamed into place, so a crash
/// mid-write cannot leave a half-written `library.json` behind. The copy being
/// replaced is rotated to `.bak` first, so the previous good state always
/// outlives the write that supersedes it.
fn save_to(path: &Path, data: &str) -> Result<(), Error> {
    let dir = path.parent().expect("the library path always has a parent");
    fs::create_dir_all(dir)
        .map_err(|e| Error::store(format!("Could not create {}: {e}", dir.display())))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes())
        .map_err(|e| Error::store(format!("Could not write {}: {e}", tmp.display())))?;

    // Rotate the existing copy out of the way. A missing file just means this is
    // the first save; a failure to rotate must not cost the caller their write,
    // so it is not fatal — the temp file is still sound and about to land.
    if path.exists() {
        let _ = fs::rename(path, backup_path(path));
    }

    fs::rename(&tmp, path)
        .map_err(|e| Error::store(format!("Could not replace {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that cleans up after itself, so these tests leave
    /// nothing behind in the temp dir.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "recall-library-test-{tag}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> PathBuf {
            self.0.join("library.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn nothing_saved_yet_reads_as_none() {
        let s = Scratch::new("empty");
        assert_eq!(load_from(&s.path()).unwrap(), None);
    }

    #[test]
    fn a_saved_library_round_trips() {
        let s = Scratch::new("roundtrip");
        save_to(&s.path(), r#"{"v":1,"library":[]}"#).unwrap();
        assert_eq!(
            load_from(&s.path()).unwrap().as_deref(),
            Some(r#"{"v":1,"library":[]}"#)
        );
    }

    #[test]
    fn the_first_save_has_nothing_to_back_up() {
        let s = Scratch::new("firstsave");
        save_to(&s.path(), "one").unwrap();
        assert!(!backup_path(&s.path()).exists());
    }

    /// The point of the whole module: the copy a save replaces survives it.
    #[test]
    fn each_save_leaves_the_previous_copy_as_a_backup() {
        let s = Scratch::new("rotate");
        save_to(&s.path(), "first").unwrap();
        save_to(&s.path(), "second").unwrap();

        assert_eq!(load_from(&s.path()).unwrap().as_deref(), Some("second"));
        assert_eq!(
            fs::read_to_string(backup_path(&s.path())).unwrap(),
            "first",
            "the backup should hold the copy that was just replaced"
        );

        save_to(&s.path(), "third").unwrap();
        assert_eq!(load_from(&s.path()).unwrap().as_deref(), Some("third"));
        assert_eq!(
            fs::read_to_string(backup_path(&s.path())).unwrap(),
            "second"
        );
    }

    /// A half-written temp file must never be mistaken for the library.
    #[test]
    fn no_temp_file_is_left_behind() {
        let s = Scratch::new("tmp");
        save_to(&s.path(), "data").unwrap();
        assert!(!s.path().with_extension("json.tmp").exists());
    }
}
