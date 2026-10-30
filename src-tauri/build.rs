fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bridge_event",
            "chat_send",
            "chat_stop",
            "chat_new",
            "chat_status",
            "hide_main",
            "open_external",
            "show_signin",
            "import_session_token",
            "get_theme",
            "begin_browser_signin",
            "cancel_browser_signin",
            "open_browser_helper",
            "disconnect_chatgpt",
        ]),
    ))
    .expect("build manifest");
}
