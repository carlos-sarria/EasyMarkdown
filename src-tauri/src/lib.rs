use std::sync::Mutex;

// ── App state ─────────────────────────────────────────────────────────────

/// Holds the file path supplied via CLI argument or OS file association.
///
/// Stored as `Mutex<Option<String>>` so the frontend can consume it once via
/// the `get_initial_file` command, after which it becomes `None`. This avoids
/// the race condition that arises when emitting an event before the frontend
/// has registered its listener.
pub struct AppState {
    pub initial_file: Mutex<Option<String>>,
}

// ── Tauri commands ────────────────────────────────────────────────────────

/// Returns the file path passed as a CLI argument (or via OS file association),
/// then clears the stored value so subsequent calls return `None`.
///
/// Called once by the frontend on startup:
///
/// ```js
/// import { invoke } from '@tauri-apps/api/core';
/// const path = await invoke('get_initial_file'); // Option<string>
/// if (path) loadFile(path);
/// ```
#[tauri::command]
fn get_initial_file(state: tauri::State<'_, AppState>) -> Option<String> {
    state.initial_file.lock().unwrap().take()
}

// ── App entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture argv[1] before the Tauri builder consumes the process arguments.
    // argv[0] is the binary path; argv[1] is the optional file to open.
    // We verify the path exists so stray arguments don't produce a confusing error.
    let initial_file: Option<String> = std::env::args().nth(1).and_then(|p| {
        if std::path::Path::new(&p).exists() {
            Some(p)
        } else {
            None
        }
    });

    tauri::Builder::default()
        // Make the initial file path available to the `get_initial_file` command.
        .manage(AppState {
            initial_file: Mutex::new(initial_file),
        })
        // Plugin: OS file-open dialog  → JS: @tauri-apps/plugin-dialog
        .plugin(tauri_plugin_dialog::init())
        // Plugin: read files from disk → JS: @tauri-apps/plugin-fs
        .plugin(tauri_plugin_fs::init())
        // Register custom commands
        .invoke_handler(tauri::generate_handler![get_initial_file])
        .run(tauri::generate_context!())
        .expect("error while running EasyMD");
}
