// Hides the console window that would otherwise open behind the widget.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, fs, sync::Mutex};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::StateFlags;

/// Quiet launch-time update check. If a newer signed release exists it is
/// downloaded and installed; on Windows the installer closes and relaunches
/// the app. Any failure (offline, no release yet) is ignored on purpose.
async fn check_for_update(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
        let _ = app.global_shortcut().unregister_all();
        app.restart();
    }
    Ok(())
}

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

// --- Global shortcuts ---------------------------------------------------
// The widget almost never has keyboard focus, so these are OS-level hotkeys.
// Rust owns them: it registers them at launch (before the page has loaded)
// from shortcuts.json in the config dir, and the page reads them back with
// get_shortcuts, the same way the OS is the truth for autostart.

/// Every action, with its default combo. "" in a binding means turned off.
const ACTIONS: [(&str, &str); 3] = [
    ("ontop", "Ctrl+Alt+P"),
    ("toggle", "Ctrl+Alt+B"),
    ("settings", "Ctrl+Alt+S"),
];

#[derive(Default)]
struct Hotkeys {
    binds: HashMap<String, String>,   // action -> accelerator
    errors: HashMap<String, String>,  // action -> why it isn't registered
    live: HashMap<u32, &'static str>, // registered shortcut id -> action
}

fn binds_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("shortcuts.json"))
}

fn load_binds(app: &AppHandle) -> HashMap<String, String> {
    let saved: HashMap<String, String> = binds_file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    ACTIONS
        .iter()
        .map(|(a, def)| (a.to_string(), saved.get(*a).cloned().unwrap_or_else(|| def.to_string())))
        .collect()
}

fn save_binds(app: &AppHandle, binds: &HashMap<String, String>) {
    if let Some(p) = binds_file(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(binds) {
            let _ = fs::write(p, s);
        }
    }
}

/// Unregisters everything, then registers each binding on its own, so one
/// that fails (taken by another app, say) doesn't stop the rest.
fn apply_binds(app: &AppHandle, binds: HashMap<String, String>) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut next = Hotkeys::default();
    for (action, _) in ACTIONS {
        let accel = binds.get(action).map(|s| s.trim()).unwrap_or("");
        next.binds.insert(action.to_string(), accel.to_string());
        if accel.is_empty() {
            continue;
        }
        let result = accel
            .parse::<Shortcut>()
            .map_err(|_| "Not a shortcut Windows understands.".to_string())
            .and_then(|sc| {
                if sc.mods.contains(Modifiers::SUPER) {
                    return Err("Windows keeps Win+ shortcuts for itself.".to_string());
                }
                if next.live.contains_key(&sc.id()) {
                    return Err("Already used by another shortcut here.".to_string());
                }
                gs.register(sc).map(|_| sc.id()).map_err(|e| {
                    let e = e.to_string();
                    if e.contains("already registered") {
                        "Another app is already using this combination.".to_string()
                    } else {
                        format!("Windows refused it: {e}")
                    }
                })
            });
        match result {
            Ok(id) => {
                next.live.insert(id, action);
            }
            Err(why) => {
                next.errors.insert(action.to_string(), why);
            }
        }
    }
    // Swapped in only at the end, so the shortcut handler never waits on a
    // lock held across the register calls above.
    *app.state::<Mutex<Hotkeys>>().lock().unwrap() = next;
}

fn hotkeys_json(app: &AppHandle) -> serde_json::Value {
    let hk = app.state::<Mutex<Hotkeys>>();
    let hk = hk.lock().unwrap();
    serde_json::json!({ "binds": hk.binds, "errors": hk.errors })
}

fn run_action(app: &AppHandle, action: &str) {
    let Some(win) = app.get_webview_window("main") else { return };
    match action {
        "ontop" => {
            let on = !win.is_always_on_top().unwrap_or(true);
            if win.set_always_on_top(on).is_ok() {
                // The page shows a toast and updates its checkbox and settings.
                let _ = app.emit_to("main", "ontop-changed", on);
            }
        }
        "toggle" => toggle_main(app),
        "settings" => {
            if win.is_visible().unwrap_or(false) {
                let _ = app.emit_to("main", "toggle-settings", ());
            } else {
                show_main(app);
                let _ = app.emit_to("main", "open-settings", ());
            }
        }
        _ => {}
    }
}

#[tauri::command]
fn get_shortcuts(app: AppHandle) -> serde_json::Value {
    hotkeys_json(&app)
}

/// Rebinding: replace the whole set, save it, and report what registered.
#[tauri::command]
fn set_shortcuts(app: AppHandle, binds: HashMap<String, String>) -> serde_json::Value {
    apply_binds(&app, binds);
    let binds = app.state::<Mutex<Hotkeys>>().lock().unwrap().binds.clone();
    save_binds(&app, &binds);
    hotkeys_json(&app)
}

/// While the page captures a new combo the current ones are released, or
/// pressing one would fire its action instead of reaching the page.
#[tauri::command]
fn pause_shortcuts(app: AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    app.state::<Mutex<Hotkeys>>().lock().unwrap().live.clear();
}

#[tauri::command]
fn resume_shortcuts(app: AppHandle) -> serde_json::Value {
    let binds = app.state::<Mutex<Hotkeys>>().lock().unwrap().binds.clone();
    apply_binds(&app, binds);
    hotkeys_json(&app)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Price alerts. Its init script swaps in window.Notification, so the
        // page can use the plain web API with no bundler.
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let hk = app.state::<Mutex<Hotkeys>>();
                    let action = hk.lock().unwrap().live.get(&shortcut.id()).copied();
                    if let Some(action) = action {
                        run_action(app, action);
                    }
                })
                .build(),
        )
        .manage(Mutex::new(Hotkeys::default()))
        .invoke_handler(tauri::generate_handler![
            get_autostart,
            set_autostart,
            get_shortcuts,
            set_shortcuts,
            pause_shortcuts,
            resume_shortcuts
        ])
        .setup(|app| {
            // Release builds only: `tauri dev` has no signed release to compare to.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = check_for_update(handle).await;
                });
            }

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

            let handle = app.handle().clone();
            let binds = load_binds(&handle);
            apply_binds(&handle, binds);
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
        .run(|app, event| match event {
            // `code` is None when the last window closes, Some(_) when app.exit()
            // is called. Block the first, let the second through.
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            // Give the combos back on the way out. (If the process is killed
            // instead, Windows frees them along with its window.)
            RunEvent::Exit => {
                let _ = app.global_shortcut().unregister_all();
            }
            _ => {}
        });
}
