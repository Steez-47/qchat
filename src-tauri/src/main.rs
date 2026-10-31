#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod snapshot;
mod clipboard;
mod selection;
mod surfaces;
mod media;
use media::{
    attachment_begin, attachment_chunk, attachment_finish, attachment_remove, media_load,
    media_save,
};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::ShortcutState;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
use windows::{
    core::{Interface, HSTRING},
    Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    UI::ViewManagement::{UIColorType, UISettings},
};
#[tauri::command]
fn get_theme() -> serde_json::Value {
    let hex = |c: windows::UI::Color| format!("#{:02X}{:02X}{:02X}", c.R, c.G, c.B);
    if let Ok((accent, light1, light2, dark1, bg)) = UISettings::new().and_then(|s| {
        Ok((
            s.GetColorValue(UIColorType::Accent)?,
            s.GetColorValue(UIColorType::AccentLight1)?,
            s.GetColorValue(UIColorType::AccentLight2)?,
            s.GetColorValue(UIColorType::AccentDark1)?,
            s.GetColorValue(UIColorType::Background)?,
        ))
    }) {
        let lum = (0.2126 * bg.R as f32 + 0.7152 * bg.G as f32 + 0.0722 * bg.B as f32) / 255.0;
        serde_json::json!({
            "accent": hex(accent),
            "accentLight1": hex(light1),
            "accentLight2": hex(light2),
            "accentDark1": hex(dark1),
            "dark": lum < 0.5,
        })
    } else {
        serde_json::json!({
            "accent": "#0078D4",
            "accentLight1": "#429CE3",
            "accentLight2": "#8AC8F0",
            "accentDark1": "#005A9E",
            "dark": true,
        })
    }
}
fn tool_window(w: &tauri::WebviewWindow, tool: bool) {
    if let Ok(hwnd) = w.hwnd() {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let style = if tool {
                (style | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize)
            } else {
                (style & !(WS_EX_TOOLWINDOW.0 as isize)) | WS_EX_APPWINDOW.0 as isize
            };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        }
    }
}
struct Activity {
    content: Option<f64>,
    hidden: Instant,
    background: bool,
    flight_id: Option<String>,
    last_progress: Instant,
    suspend_pending: bool,
    resume_generation: u64,
    suspended: bool,
    logged_in: bool,
    signin_was_logged_in: bool,
    anchor: Option<Anchor>,
    remember_position: bool,
    always_on_top: bool,
    positioned: Instant,
    save_due: Option<Instant>,
    save_generation: u64,
}
fn should_auto_return(
    foreground: bool,
    was_logged_in: bool,
    logged_in: bool,
    ready: bool,
    chat_route: bool,
) -> bool {
    foreground && !was_logged_in && logged_in && ready && chat_route
}
fn is_chat_url(url: &tauri::Url) -> bool {
    url.host_str() == Some("chatgpt.com")
        && !["/auth", "/login", "/signin"]
            .iter()
            .any(|route| url.path() == *route || url.path().starts_with(&format!("{route}/")))
}
struct Host(Mutex<Activity>);
fn resume(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("chatgpt") {
        let _ = w.with_webview(|w| unsafe {
            if let Ok(core) = w.controller().CoreWebView2() {
                if let Ok(v) = core.cast::<ICoreWebView2_3>() {
                    if let Err(e) = v.Resume() {
                        eprintln!("Resume: {e}");
                    }
                }
                let _ = w.controller().SetIsVisible(true);
                if let Ok(v) = core.cast::<ICoreWebView2_19>() {
                    let _ =
                        v.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
                }
            }
        });
    }
    let state = app.state::<Host>();
    let mut a = state.0.lock().unwrap();
    a.suspended = false;
    a.resume_generation = a.resume_generation.wrapping_add(1);
}
fn chat_page(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let w = app
        .get_webview_window("chatgpt")
        .ok_or("ChatGPT window unavailable")?;
    if !is_chat_url(&w.url().map_err(|e| e.to_string())?) {
        if !app.state::<Host>().0.lock().unwrap().background {
            return Err("not_ready: Finish signing in first".into());
        }
        w.navigate(tauri::Url::parse("https://chatgpt.com/").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        return Err("not_ready: ChatGPT page is reloading".into());
    }
    Ok(w)
}
fn eval(app: &tauri::AppHandle, js: &str) -> Result<(), String> {
    resume(app);
    chat_page(app)?.eval(js).map_err(|e| e.to_string())
}
fn show(app: &tauri::AppHandle) {
    snapshot::observe_foreground();
    if test_profile().is_some() && std::env::var("QCHAT_TEST_SHOW_MAIN").as_deref() != Ok("1") {
        // A real, visible window out of the user's sight, for native tests.
        if offscreen_test() {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_position(tauri::PhysicalPosition::new(-20000, -20000));
                let _ = w.show();
            }
            if let Some(w) = app.get_webview_window("chatgpt") {
                let _ = w.set_position(tauri::PhysicalPosition::new(-32000, -32000));
                let _ = w.show();
            }
        }
        return;
    }
    resume(app);
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    place_main(app, &w);
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("qchat://shown", ());
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Anchor { cx: i32, bottom: i32 }
#[derive(Clone, Copy)]
struct Rect { x: i32, y: i32, w: i32, h: i32 }
fn rect(m: &tauri::Monitor) -> Rect {
    let a = m.work_area();
    Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 }
}
fn nearest_anchor(a: Anchor, areas: &[Rect]) -> Option<(Anchor, Rect)> {
    areas.iter().map(|r| {
        let c = Anchor { cx: a.cx.clamp(r.x, r.x+r.w), bottom: a.bottom.clamp(r.y, r.y+r.h) };
        let dx = i64::from(c.cx)-i64::from(a.cx);
        let dy = i64::from(c.bottom)-i64::from(a.bottom);
        (dx*dx+dy*dy, c, *r)
    }).min_by_key(|v| v.0).map(|(_,a,r)| (a,r))
}
fn fit_geometry(a: Anchor, r: Rect, width: f64, height: f64, scale: f64) -> (Anchor, i32, i32) {
    fit_content(a, r, width, height, height, scale)
}
// The window can be taller than what it shows, and its empty top may hang off the screen, so only
// the visible content limits how high the bar can sit.
fn fit_content(a: Anchor, r: Rect, width: f64, height: f64, content: f64, scale: f64) -> (Anchor, i32, i32) {
    let min = (120.0*scale).round() as i32;
    let gap = (12.0*scale).round() as i32;
    let w = ((width*scale).round() as i32).max(min).min((r.w-gap).max(1));
    let h = ((height*scale).round() as i32).max(min).min((r.h-gap).max(1));
    // Keep the requested content height when there is too little room above the
    // bar. Move it down into the work area instead of cropping the command menu.
    let visible = ((content*scale).round() as i32).clamp(min, h);
    let bottom = a.bottom.clamp(r.y+visible, r.y+r.h);
    let cx = a.cx.clamp(r.x+w/2, r.x+r.w-(w-w/2));
    (Anchor { cx, bottom }, w, h)
}
fn position(w: &tauri::WebviewWindow, a: Anchor, width: i32, height: i32) {
    w.app_handle().state::<Host>().0.lock().unwrap().positioned = Instant::now();
    let _ = w.set_position(tauri::PhysicalPosition::new(a.cx-width/2, a.bottom-height));
}
fn cursor_monitor(w: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    w.cursor_position().ok().and_then(|p| w.monitor_from_point(p.x,p.y).ok().flatten()).or_else(|| w.current_monitor().ok().flatten())
}
fn place_main(app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    let Some(m) = cursor_monitor(w) else { return };
    let r = rect(&m);
    let saved = { let s=app.state::<Host>(); let a=s.0.lock().unwrap(); if a.remember_position { a.anchor } else { None } };
    let areas: Vec<_> = w.available_monitors().unwrap_or_default().iter().map(rect).collect();
    let (anchor,r) = saved.and_then(|a| nearest_anchor(a,&areas)).unwrap_or((Anchor { cx:r.x+r.w/2, bottom:r.y+r.h-(r.h as f64*0.06) as i32 },r));
    if let Ok(size)=w.outer_size() {
        let scale=w.scale_factor().unwrap_or(1.0);
        let content=app.state::<Host>().0.lock().unwrap().content.unwrap_or(size.height as f64/scale);
        let (anchor,width,height)=fit_content(anchor,r,size.width as f64/scale,size.height as f64/scale,content,scale);
        let _=w.set_size(tauri::PhysicalSize::new(width as u32,height as u32));
        app.state::<Host>().0.lock().unwrap().anchor=Some(anchor);
        position(w,anchor,width,height);
    }
}
#[tauri::command]
fn fit_window(app: tauri::AppHandle, width: f64, height: f64, content: Option<f64>) {
    if !width.is_finite() || !height.is_finite() || offscreen_test() { return }
    let content = content.filter(|c| c.is_finite()).unwrap_or(height);
    app.state::<Host>().0.lock().unwrap().content = Some(content);
    let Some(w)=app.get_webview_window("main") else { return };
    let (Ok(Some(m)),Ok(old),Ok(pos))=(w.current_monitor(),w.outer_size(),w.outer_position()) else { return };
    let saved=app.state::<Host>().0.lock().unwrap().anchor;
    // Sizing before the first show must not turn the hidden window's default position into its home.
    if saved.is_none() && !w.is_visible().unwrap_or(false) {
        let (_,width,height)=fit_content(Anchor { cx:pos.x+old.width as i32/2,bottom:pos.y+old.height as i32 },rect(&m),width,height,content,w.scale_factor().unwrap_or(1.0));
        let _=w.set_size(tauri::PhysicalSize::new(width as u32,height as u32));
        return;
    }
    let anchor=saved.unwrap_or(Anchor { cx:pos.x+old.width as i32/2,bottom:pos.y+old.height as i32 });
    let (anchor,width,height)=fit_content(anchor,rect(&m),width,height,content,w.scale_factor().unwrap_or(1.0));
    app.state::<Host>().0.lock().unwrap().anchor=Some(anchor);
    let unchanged=(width-old.width as i32).abs()<=1 && (height-old.height as i32).abs()<=1 && (pos.y+old.height as i32-anchor.bottom).abs()<=1;
    if unchanged { return }
    // Size and position in one call: two calls show a frame with the old bottom edge.
    app.state::<Host>().0.lock().unwrap().positioned=Instant::now();
    surfaces::place_window(&w,anchor.cx-width/2,anchor.bottom-height,width,height);
}
fn capture_anchor(app: &tauri::AppHandle) {
    if let Some(w)=app.get_webview_window("main") {
        if let (Ok(p),Ok(s))=(w.outer_position(),w.outer_size()) {
            let state=app.state::<Host>(); let mut a=state.0.lock().unwrap();
            a.anchor=Some(Anchor { cx:p.x+s.width as i32/2,bottom:p.y+s.height as i32 });
            a.save_generation=a.save_generation.wrapping_add(1);
            a.save_due=Some(Instant::now()+Duration::from_millis(400));
        }
    }
}
#[tauri::command]
fn set_window_prefs(app: tauri::AppHandle, always_on_top: bool, remember_position: bool) {
    { let s=app.state::<Host>(); let mut a=s.0.lock().unwrap(); a.always_on_top=always_on_top; a.remember_position=remember_position; }
    if let Some(w)=app.get_webview_window("main") { let _=w.set_always_on_top(always_on_top); }
}
#[tauri::command]
fn reset_position(app: tauri::AppHandle) {
    { let s=app.state::<Host>(); let mut a=s.0.lock().unwrap(); a.anchor=None; a.save_due=None; a.save_generation=a.save_generation.wrapping_add(1); }
    if let Ok(dir)=app.path().app_data_dir() { let _=std::fs::remove_file(dir.join("window-state.json")); }
    if let Some(w)=app.get_webview_window("main") { place_main(&app,&w); }
}
#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(),String> {
    // WebView2 creation must not block a synchronous command or tray event handler.
    tauri::async_runtime::spawn_blocking(move || open_settings_window(app))
        .await.map_err(|e|e.to_string())?
}
fn open_settings_window(app: tauri::AppHandle) -> Result<(),String> {
    static SETTINGS: Mutex<()> = Mutex::new(());
    let _guard=SETTINGS.lock().map_err(|e|e.to_string())?;
    let profile=test_profile();
    let offscreen=profile.is_some() && std::env::var("QCHAT_TEST_SHOW_SETTINGS").as_deref()!=Ok("1");
    let w=if let Some(w)=app.get_webview_window("settings") { w } else {
        let b=WebviewWindowBuilder::new(&app,"settings",WebviewUrl::App("settings.html".into()));
        let b=if let Some(p)=profile.as_ref(){b.data_directory(p.clone())}else{b};
        b.title("QChat settings").inner_size(620.,720.).decorations(false).transparent(true).shadow(false).resizable(false).always_on_top(true).skip_taskbar(true).visible(false).build().map_err(|e|e.to_string())?
    };
    if offscreen {
        w.set_position(tauri::PhysicalPosition::new(-32000,-32000)).map_err(|e|e.to_string())?;
    } else if let Some(main)=app.get_webview_window("main") {
        let m=if main.is_visible().unwrap_or(false) { main.current_monitor().ok().flatten() } else { cursor_monitor(&main) };
        if let (Some(m),Ok(s))=(m,w.outer_size()) { let r=rect(&m); let _=w.set_position(tauri::PhysicalPosition::new(r.x+(r.w-s.width as i32)/2,r.y+(r.h-s.height as i32)/2)); }
    }
    w.show().map_err(|e|e.to_string())?;
    if offscreen { return Ok(()) }
    w.set_focus().map_err(|e|e.to_string())
}
#[tauri::command]
fn close_settings(window: tauri::WebviewWindow) -> Result<(),String> {
    if window.label()!="settings" { return Err("not_allowed".into()) }
    window.destroy().map_err(|e|e.to_string())
}
#[tauri::command]
fn hide_main(app: tauri::AppHandle) {
    capture_anchor(&app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    app.state::<Host>().0.lock().unwrap().hidden = Instant::now();
}
fn toggle(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        hide_main(app.clone());
    } else {
        show(app);
    }
}
fn background(app: &tauri::AppHandle) {
    if test_profile().is_some() {
        return;
    }
    let Some(w) = app.get_webview_window("chatgpt") else {
        return;
    };
    let _ = w.set_skip_taskbar(true);
    let _ = w.set_decorations(false);
    tool_window(&w, true);
    let _ = w.set_position(tauri::PhysicalPosition::new(-32000, -32000));
    let _ = w.show();
    if w.url().map(|u| !is_chat_url(&u)).unwrap_or(true) {
        if let Ok(url) = tauri::Url::parse("https://chatgpt.com/") {
            let _ = w.navigate(url);
        }
    }
    app.state::<Host>().0.lock().unwrap().background = true;
}
#[tauri::command]
fn show_signin(app: tauri::AppHandle) {
    if test_profile().is_some() {
        return;
    }
    resume(&app);
    hide_main(app.clone());
    let Some(w) = app.get_webview_window("chatgpt") else {
        return;
    };
    let logged_in = {
        let state = app.state::<Host>();
        let mut a = state.0.lock().unwrap();
        a.background = false;
        a.signin_was_logged_in = a.logged_in;
        a.logged_in
    };
    if !logged_in {
        if let Ok(url) = tauri::Url::parse("https://chatgpt.com/auth/login") {
            let _ = w.navigate(url);
        }
    }
    let _ = w.set_decorations(true);
    let _ = w.set_skip_taskbar(false);
    tool_window(&w, false);
    let _ = w.set_size(tauri::LogicalSize::new(1000, 760));
    if let Ok(pos) = w.cursor_position() {
        if let Ok(Some(m)) = w.monitor_from_point(pos.x, pos.y) {
            let a = m.work_area();
            let Ok(s) = w.outer_size() else {
                return;
            };
            let _ = w.set_position(tauri::PhysicalPosition::new(
                a.position.x + (a.size.width as i32 - s.width as i32) / 2,
                a.position.y + (a.size.height as i32 - s.height as i32) / 2,
            ));
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
}
#[tauri::command]
fn bridge_event(app: tauri::AppHandle, event: serde_json::Value) -> Result<(), String> {
    if matches!(event["type"].as_str(), Some("done" | "error")) {
        if let Some(id) = event["id"].as_str() {
            media::finish_turn(&app, id);
        }
    }
    let auto_return = {
        let state = app.state::<Host>();
        let mut a = state.0.lock().unwrap();
        if event["id"]
            .as_str()
            .is_some_and(|id| a.flight_id.as_deref() == Some(id))
        {
            match event["type"].as_str() {
                Some("start" | "delta" | "media" | "progress" | "image_progress" | "activity") => {
                    a.last_progress = Instant::now()
                }
                Some("done" | "error") => a.flight_id = None,
                _ => (),
            }
        }
        if event["type"].as_str() == Some("status") {
            let logged_in = event["loggedIn"].as_bool() == Some(true);
            let ready = event["ready"].as_bool() == Some(true);
            let chat_route = event["url"]
                .as_str()
                .and_then(|u| tauri::Url::parse(u).ok())
                .is_some_and(|u| is_chat_url(&u));
            let back = should_auto_return(
                !a.background,
                a.signin_was_logged_in,
                logged_in,
                ready,
                chat_route,
            );
            a.logged_in = logged_in;
            back
        } else {
            false
        }
    };
    if auto_return {
        background(&app);
        show(&app);
    }
    for label in ["main", "settings"] {
        if let Some(w)=app.get_webview_window(label) { let _=w.emit("bridge", &event); }
    }
    Ok(())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    media::clear_all(&app);
    app.exit(0);
}
fn validate_reasoning_effort(value: Option<&str>) -> Result<(), String> {
    match value {
        None | Some("low" | "medium" | "high") => Ok(()),
        _ => Err("invalid_reasoning_effort: Choose low, medium or high reasoning.".into()),
    }
}

#[cfg(test)]
mod reasoning_tests {
    #[test]
    fn validates_reasoning_before_send() {
        for value in [None, Some("low"), Some("medium"), Some("high")] {
            assert!(super::validate_reasoning_effort(value).is_ok());
        }
        for value in ["", "HIGH", "auto", " low"] {
            assert!(super::validate_reasoning_effort(Some(value)).is_err());
        }
    }
}

#[tauri::command]
async fn chat_send(
    app: tauri::AppHandle,
    id: String,
    prompt: String,
    attachment_ids: Option<Vec<String>>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    validate_reasoning_effort(reasoning_effort.as_deref())?;
    chat_page(&app)?;
    resume(&app);
    {
        let s = app.state::<Host>();
        let mut a = s.0.lock().unwrap();
        if a.flight_id.is_some() && a.last_progress.elapsed() < Duration::from_secs(600) {
            return Err("busy: A request is already in progress".into());
        }
        a.flight_id = Some(id.clone());
        a.last_progress = Instant::now();
    }
    let attachment_ids = attachment_ids.unwrap_or_default();
    if let Err(error) = media::attach(&app, &attachment_ids, &id).await {
        let state = app.state::<Host>();
        let mut a = state.0.lock().unwrap();
        if a.flight_id.as_deref() == Some(&id) {
            a.flight_id = None;
        }
        return Err(error);
    }
    if app.state::<Host>().0.lock().unwrap().flight_id.as_deref() != Some(&id) {
        if !attachment_ids.is_empty() {
            let _ = media::evaluate(
                &app,
                format!(
                    "window.__qchat.cancelAttachmentSelection({})",
                    attachment_ids.len()
                ),
            )
            .await;
        }
        return Err("Send was cancelled".into());
    }
    let data = serde_json::to_string(
        &serde_json::json!({"id":id,"prompt":prompt,"attachmentCount":attachment_ids.len(),"reasoningEffort":reasoning_effort}),
    )
    .map_err(|e| e.to_string())?;
    media::track_turn(&app, &id, &attachment_ids);
    let result = eval(&app,&format!("(()=>{{const p={data}; if(window.__qchat) window.__qchat.send(p); else window.__QCHAT_EMIT__({{type:'error',id:p.id,code:'not_ready',message:'ChatGPT page not loaded yet'}});}})()"));
    if result.is_err() {
        let state = app.state::<Host>();
        let mut a = state.0.lock().unwrap();
        if a.flight_id.as_deref() == Some(&id) {
            a.flight_id = None;
        }
    }
    result
}
#[tauri::command]
fn chat_stop(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Host>().0.lock().unwrap().flight_id = None;
    eval(&app, "window.__qchat && window.__qchat.stop()")
}
#[tauri::command]
fn chat_models(app: tauri::AppHandle) -> Result<(), String> { eval(&app, "window.__qchat && window.__qchat.listModels()") }
#[tauri::command]
fn chat_model_choose(app: tauri::AppHandle, id: String) -> Result<(), String> { eval(&app, &format!("window.__qchat && window.__qchat.chooseModel({})", serde_json::to_string(&id).map_err(|e|e.to_string())?)) }
#[tauri::command]
fn chat_new(app: tauri::AppHandle, preserve_uploads: Option<bool>, temporary: Option<bool>) -> Result<(), String> {
    if preserve_uploads.unwrap_or(false) { media::clear_reply_media(&app); }
    else { media::clear_all(&app); }
    app.state::<Host>().0.lock().unwrap().flight_id = None;
    eval(&app, if temporary.unwrap_or(false) { "window.__qchat && window.__qchat.newChat({temporary:true})" } else { "window.__qchat && window.__qchat.newChat()" })
}
#[tauri::command]
fn chat_open(app: tauri::AppHandle, conversation_id: String, preserve_uploads: Option<bool>) -> Result<(), String> {
    if !(8..=80).contains(&conversation_id.len()) || !conversation_id.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'_' || c==b'-') { return Err("invalid_id".into()) }
    if preserve_uploads.unwrap_or(false) { media::clear_reply_media(&app); }
    else { media::clear_all(&app); }
    app.state::<Host>().0.lock().unwrap().flight_id=None;
    eval(&app,&format!("window.__qchat && window.__qchat.openConversation({})",serde_json::to_string(&conversation_id).map_err(|e|e.to_string())?))
}
#[tauri::command]
fn chat_read_transcript(app: tauri::AppHandle, conversation_id: String) -> Result<(), String> {
    if !(8..=80).contains(&conversation_id.len()) || !conversation_id.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'_' || c==b'-') { return Err("invalid_id".into()) }
    eval(&app,&format!("window.__qchat && window.__qchat.readConversation({})",serde_json::to_string(&conversation_id).map_err(|e|e.to_string())?))
}
#[tauri::command]
fn chat_list_conversations(app: tauri::AppHandle, offset: u32) -> Result<(), String> {
    eval(&app,&format!("window.__qchat && window.__qchat.listConversations({offset})"))
}
#[tauri::command]
fn chat_status(app: tauri::AppHandle) -> Result<(), String> {
    eval(&app, "window.__qchat && window.__qchat.status()")
}
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if test_profile().is_some() {
        return Ok(());
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https URLs are allowed".into());
    }
    let result = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(parsed.as_str()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        Err("Unable to open default browser".into())
    } else {
        Ok(())
    }
}
fn offscreen_test() -> bool {
    test_profile().is_some() && std::env::var("QCHAT_TEST_SHOW_MAIN").as_deref() == Ok("offscreen")
}
fn test_profile() -> Option<std::path::PathBuf> {
    if cfg!(debug_assertions) && std::env::var("QCHAT_TEST_MODE").as_deref() == Ok("1") {
        let p = std::path::PathBuf::from(
            std::env::var_os("QCHAT_TEST_PROFILE").expect("Test profile required"),
        );
        assert!(p.is_absolute(), "Absolute test profile required");
        Some(p)
    } else {
        None
    }
}
fn main() {
    surfaces::remember_launch_foreground();
    #[cfg(debug_assertions)]
    if let Ok(port) = std::env::var("QCHAT_DEBUG_PORT") {
        if port.parse::<u16>().is_ok() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            );
        }
    }
    let builder = tauri::Builder::default()
        .manage(selection::State::default()).manage(media::MediaState::default()).manage(surfaces::State::default())
        .register_asynchronous_uri_scheme_protocol("qchat-media", |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_owned();
            std::thread::spawn(move || responder.respond(media::protocol(&app, &label, request)));
        });
    let builder = if test_profile().is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
    } else {
        builder
    };
    builder
 .manage(Host(Mutex::new(Activity { content: None, hidden:Instant::now(),background:true,flight_id:None,last_progress:Instant::now(),suspended:false,suspend_pending:false,resume_generation:0,logged_in:false,signin_was_logged_in:false,anchor:None,remember_position:true,always_on_top:true,positioned:Instant::now(),save_due:None,save_generation:0})))

 .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,shortcut,event|{if event.state()==ShortcutState::Pressed{if selection::matches(app,shortcut) { selection::activate(app); } else { toggle(app); }}}).build())
 .invoke_handler(tauri::generate_handler![surfaces::surfaces_debug,surfaces::surfaces_set,surfaces::surfaces_set_blur,chat_list_conversations,surfaces::get_hotkey, surfaces::get_hotkey_available, selection::get_selection_hotkey_available,surfaces::set_hotkey,selection::get_selection_hotkey,selection::set_selection_hotkey,selection::set_selection_clipboard,surfaces::get_autostart,surfaces::set_autostart,bridge_event,chat_models,chat_model_choose,chat_send,chat_stop,chat_new,chat_status,hide_main,fit_window,open_settings,close_settings,reset_position,set_window_prefs,chat_open,chat_read_transcript,open_external,show_signin,quit_app,get_theme,attachment_begin,attachment_chunk,attachment_finish,attachment_remove,media_load,media_save,clipboard::image_copy,snapshot::snapshot_capture])
 .setup(|app|{
 app.add_capability(r#"{"identifier":"selection-settings","windows":["settings"],"permissions":["allow-get-selection-hotkey","allow-set-selection-hotkey","allow-get-hotkey","allow-set-hotkey","allow-get-autostart","allow-set-autostart"]}"#)?;
 if let Ok(dir)=app.path().app_data_dir() {
   if let Ok(data)=std::fs::read(dir.join("window-state.json")) { app.state::<Host>().0.lock().unwrap().anchor=serde_json::from_slice(&data).ok(); }
 }
 let saver=app.handle().clone();
 std::thread::spawn(move || loop {
   std::thread::sleep(Duration::from_millis(100));
   let state=saver.state::<Host>();
   let mut a=state.0.lock().unwrap();
   if a.save_due.is_some_and(|due| Instant::now()>=due) {
     a.save_due=None;
     if a.remember_position {
       if let (Some(anchor),Ok(dir))=(a.anchor,saver.path().app_data_dir()) {
         let _=std::fs::create_dir_all(&dir);
         if let Ok(data)=serde_json::to_vec(&anchor) {
           let tmp=dir.join("window-state.json.tmp");
           if std::fs::write(&tmp,data).is_ok() { let _=std::fs::rename(tmp,dir.join("window-state.json")); }
         }
       }
     }
   }
 });
 {let b=WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())); if let Some(p)=test_profile(){b.data_directory(p)}else{b}}.title("QChat").inner_size(480.,110.).min_inner_size(120.,60.).decorations(false).shadow(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).disable_drag_drop_handler().visible(false).build()?;
 {let b=WebviewWindowBuilder::new(app,"chatgpt",WebviewUrl::External("https://chatgpt.com/".parse()?)); if let Some(p)=test_profile(){b.data_directory(p)}else{b}}.title("QChat - ChatGPT sign-in").inner_size(1000.,760.).skip_taskbar(true).decorations(false).visible(false)
 .initialization_script("if(location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) window.__QCHAT_EMIT__ = (evt) => window.__TAURI_INTERNALS__.invoke('bridge_event', {event:evt});")
 .initialization_script(include_str!("../bridge/chatgpt-bridge.js"))
 .on_download(|webview,event|media::on_download(webview.app_handle(),event)).build()?;
 background(app.handle());
 surfaces::start(app.handle());
 selection::start(app.handle());
 use tauri::{menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
 let items=[MenuItem::with_id(app,"show","Show QChat",true,None::<&str>)?,MenuItem::with_id(app,"new","New chat",true,None::<&str>)?,MenuItem::with_id(app,"settings","Settings\u{2026}",true,None::<&str>)?,MenuItem::with_id(app,"signin","Sign in to ChatGPT\u{2026}",true,None::<&str>)?,MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?];
 let menu=Menu::with_items(app,&items.iter().map(|x|x as &dyn tauri::menu::IsMenuItem<_>).collect::<Vec<_>>())?;
 TrayIconBuilder::new().icon(app.default_window_icon().ok_or("Window icon unavailable")?.clone()).tooltip("QChat").menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray,e|{if matches!(e,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){toggle(tray.app_handle());}}).on_menu_event(|app,e|match e.id().as_ref(){"show"=>show(app),"new"=>{let _=app.emit_to("main","qchat://new-chat",());show(app)},"settings"=>{let app=app.clone();tauri::async_runtime::spawn(async move {if let Err(e)=open_settings(app).await {eprintln!("Open settings: {e}");}});},"signin"=>show_signin(app.clone()),"quit"=>quit_app(app.clone()),_=>()}).build(app)?;
 if test_profile().is_some() { show(app.handle()); }
 let handle=app.handle().clone();std::thread::spawn(move||loop{
 std::thread::sleep(Duration::from_secs(10));
 let hidden=handle.get_webview_window("main").and_then(|w| w.is_visible().ok()).map(|v| !v).unwrap_or(false);
 let (suspend,generation)={let s=handle.state::<Host>();let mut a=s.0.lock().unwrap();if a.flight_id.is_some()&&a.last_progress.elapsed()>=Duration::from_secs(600){a.flight_id=None;} let yes=hidden&&a.hidden.elapsed()>=Duration::from_secs(180)&&a.background&&a.flight_id.is_none()&&!a.suspended&&!a.suspend_pending;if yes{a.suspend_pending=true;}(yes,a.resume_generation)};
 if suspend {
   if let Some(w)=handle.get_webview_window("chatgpt") {
     let callback_handle=handle.clone();
     let result=w.with_webview(move |w| unsafe {
       let result=(|| -> windows::core::Result<()> {
         let core=w.controller().CoreWebView2()?;
         w.controller().SetIsVisible(false)?;
         if let Ok(memory)=core.cast::<ICoreWebView2_19>() {
           let _=memory.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
         }
         let v=core.cast::<ICoreWebView2_3>()?;
         let resume_view=v.clone();
         let controller=w.controller().clone();
         let resume_core=core.clone();
         let callback_handle=callback_handle.clone();
         let callback=webview2_com::TrySuspendCompletedHandler::create(Box::new(move |result,success| {
           let state=callback_handle.state::<Host>();
           let mut a=state.0.lock().unwrap();
           a.suspend_pending=false;
           a.suspended=result.is_ok() && success;
           if a.resume_generation != generation {
             let _=resume_view.Resume();
             let _=controller.SetIsVisible(true);
             if let Ok(memory)=resume_core.cast::<ICoreWebView2_19>() {
               let _=memory.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
             }
             a.suspended=false;
           }
           if let Err(e)=result { eprintln!("TrySuspend callback: {e}"); }
           Ok(())
         }));
         v.TrySuspend(&callback)?;
         Ok(())
       })();
       if let Err(e)=result {
         callback_handle.state::<Host>().0.lock().unwrap().suspend_pending=false;
         eprintln!("TrySuspend: {e}");
       }
     });
     if result.is_err() { handle.state::<Host>().0.lock().unwrap().suspend_pending=false; }
   } else { handle.state::<Host>().0.lock().unwrap().suspend_pending=false; }
 }
 });Ok(())
 })
 .on_window_event(|w,e|{
   if w.label()=="settings" {
     if matches!(e,tauri::WindowEvent::Destroyed) { let _=w.app_handle().emit_to("main","qchat://settings-closed",()); }
     return;
   }
   if w.label()=="main" && matches!(e,tauri::WindowEvent::Moved(_)) {
     let own=w.app_handle().state::<Host>().0.lock().unwrap().positioned.elapsed()<Duration::from_millis(150);
     // Only a visible window can be moved by the user. Sizing a hidden one must not make
     // the system's default spot its home.
     if !own && w.is_visible().unwrap_or(false) { capture_anchor(w.app_handle()); }
   }
   if let tauri::WindowEvent::CloseRequested{api,..}=e { api.prevent_close(); if w.label()=="main" { hide_main(w.app_handle().clone()); } else { background(w.app_handle()); let _=chat_status(w.app_handle().clone()); } }
 })
 .run(tauri::generate_context!()).expect("QChat runtime failed");
}
#[cfg(test)]
mod tests {
    use super::{is_chat_url, should_auto_return, Anchor, Rect, nearest_anchor, fit_geometry};
    #[test]
    fn a_tall_window_only_needs_room_for_its_content() {
        let r=Rect{x:0,y:0,w:1200,h:900};
        // High on the screen, tall reserved window, short content: the bar stays where it was put.
        let (a,w,h)=super::fit_content(Anchor{cx:600,bottom:200},r,700.,600.,100.,1.);
        assert_eq!((a.bottom,w,h),(200,700,600));
        // Content taller than the space above the bar brings it down, as before.
        let (a,_,_)=super::fit_content(Anchor{cx:600,bottom:200},r,700.,600.,500.,1.);
        assert_eq!(a.bottom,500);
    }
    #[test]
    fn anchor_uses_containing_or_nearest_work_area() {
        let areas=[Rect{x:-1000,y:0,w:1000,h:800},Rect{x:0,y:0,w:1200,h:900}];
        let a=Anchor{cx:-400,bottom:700};
        assert_eq!(nearest_anchor(a,&areas).unwrap().0,a);
        assert_eq!(nearest_anchor(Anchor{cx:1400,bottom:1000},&areas).unwrap().0,Anchor{cx:1200,bottom:900});
        assert!(nearest_anchor(a,&[]).is_none());
    }
    #[test]
    fn fit_preserves_bottom_and_center_and_stays_in_work_area() {
        let r=Rect{x:100,y:50,w:1000,h:800};
        let (a,w,h)=fit_geometry(Anchor{cx:600,bottom:750},r,480.,200.,1.);
        assert_eq!((a,w,h),(Anchor{cx:600,bottom:750},480,200));
        let (a,w,h)=fit_geometry(Anchor{cx:1050,bottom:400},r,2000.,2000.,1.);
        assert_eq!(w,988); assert_eq!(h,788);
        assert!(a.cx-w/2>=r.x && a.cx+(w-w/2)<=r.x+r.w);
        assert_eq!(a.bottom-h,r.y);
        let (_,w,h)=fit_geometry(Anchor{cx:600,bottom:800},r,1.,1.,2.);
        assert_eq!((w,h),(240,240));
    }
    #[test]
    fn fit_moves_bar_down_to_keep_command_menu_above_it_visible() {
        for scale in [1.0_f64, 1.5, 2.] {
            let r=Rect{x:-1920,y:0,w:1920,h:1080};
            let requested=(310.0*scale).round() as i32;
            let (a,w,h)=fit_geometry(Anchor{cx:-960,bottom:200},r,536.,310.,scale);
            assert_eq!(h,requested);
            assert_eq!(a.bottom-h,r.y);
            assert!(a.bottom<=r.y+r.h && a.cx-w/2>=r.x);
        }
    }
    #[test]
    fn auto_return_only_after_a_new_login_in_the_foreground() {
        assert!(should_auto_return(true, false, true, true, true));
        assert!(!should_auto_return(false, false, true, true, true));
        assert!(!should_auto_return(true, true, true, true, true));
        assert!(!should_auto_return(true, false, false, true, true));
        assert!(!should_auto_return(true, false, true, false, true));
        assert!(!should_auto_return(true, false, true, true, false));
    }
    #[test]
    fn auth_routes_are_not_chat_pages() {
        for url in [
            "https://chatgpt.com/auth",
            "https://chatgpt.com/auth/login",
            "https://chatgpt.com/login",
            "https://chatgpt.com/signin/callback",
            "https://auth.openai.com/",
        ] {
            assert!(!is_chat_url(&url.parse().unwrap()));
        }
        for url in ["https://chatgpt.com/", "https://chatgpt.com/c/synthetic"] {
            assert!(is_chat_url(&url.parse().unwrap()));
        }
    }
}

