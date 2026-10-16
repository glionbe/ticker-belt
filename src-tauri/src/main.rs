// Hides the console window that would otherwise open behind the widget.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_window_state::StateFlags;

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
        .run(tauri::generate_context!())
        .expect("error while running Ticker Belt");
}
