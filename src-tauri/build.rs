fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "surfaces_debug", "bridge_event", "surfaces_set", "surfaces_set_blur", "get_selection_hotkey", "set_selection_hotkey", "set_selection_clipboard", "get_hotkey_available", "get_selection_hotkey_available", "get_hotkey", "set_hotkey", "get_autostart", "set_autostart",
            "chat_models", "chat_model_choose", "chat_send",
            "chat_stop",
            "chat_new",
            "chat_status",
            "hide_main",
            "fit_window", "open_settings", "close_settings", "reset_position", "set_window_prefs", "chat_open", "chat_read_transcript",
            "open_external",
            "show_signin",
            "quit_app",
            "get_theme",
            "attachment_begin",
            "attachment_chunk",
            "attachment_finish",
            "attachment_remove",
            "media_load",
            "media_save",
            "image_copy",
        ]),
    ))
    .expect("build manifest");
}

