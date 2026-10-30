fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bridge_event",
            "chat_send",
            "chat_stop",
            "chat_new",
            "chat_status",
            "hide_main",
            "fit_window", "open_settings", "close_settings", "reset_position", "set_window_prefs", "chat_open",
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
