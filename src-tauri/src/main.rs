#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod commands;
mod credentials;
mod files;
mod library;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(claude::Claude::new())
        .invoke_handler(tauri::generate_handler![
            commands::claude_status,
            commands::claude_connect,
            commands::claude_disconnect,
            commands::claude_assess,
            library::library_load,
            library::library_save,
            files::files_folder,
            files::files_folder_pick,
            files::files_list,
            files::files_import,
            files::files_open,
            files::files_reveal,
            files::files_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Recall");
}
