#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
use windows::{
    core::{Interface, HSTRING},
    Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};
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
    flight: bool,
    awaiting_event: bool,
    last: Instant,
    suspended: bool,
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
    app.state::<Host>().0.lock().unwrap().suspended = false;
}
fn eval(app: &tauri::AppHandle, js: &str) -> Result<(), String> {
    resume(app);
    app.get_webview_window("chatgpt")
        .ok_or("ChatGPT window unavailable")?
        .eval(js)
        .map_err(|e| e.to_string())
}
fn show(app: &tauri::AppHandle) {
    resume(app);
    let w = app.get_webview_window("main").unwrap();
    if let Ok(pos) = w.cursor_position() {
        if let Ok(Some(m)) = w.monitor_from_point(pos.x, pos.y) {
            let area = m.work_area();
            let size = w.outer_size().unwrap();
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
    let _ = app.get_webview_window("main").unwrap().hide();
    app.state::<Host>().0.lock().unwrap().hidden = Instant::now();
}
fn toggle(app: &tauri::AppHandle) {
    let w = app.get_webview_window("main").unwrap();
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        hide_main(app.clone());
    } else {
        show(app);
    }
}
fn background(app: &tauri::AppHandle) {
    let w = app.get_webview_window("chatgpt").unwrap();
    let _ = w.set_skip_taskbar(true);
    let _ = w.set_decorations(false);
    tool_window(&w, true);
    let _ = w.set_position(tauri::PhysicalPosition::new(-32000, -32000));
    let _ = w.show();
    app.state::<Host>().0.lock().unwrap().background = true;
}
#[tauri::command]
fn show_signin(app: tauri::AppHandle) {
    resume(&app);
    let w = app.get_webview_window("chatgpt").unwrap();
    let _ = w.set_decorations(true);
    let _ = w.set_skip_taskbar(false);
    tool_window(&w, false);
    let _ = w.set_size(tauri::LogicalSize::new(1000, 760));
    if let Ok(pos) = w.cursor_position() {
        if let Ok(Some(m)) = w.monitor_from_point(pos.x, pos.y) {
            let a = m.work_area();
            let s = w.outer_size().unwrap();
            let _ = w.set_position(tauri::PhysicalPosition::new(
                a.position.x + (a.size.width as i32 - s.width as i32) / 2,
                a.position.y + (a.size.height as i32 - s.height as i32) / 2,
            ));
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    app.state::<Host>().0.lock().unwrap().background = false;
}
#[tauri::command]
fn bridge_event(app: tauri::AppHandle, event: serde_json::Value) -> Result<(), String> {
    {
        let state = app.state::<Host>();
        let mut a = state.0.lock().unwrap();
        a.awaiting_event = false;
        match event["type"].as_str() {
            Some("start") => a.flight = true,
            Some("done" | "error") => a.flight = false,
            _ => (),
        }
    }
    app.emit_to("main", "bridge", event)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn chat_send(app: tauri::AppHandle, id: String, prompt: String) -> Result<(), String> {
    {
        let s = app.state::<Host>();
        let mut a = s.0.lock().unwrap();
        a.flight = true;
        a.awaiting_event = true;
        a.last = Instant::now();
    }
    let data = serde_json::to_string(&serde_json::json!({"id":id,"prompt":prompt}))
        .map_err(|e| e.to_string())?;
    eval(&app,&format!("(()=>{{const p={data}; if(window.__qchat) window.__qchat.send(p); else window.__QCHAT_EMIT__({{type:'error',id:p.id,code:'not_ready',message:'ChatGPT page not loaded yet'}});}})()"))
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
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https URLs are allowed".into());
    }
    let result = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(url),
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
#[tauri::command]
async fn import_session_token(app: tauri::AppHandle, cookie: String) -> Result<(), String> {
    let raw = cookie
        .trim()
        .strip_prefix("Cookie:")
        .unwrap_or(cookie.trim())
        .trim();
    if raw.is_empty() {
        return Err("Cookie is empty".into());
    }
    let pairs: Vec<(String, String)> = if raw.contains('=') {
        raw.split(';')
            .map(|p| {
                let (n, v) = p.trim().split_once('=').ok_or("Invalid cookie pair")?;
                if n.is_empty() || v.is_empty() {
                    return Err("Empty cookie name or value");
                }
                Ok((n.to_string(), v.to_string()))
            })
            .collect::<Result<_, _>>()?
    } else {
        vec![("__Secure-next-auth.session-token".into(), raw.into())]
    };
    resume(&app);
    let (tx, rx) = std::sync::mpsc::channel();
    app.get_webview_window("chatgpt")
        .ok_or("ChatGPT window unavailable")?
        .with_webview(move |w| {
            let result = (|| -> windows::core::Result<()> {
                unsafe {
                    let core = w.controller().CoreWebView2()?;
                    let manager = core.cast::<ICoreWebView2_2>()?.CookieManager()?;
                    for (name, value) in pairs {
                        let c = manager.CreateCookie(
                            &HSTRING::from(name),
                            &HSTRING::from(value),
                            &HSTRING::from(".chatgpt.com"),
                            &HSTRING::from("/"),
                        )?;
                        c.SetIsSecure(true)?;
                        c.SetIsHttpOnly(true)?;
                        manager.AddOrUpdateCookie(&c)?;
                    }
                    core.Reload()?;
                    Ok(())
                }
            })()
            .map_err(|e| format!("WebView2 cookie import: {e}"));
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}
fn main() {
    if let Ok(port) = std::env::var("QCHAT_DEBUG_PORT") {
        if port.parse::<u16>().is_ok() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            );
        }
    }
    tauri::Builder::default()
 .manage(Host(Mutex::new(Activity{hidden:Instant::now(),background:true,flight:false,awaiting_event:false,last:Instant::now(),suspended:false})))
 .plugin(tauri_plugin_single_instance::init(|app,_,_|show(app)))
 .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{if event.state()==ShortcutState::Pressed{toggle(app);}}).build())
 .invoke_handler(tauri::generate_handler![bridge_event,chat_send,chat_stop,chat_new,chat_status,hide_main,open_external,show_signin,import_session_token])
 .setup(|app|{
 WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())).title("QChat").inner_size(420.,620.).min_inner_size(340.,420.).decorations(false).shadow(true).transparent(false).always_on_top(true).skip_taskbar(true).resizable(true).visible(false).build()?;
 WebviewWindowBuilder::new(app,"chatgpt",WebviewUrl::External("https://chatgpt.com/".parse()?)).title("QChat – ChatGPT sign-in").inner_size(1000.,760.).skip_taskbar(true).decorations(false).visible(false)
 .initialization_script("if(location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) window.__QCHAT_EMIT__ = (evt) => window.__TAURI_INTERNALS__.invoke('bridge_event', {event:evt});")
 .initialization_script(include_str!("../bridge/chatgpt-bridge.js")).build()?;
 background(app.handle());
 app.global_shortcut().register("Alt+Q")?;
 use tauri::{menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
 let items=[MenuItem::with_id(app,"show","Show QChat",true,None::<&str>)?,MenuItem::with_id(app,"new","New chat",true,None::<&str>)?,MenuItem::with_id(app,"signin","Sign in to ChatGPT…",true,None::<&str>)?,MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?];
 let menu=Menu::with_items(app,&items.iter().map(|x|x as &dyn tauri::menu::IsMenuItem<_>).collect::<Vec<_>>())?;
 TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).tooltip("QChat").menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray,e|{if matches!(e,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){toggle(tray.app_handle());}}).on_menu_event(|app,e|match e.id.as_ref(){"show"=>show(app),"new"=>{let _=app.emit_to("main","qchat://new-chat",());show(app)},"signin"=>show_signin(app.clone()),"quit"=>app.exit(0),_=>()}).build(app)?;
 let handle=app.handle().clone();std::thread::spawn(move||loop{
 std::thread::sleep(Duration::from_secs(10));
 let hidden=!handle.get_webview_window("main").unwrap().is_visible().unwrap_or(true);
 let suspend={let s=handle.state::<Host>();let mut a=s.0.lock().unwrap();if a.flight&&a.awaiting_event&&a.last.elapsed()>=Duration::from_secs(180){a.flight=false;} let yes=hidden&&a.hidden.elapsed()>=Duration::from_secs(180)&&a.background&&!a.flight&&!a.suspended;if yes{a.suspended=true;}yes};
 if suspend{if let Some(w)=handle.get_webview_window("chatgpt"){let _=w.with_webview(|w|unsafe{let _=w.controller().SetIsVisible(false);if let Ok(core)=w.controller().CoreWebView2(){if let Ok(v)=core.cast::<ICoreWebView2_19>(){let _=v.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);}if let Ok(v)=core.cast::<ICoreWebView2_3>(){let callback=webview2_com::TrySuspendCompletedHandler::create(Box::new(|result,_|{if let Err(e)=result { eprintln!("TrySuspend callback: {e}"); } Ok(())}));if let Err(e)=v.TrySuspend(&callback){eprintln!("TrySuspend: {e}");}}}});}}
 });Ok(())
 })
 .on_window_event(|w,e|{if let tauri::WindowEvent::CloseRequested{api,..}=e{api.prevent_close();if w.label()=="main"{hide_main(w.app_handle().clone());}else{background(w.app_handle());let _=chat_status(w.app_handle().clone());}}})
 .run(tauri::generate_context!()).expect("QChat runtime failed");
}

