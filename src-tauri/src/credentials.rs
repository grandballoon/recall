//! The only module that knows where the API key lives.
//!
//! The key is held in the OS credential store (Keychain on macOS, Credential
//! Manager on Windows, Secret Service on Linux) rather than in a config file or
//! in the webview, so it is never readable by page content.

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "com.grandballoon.recall";
const ACCOUNT: &str = "anthropic-api-key";

/// The stored key, or `None` when the user has not connected Claude yet.
pub fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(describe(e)),
    }
}

pub fn store(api_key: &str) -> Result<(), String> {
    entry()?.set_password(api_key).map_err(describe)
}

/// Removing a key that was never stored is a success, not an error.
pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(describe(e)),
    }
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(describe)
}

fn describe(e: KeyringError) -> String {
    format!("Could not reach the system keychain: {e}")
}
