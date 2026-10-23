mod monitor;
mod target;
mod window_position;
#[cfg(windows)]
mod windows_trace;

use monitor::MonitorRegistry;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use tauri::{Emitter, Manager, State};

struct AppState {
    monitors: MonitorRegistry,
    position_generation: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            monitors: MonitorRegistry::default(),
            position_generation: AtomicU64::new(0),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResolution {
    host: String,
    address: String,
}

#[tauri::command]
async fn start_monitoring(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host: String,
    interval_ms: u64,
) -> Result<String, String> {
    state.monitors.start(app, host, interval_ms)
}

#[tauri::command]
fn stop_monitoring(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.monitors.stop(&app)
}

#[tauri::command]
async fn resolve_host(host: String) -> Result<HostResolution, String> {
    let normalized = target::validate_host(&host)?;
    let address = target::resolve(&normalized).await?;
    Ok(HostResolution {
        host: normalized,
        address: address.to_string(),
    })
}

#[tauri::command]
fn save_text_report(directory: String, filename: String, contents: String) -> Result<(), String> {
    let directory = directory.trim();
    if directory.is_empty() {
        return Err("Choose a folder for text reports in Settings".into());
    }
    let filename = PathBuf::from(filename);
    if filename.components().count() != 1 || filename.file_name().is_none() {
        return Err("Invalid report filename".into());
    }
    let directory = PathBuf::from(directory);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join(filename), contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_home_directory(app: tauri::AppHandle) -> Result<String, String> {
    app.path().home_dir().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            window_position::restore(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                window_position::watch(window, app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_monitoring,
            stop_monitoring,
            resolve_host,
            save_text_report,
            get_home_directory
        ])
        .build(tauri::generate_context!())
        .expect("failed to build LanPinger")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<AppState>();
                state.monitors.cancel_on_exit();
                window_position::save_current(app);
            }
        });
}

pub(crate) fn emit<T: Serialize + Clone>(app: &tauri::AppHandle, name: &str, payload: T) {
    if let Err(error) = app.emit(name, payload) {
        eprintln!("Unable to publish {name} event: {error}");
    }
}
