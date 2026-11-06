use tauri::{Theme, WebviewWindow};

#[tauri::command]
pub(crate) fn set_window_theme(window: WebviewWindow, dark: bool) -> Result<(), String> {
    apply(&window, dark).map_err(|error| error.to_string())
}

pub(crate) fn apply(window: &WebviewWindow, dark: bool) -> tauri::Result<()> {
    window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }))?;

    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        };

        let hwnd = window.hwnd()?.0;
        // COLORREF uses 0x00BBGGRR. Match the native caption to the app toolbar.
        let (caption, text, border) = if dark {
            (0x00302318_u32, 0x00F5EEE5_u32, 0x004B3C2D_u32)
        } else {
            (0x00FAF7F3_u32, 0x003E2F20_u32, 0x00DED3C7_u32)
        };
        for (attribute, color) in [
            (DWMWA_CAPTION_COLOR, caption),
            (DWMWA_TEXT_COLOR, text),
            (DWMWA_BORDER_COLOR, border),
        ] {
            // SAFETY: hwnd belongs to this live window and color points to a u32
            // for the duration of this synchronous call. Older Windows versions
            // may reject these attributes and retain the system caption colors.
            unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    attribute as u32,
                    &color as *const u32 as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }
    }

    Ok(())
}
