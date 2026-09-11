//! The boundary between the webview and the backend.
//!
//! Commands stay thin on purpose: they fetch the key, hand off to `claude`, and
//! shape the result. The API key itself never crosses back into the webview.

use tauri::State;

use crate::claude::{Assessment, Claude, Error, MODEL};
use crate::credentials;

#[derive(serde::Serialize)]
pub struct Status {
    pub connected: bool,
    pub model: &'static str,
}

impl Status {
    fn of(connected: bool) -> Self {
        Self {
            connected,
            model: MODEL,
        }
    }
}

fn stored_key() -> Result<String, Error> {
    credentials::load()
        .map_err(Error::keychain)?
        .ok_or_else(Error::not_connected)
}

#[tauri::command]
pub fn claude_status() -> Result<Status, Error> {
    let key = credentials::load().map_err(Error::keychain)?;
    Ok(Status::of(key.is_some()))
}

/// Verifies the key before storing it, so a typo fails here rather than at the
/// first check.
#[tauri::command]
pub async fn claude_connect(api_key: String, claude: State<'_, Claude>) -> Result<Status, Error> {
    let api_key = api_key.trim().to_owned();
    if api_key.is_empty() {
        return Err(Error {
            code: "auth",
            message: "Enter an API key first.".into(),
        });
    }

    claude.verify_key(&api_key).await?;
    credentials::store(&api_key).map_err(Error::keychain)?;
    Ok(Status::of(true))
}

#[tauri::command]
pub fn claude_disconnect() -> Result<Status, Error> {
    credentials::clear().map_err(Error::keychain)?;
    Ok(Status::of(false))
}

#[tauri::command]
pub async fn claude_assess(
    full_text: String,
    span: String,
    claude: State<'_, Claude>,
) -> Result<Assessment, Error> {
    let api_key = stored_key()?;
    claude.assess(&api_key, &full_text, &span).await
}
