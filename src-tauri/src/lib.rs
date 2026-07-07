use std::fs;
use std::io::Read;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use tauri::Emitter;
use tauri::Manager;

// ── Constants ─────────────────────────────────────────────────────────────

/// Localhost port used for single-instance detection and IPC.
/// An arbitrary port in the ephemeral range — unlikely to collide.
const IPC_PORT: u16 = 34982;

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

// ── Tab persistence ───────────────────────────────────────────────────────

/// Returns the path to `tabs.json` inside the app's data directory.
fn tabs_file_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let mut dir = app
        .path()
        .app_data_dir()
        .expect("app data dir");
    fs::create_dir_all(&dir).ok();
    dir.push("tabs.json");
    dir
}

/// Save the ordered list of open tab paths to disk.
#[tauri::command]
fn save_tabs(app: tauri::AppHandle, paths: Vec<String>) {
    let json = serde_json::to_string(&paths).unwrap_or_default();
    let _ = fs::write(tabs_file_path(&app), json);
}

/// Return the previously saved list of open tab paths (may be empty).
#[tauri::command]
fn load_tabs(app: tauri::AppHandle) -> Vec<String> {
    let path = tabs_file_path(&app);
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => vec![],
    }
}

// ── Single-instance IPC ───────────────────────────────────────────────────

/// Try to become the primary (first) instance by binding a local TCP port.
///
/// Returns `Ok(mpsc::Receiver)` when this process *is* the first instance —
/// the receiver will deliver file paths forwarded by subsequent instances.
///
/// Returns `Err(())` when another instance is already running.  The caller
/// should forward argv[1] to the primary instance and exit immediately.
fn try_become_primary() -> Result<mpsc::Receiver<String>, ()> {
    let listener = TcpListener::bind(("127.0.0.1", IPC_PORT)).map_err(|_| ())?;

    let (tx, rx) = mpsc::channel::<String>();

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_secondary(stream, &tx);
        }
    });

    Ok(rx)
}

/// Called by a secondary instance: connect to the primary, send our file path,
/// and exit (never returns).
fn forward_and_exit(path: &str) -> ! {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", IPC_PORT)) {
        // Best-effort — if the primary isn't listening we just drop out.
        let _ = stream.write_all(path.as_bytes());
    }
    std::process::exit(0);
}

/// Read a file path from a secondary instance's TCP stream and forward it
/// through the mpsc channel so the Tauri thread can emit it to the frontend.
fn handle_secondary(mut stream: TcpStream, tx: &mpsc::Sender<String>) {
    let mut buf = String::new();
    if stream.read_to_string(&mut buf).is_ok() {
        let path = buf.trim().to_string();
        if !path.is_empty() {
            let _ = tx.send(path);
        }
    }
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

    // ── Single-instance handshake ──────────────────────────────────────────

    // If this is NOT the first instance, forward argv[1] to the running
    // instance and exit — the frontend's "file-opened" listener will pick it up
    // and open a new tab.
    let incoming_paths = match try_become_primary() {
        Ok(rx) => rx,
        Err(()) => {
            if let Some(ref path) = initial_file {
                forward_and_exit(path);
            }
            // No file path to forward — just exit.
            std::process::exit(0);
        }
    };

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
        .invoke_handler(tauri::generate_handler![get_initial_file, save_tabs, load_tabs])
        // Wire up single-instance IPC: forward paths received from secondary
        // instances to the frontend as "file-opened" events.
        .setup(move |app| {
            let handle = app.handle().clone();
            thread::spawn(move || {
                for path in incoming_paths {
                    // Bring the window to the foreground.
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    let _ = handle.emit("file-opened", path);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running EasyMD");
}
