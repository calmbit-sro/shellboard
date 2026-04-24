mod pty;

use pty::{
    git_branch, git_status, home_dir, kill_pty, resize_pty, spawn_pty, write_to_pty,
    PtyManager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_to_pty,
            resize_pty,
            kill_pty,
            home_dir,
            git_branch,
            git_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
