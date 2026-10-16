// Hides the console window that would otherwise open behind the widget.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::StateFlags;

// The page has no bundler, so it can't import the autostart plugin's JS API.
// These two commands wrap the plugin and are called with __TAURI__.core.invoke.
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    (if enabled { launcher.enable() } else { launcher.disable() }).map_err(|e| e.to_string())
}

/// Brings the widget back from the tray (or from behind other windows).
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_main(app);
        }
    }
}

fn main() {
    tauri::Builder::default()
        // Remembers where the user parked the widget. POSITION only: the app
        // sets its own height when the settings panel opens and closes, so
        // letting the plugin restore a saved size would fight with that.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![get_autostart, set_autostart])
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "Show/Hide", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &settings, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("no window icon"))
                .tooltip("Ticker Belt")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => toggle_main(app),
                    "settings" => {
                        show_main(app);
                        // The settings panel lives in the page, so ask it to open.
                        let _ = app.emit_to("main", "open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // The × button asks the window to close; hide it instead so the tray
        // keeps the app alive. Only the tray's Quit item exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Ticker Belt")
        .run(|_app, event| {
            // `code` is None when the last window closes, Some(_) when app.exit()
            // is called. Block the first, let the second through.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
