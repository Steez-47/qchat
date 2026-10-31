use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use windows::{
    core::Interface,
    Win32::{System::Com::*, UI::Accessibility::*},
};
pub struct State(pub Mutex<String>, pub Mutex<bool>, pub Mutex<bool>);
impl Default for State {
    fn default() -> Self {
        Self(Mutex::new("Ctrl+Alt+Q".into()), Mutex::new(true), Mutex::new(false))
    }
}
fn parse(s: &str) -> Result<Option<Shortcut>, String> {
    if s.is_empty() {
        Ok(None)
    } else {
        s.parse()
            .map(Some)
            .map_err(|e| format!("Invalid shortcut: {e}"))
    }
}
fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::test_profile()
        .map(Ok)
        .unwrap_or_else(|| app.path().app_data_dir().map_err(|e| e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("selection-hotkey.json"))
}
#[tauri::command]
pub fn get_selection_hotkey(state: tauri::State<State>) -> String {
    state.0.lock().unwrap().clone()
}
#[tauri::command]
pub fn get_selection_hotkey_available(state: tauri::State<State>) -> bool { state.0.lock().unwrap().is_empty() || *state.2.lock().unwrap() }
#[tauri::command]
pub fn set_selection_clipboard(state: tauri::State<State>, enabled: bool) {
    *state.1.lock().unwrap() = enabled;
}
#[tauri::command]
pub fn set_selection_hotkey(
    app: tauri::AppHandle,
    state: tauri::State<State>,
    accelerator: String,
) -> Result<String, String> {
    let new = parse(&accelerator)?;
    if new.is_some() && new == parse(&crate::surfaces::get_hotkey(app.state()))? {
        return Err("Shortcut already used by QChat".into());
    }
    let mut saved = state.0.lock().unwrap();
    let old = parse(&saved)?;
    let real = crate::test_profile().is_none();
    if real {
        if let Some(v) = old {
            if *state.2.lock().unwrap() { let _ = app.global_shortcut().unregister(v); }
        }
        if let Some(v) = new {
            if let Err(e) = app.global_shortcut().register(v) {
                if let Some(v) = old {
                    *state.2.lock().unwrap() = app.global_shortcut().register(v).is_ok();
                }
                return Err(e.to_string());
            }
        }
    }
    if let Err(e) = path(&app).and_then(|p| {
        std::fs::write(p, serde_json::to_vec(&accelerator).unwrap()).map_err(|e| e.to_string())
    }) {
        if real {
            if let Some(v) = new {
                if *state.2.lock().unwrap() { let _ = app.global_shortcut().unregister(v); }
            }
            if let Some(v) = old {
                *state.2.lock().unwrap() = app.global_shortcut().register(v).is_ok();
            }
        }
        return Err(e);
    }
    *state.2.lock().unwrap() = new.is_some();
    *saved = accelerator.clone();
    Ok(accelerator)
}
pub fn start(app: &tauri::AppHandle) {
    let saved = path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .unwrap_or("Ctrl+Alt+Q".into());
    if set_selection_hotkey(app.clone(), app.state(), saved).is_err() { let _ = set_selection_hotkey(app.clone(), app.state(), "Alt+Q".into()); }
}
pub fn matches(app: &tauri::AppHandle, shortcut: &Shortcut) -> bool {
    parse(&app.state::<State>().0.lock().unwrap())
        .ok()
        .flatten()
        .as_ref()
        == Some(shortcut)
}
fn cap(s: &str) -> String {
    s.chars().take(20000).collect()
}
unsafe fn automation() -> Option<String> {
    let u: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
    let pattern = u
        .GetFocusedElement()
        .ok()?
        .GetCurrentPattern(UIA_TextPatternId)
        .ok()?
        .cast::<IUIAutomationTextPattern>()
        .ok()?;
    let ranges = pattern.GetSelection().ok()?;
    let mut text = String::new();
    for i in 0..ranges.Length().ok()? {
        text.push_str(&ranges.GetElement(i).ok()?.GetText(20000).ok()?.to_string());
        if text.chars().count() >= 20000 {
            break;
        }
    }
    Some(cap(&text))
}
pub fn activate(app: &tauri::AppHandle) {
    if crate::test_profile().is_some() {
        return;
    }
    crate::snapshot::observe_foreground();
    static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let text = unsafe {
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let text = automation().filter(|s| !s.trim().is_empty()).or_else(|| {
                if *app.state::<State>().1.lock().unwrap() {
                    copy_selection()
                } else {
                    None
                }
            });
            if initialized {
                CoUninitialize();
            }
            text
        };
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::show(&handle);
            if let Some(text) = text.filter(|s| !s.trim().is_empty()) {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.emit("qchat://selection", text);
                }
            }
            BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cap_and_validation() {
        assert_eq!(cap(&"\u{1f600}".repeat(20001)).chars().count(), 20000);
        assert!(parse("Ctrl+Alt+Q").unwrap().is_some());
        assert!(parse("").unwrap().is_none());
        assert!(parse("invalid shortcut").is_err());
    }
}
use std::time::{Duration, Instant};
use windows::Win32::{
    System::{DataExchange::*, Memory::*},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::GetForegroundWindow},
};
unsafe fn read_text() -> Option<String> {
    let h = GetClipboardData(13).ok()?;
    let mem = windows::Win32::Foundation::HGLOBAL(h.0);
    let p = GlobalLock(mem) as *const u16;
    if p.is_null() {
        return None;
    }
    let n = GlobalSize(mem) / 2;
    let slice = std::slice::from_raw_parts(p, n);
    let text = String::from_utf16_lossy(&slice[..slice.iter().position(|v| *v == 0).unwrap_or(n)]);
    let _ = GlobalUnlock(mem);
    Some(text)
}
unsafe fn copy_selection() -> Option<String> {
    let foreground = GetForegroundWindow();
    OpenClipboard(None).ok()?;
    let mut f = EnumClipboardFormats(0);
    let mut safe = true;
    while f != 0 {
        if ![1, 7, 13, 16].contains(&f) {
            safe = false;
        }
        f = EnumClipboardFormats(f);
    }
    let old = read_text();
    if old.is_none() && CountClipboardFormats() > 0 {
        let _ = CloseClipboard();
        return None;
    }
    let seq = GetClipboardSequenceNumber();
    let _ = CloseClipboard();
    if !safe {
        return None;
    }
    let deadline = Instant::now() + Duration::from_millis(400);
    while [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|v| GetAsyncKeyState(v.0 as i32) < 0)
    {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if GetForegroundWindow() != foreground || GetClipboardSequenceNumber() != seq {
        return None;
    }
    let bytes: Vec<u16> = old
        .as_deref()
        .unwrap_or("")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len() * 2).ok()?;
    let pointer = GlobalLock(memory) as *mut u16;
    if pointer.is_null() {
        let _ = windows::Win32::Foundation::GlobalFree(Some(memory));
        return None;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
    let _ = GlobalUnlock(memory);
    let key = |vk, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let keys = [
        key(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
        key(VIRTUAL_KEY(0x43), KEYBD_EVENT_FLAGS(0)),
        key(VIRTUAL_KEY(0x43), KEYEVENTF_KEYUP),
        key(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    SendInput(&keys, std::mem::size_of::<INPUT>() as i32);
    let deadline = Instant::now() + Duration::from_millis(300);
    while GetClipboardSequenceNumber() == seq && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if GetClipboardSequenceNumber() == seq {
        let _ = windows::Win32::Foundation::GlobalFree(Some(memory));
        return None;
    }
    for _ in 0..10 {
        if OpenClipboard(Some(foreground)).is_ok() {
            let result = read_text().map(|s| cap(&s));
            if EmptyClipboard().is_ok()
                && old.is_some()
                && SetClipboardData(13, Some(windows::Win32::Foundation::HANDLE(memory.0))).is_ok()
            {
                let _ = CloseClipboard();
                return result;
            }
            let _ = CloseClipboard();
            let _ = windows::Win32::Foundation::GlobalFree(Some(memory));
            return result;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = windows::Win32::Foundation::GlobalFree(Some(memory));
    None
}
