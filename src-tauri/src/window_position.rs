use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewWindow, WindowEvent,
};

const DEFAULT_WINDOW_WIDTH: f64 = 1280.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 800.0;
const WORK_AREA_WIDTH_RATIO: f64 = 0.94;
const WORK_AREA_HEIGHT_RATIO: f64 = 0.92;

#[derive(Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window-position.json"))
}

pub(crate) fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }

    let saved = config_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<SavedPosition>(&contents).ok());
    let monitor = saved
        .as_ref()
        .and_then(|position| monitor_for_position(position, &monitors))
        .cloned()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(monitor) = monitor else {
        return;
    };

    let logical_size = set_size_for_monitor(&window, &monitor);
    let window_size = physical_size(logical_size, monitor.scale_factor());
    let position = saved
        .filter(|saved| intersects_work_area(saved.x, saved.y, window_size, &monitor))
        .map(|saved| clamp_to_work_area(saved.x, saved.y, window_size, &monitor))
        .unwrap_or_else(|| centered_in_work_area(window_size, &monitor));
    let _ = window.set_position(Position::Physical(position));
}

pub(crate) fn watch(window: WebviewWindow, app: AppHandle) {
    let scale_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(position) => {
            let x = position.x;
            let y = position.y;
            let generation = app
                .state::<AppState>()
                .position_generation
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(450)).await;
                if app_handle
                    .state::<AppState>()
                    .position_generation
                    .load(Ordering::Relaxed)
                    == generation
                {
                    save_position(&app_handle, x, y);
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            let window = scale_window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(120)).await;
                let Ok(Some(monitor)) = window.current_monitor() else {
                    return;
                };
                let logical_size = set_size_for_monitor(&window, &monitor);
                tokio::time::sleep(Duration::from_millis(80)).await;
                let window_size = window
                    .outer_size()
                    .unwrap_or_else(|_| physical_size(logical_size, monitor.scale_factor()));
                let Ok(position) = window.outer_position() else {
                    return;
                };
                let clamped = clamp_to_work_area(position.x, position.y, window_size, &monitor);
                if clamped != position {
                    let _ = window.set_position(Position::Physical(clamped));
                }
            });
        }
        _ => {}
    });
}

pub(crate) fn save_current(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(position) = window.outer_position() {
            save_position(app, position.x, position.y);
        }
    }
}

fn save_position(app: &AppHandle, x: i32, y: i32) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if !monitors
        .iter()
        .any(|monitor| intersects_work_area(x, y, size, monitor))
    {
        return;
    }
    let Some(path) = config_path(app) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if let Err(error) = fs::create_dir_all(parent) {
        eprintln!("Unable to create window settings directory: {error}");
        return;
    }
    let contents = match serde_json::to_vec(&SavedPosition { x, y }) {
        Ok(contents) => contents,
        Err(error) => {
            eprintln!("Unable to serialize window position: {error}");
            return;
        }
    };
    if let Err(error) = fs::write(path, contents) {
        eprintln!("Unable to save window position: {error}");
    }
}

fn set_size_for_monitor(window: &WebviewWindow, monitor: &Monitor) -> LogicalSize<f64> {
    let work_area = monitor.work_area().size;
    let size = fit_logical_size(work_area.width, work_area.height, monitor.scale_factor());
    if let Err(error) = window.set_size(Size::Logical(size)) {
        eprintln!("Unable to fit window to monitor scale: {error}");
    }
    size
}

fn fit_logical_size(width: u32, height: u32, scale_factor: f64) -> LogicalSize<f64> {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let available_width = f64::from(width) / scale_factor;
    let available_height = f64::from(height) / scale_factor;
    LogicalSize::new(
        (available_width * WORK_AREA_WIDTH_RATIO).clamp(1.0, DEFAULT_WINDOW_WIDTH),
        (available_height * WORK_AREA_HEIGHT_RATIO).clamp(1.0, DEFAULT_WINDOW_HEIGHT),
    )
}

fn physical_size(size: LogicalSize<f64>, scale_factor: f64) -> PhysicalSize<u32> {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    PhysicalSize::new(
        (size.width * scale_factor).ceil() as u32,
        (size.height * scale_factor).ceil() as u32,
    )
}

fn monitor_for_position<'a>(
    position: &SavedPosition,
    monitors: &'a [Monitor],
) -> Option<&'a Monitor> {
    monitors.iter().find(|monitor| {
        let size = fit_logical_size(
            monitor.work_area().size.width,
            monitor.work_area().size.height,
            monitor.scale_factor(),
        );
        let size = physical_size(size, monitor.scale_factor());
        intersects_work_area(position.x, position.y, size, monitor)
    })
}

fn intersects_work_area(x: i32, y: i32, window_size: PhysicalSize<u32>, monitor: &Monitor) -> bool {
    let work_area = monitor.work_area();
    let right = i64::from(x) + i64::from(window_size.width);
    let bottom = i64::from(y) + i64::from(window_size.height);
    let area_left = i64::from(work_area.position.x);
    let area_top = i64::from(work_area.position.y);
    let area_right = area_left + i64::from(work_area.size.width);
    let area_bottom = area_top + i64::from(work_area.size.height);
    let visible_width = right.min(area_right) - i64::from(x).max(area_left);
    let visible_height = bottom.min(area_bottom) - i64::from(y).max(area_top);
    visible_width >= 64 && visible_height >= 64
}

fn centered_in_work_area(
    window_size: PhysicalSize<u32>,
    monitor: &Monitor,
) -> PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    PhysicalPosition::new(
        work_area.position.x + (work_area.size.width as i32 - window_size.width as i32).max(0) / 2,
        work_area.position.y
            + (work_area.size.height as i32 - window_size.height as i32).max(0) / 2,
    )
}

fn clamp_to_work_area(
    x: i32,
    y: i32,
    window_size: PhysicalSize<u32>,
    monitor: &Monitor,
) -> PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    let left = work_area.position.x;
    let top = work_area.position.y;
    let right = (left + work_area.size.width as i32 - window_size.width as i32).max(left);
    let bottom = (top + work_area.size.height as i32 - window_size.height as i32).max(top);
    PhysicalPosition::new(x.clamp(left, right), y.clamp(top, bottom))
}

#[cfg(test)]
mod tests {
    use super::{fit_logical_size, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH};

    #[test]
    fn keeps_the_design_size_when_a_hidpi_monitor_has_room() {
        let size = fit_logical_size(3840, 2160, 2.0);
        assert_eq!(size.width, DEFAULT_WINDOW_WIDTH);
        assert_eq!(size.height, DEFAULT_WINDOW_HEIGHT);
    }

    #[test]
    fn fits_a_scaled_1080p_work_area_in_logical_pixels() {
        let size = fit_logical_size(1920, 1080, 2.0);
        assert!((size.width - 902.4).abs() < 0.01);
        assert!((size.height - 496.8).abs() < 0.01);
    }
}
