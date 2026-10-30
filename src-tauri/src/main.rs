#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    window::{Effect, EffectsBuilder},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
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
    hidden: Instant,
    background: bool,
    flight_id: Option<String>,
    last_progress: Instant,
    suspend_pending: bool,
    resume_generation: u64,
    suspended: bool,
    logged_in: bool,
    signin_was_logged_in: bool,
}
fn should_auto_return(foreground: bool, was_logged_in: bool, logged_in: bool) -> bool {
    foreground && !was_logged_in && logged_in
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
    if w.url().map_err(|e| e.to_string())?.host_str() != Some("chatgpt.com") {
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
    if test_profile().is_some() {
        return;
    }
    resume(app);
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(pos) = w.cursor_position() {
        if let Ok(Some(m)) = w.monitor_from_point(pos.x, pos.y) {
            let area = m.work_area();
            let Ok(size) = w.outer_size() else {
                return;
            };
            let margin = (16.0 * m.scale_factor()) as i32;
            let _ = w.set_position(tauri::PhysicalPosition::new(
                area.position.x + area.size.width as i32 - size.width as i32 - margin,
                area.position.y + area.size.height as i32 - size.height as i32 - margin,
            ));
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("qchat://shown", ());
}
#[tauri::command]
fn hide_main(app: tauri::AppHandle) {
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
    if w.url()
        .map(|u| u.host_str() != Some("chatgpt.com"))
        .unwrap_or(true)
    {
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
    let auto_return = {
        let state = app.state::<Host>();
        let mut a = state.0.lock().unwrap();
        if event["id"]
            .as_str()
            .is_some_and(|id| a.flight_id.as_deref() == Some(id))
        {
            match event["type"].as_str() {
                Some("start" | "delta") => a.last_progress = Instant::now(),
                Some("done" | "error") => a.flight_id = None,
                _ => (),
            }
        }
        if event["type"].as_str() == Some("status") {
            let logged_in = event["loggedIn"].as_bool() == Some(true);
            let back = should_auto_return(!a.background, a.signin_was_logged_in, logged_in);
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
    app.emit_to("main", "bridge", event)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
#[tauri::command]
fn chat_send(app: tauri::AppHandle, id: String, prompt: String) -> Result<(), String> {
    chat_page(&app)?;
    {
        let s = app.state::<Host>();
        let mut a = s.0.lock().unwrap();
        if a.flight_id.is_some() && a.last_progress.elapsed() < Duration::from_secs(120) {
            return Err("busy: A request is already in progress".into());
        }
        a.flight_id = Some(id.clone());
        a.last_progress = Instant::now();
    }
    let data = serde_json::to_string(&serde_json::json!({"id":id,"prompt":prompt}))
        .map_err(|e| e.to_string())?;
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
    eval(&app, "window.__qchat && window.__qchat.stop()")
}
#[tauri::command]
fn chat_new(app: tauri::AppHandle) -> Result<(), String> {
    eval(&app, "window.__qchat && window.__qchat.newChat()")
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
    #[cfg(debug_assertions)]
    if let Ok(port) = std::env::var("QCHAT_DEBUG_PORT") {
        if port.parse::<u16>().is_ok() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            );
        }
    }
    let builder = tauri::Builder::default();
    let builder = if test_profile().is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
    } else {
        builder
    };
    builder
 .manage(Host(Mutex::new(Activity{hidden:Instant::now(),background:true,flight_id:None,last_progress:Instant::now(),suspended:false,suspend_pending:false,resume_generation:0,logged_in:false,signin_was_logged_in:false})))

 .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{if event.state()==ShortcutState::Pressed{toggle(app);}}).build())
 .invoke_handler(tauri::generate_handler![bridge_event,chat_send,chat_stop,chat_new,chat_status,hide_main,open_external,show_signin,quit_app,get_theme])
 .setup(|app|{
 {let b=WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())); if let Some(p)=test_profile(){b.data_directory(p)}else{b}}.title("QChat").inner_size(420.,620.).min_inner_size(340.,420.).decorations(false).shadow(true).transparent(true).effects(EffectsBuilder::new().effect(Effect::Mica).build()).always_on_top(true).skip_taskbar(true).resizable(true).visible(false).build()?;
 {let b=WebviewWindowBuilder::new(app,"chatgpt",WebviewUrl::External("https://chatgpt.com/".parse()?)); if let Some(p)=test_profile(){b.data_directory(p)}else{b}}.title("QChat – ChatGPT sign-in").inner_size(1000.,760.).skip_taskbar(true).decorations(false).visible(false)
 .initialization_script("if(location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) window.__QCHAT_EMIT__ = (evt) => window.__TAURI_INTERNALS__.invoke('bridge_event', {event:evt});")
 .initialization_script(include_str!("../bridge/chatgpt-bridge.js")).build()?;
 background(app.handle());
 if test_profile().is_none() { if let Err(e) = app.global_shortcut().register("Alt+Q") { eprintln!("Alt+Q unavailable: {e}"); } }
 use tauri::{menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
 let items=[MenuItem::with_id(app,"show","Show QChat",true,None::<&str>)?,MenuItem::with_id(app,"new","New chat",true,None::<&str>)?,MenuItem::with_id(app,"signin","Sign in to ChatGPT…",true,None::<&str>)?,MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?];
 let menu=Menu::with_items(app,&items.iter().map(|x|x as &dyn tauri::menu::IsMenuItem<_>).collect::<Vec<_>>())?;
 TrayIconBuilder::new().icon(app.default_window_icon().ok_or("Window icon unavailable")?.clone()).tooltip("QChat").menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray,e|{if matches!(e,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){toggle(tray.app_handle());}}).on_menu_event(|app,e|match e.id().as_ref(){"show"=>show(app),"new"=>{let _=app.emit_to("main","qchat://new-chat",());show(app)},"signin"=>show_signin(app.clone()),"quit"=>quit_app(app.clone()),_=>()}).build(app)?;
 let handle=app.handle().clone();std::thread::spawn(move||loop{
 std::thread::sleep(Duration::from_secs(10));
 let hidden=handle.get_webview_window("main").and_then(|w| w.is_visible().ok()).map(|v| !v).unwrap_or(false);
 let (suspend,generation)={let s=handle.state::<Host>();let mut a=s.0.lock().unwrap();if a.flight_id.is_some()&&a.last_progress.elapsed()>=Duration::from_secs(120){a.flight_id=None;} let yes=hidden&&a.hidden.elapsed()>=Duration::from_secs(180)&&a.background&&a.flight_id.is_none()&&!a.suspended&&!a.suspend_pending;if yes{a.suspend_pending=true;}(yes,a.resume_generation)};
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
 .on_window_event(|w,e|{if let tauri::WindowEvent::CloseRequested{api,..}=e{api.prevent_close();if w.label()=="main"{hide_main(w.app_handle().clone());}else{background(w.app_handle());let _=chat_status(w.app_handle().clone());}}})
 .run(tauri::generate_context!()).expect("QChat runtime failed");
}
#[cfg(test)]
mod tests {
    use super::should_auto_return;
    #[test]
    fn auto_return_only_after_a_new_login_in_the_foreground() {
        assert!(should_auto_return(true, false, true));
        assert!(!should_auto_return(false, false, true));
        assert!(!should_auto_return(true, true, true));
        assert!(!should_auto_return(true, false, false));
    }
}
