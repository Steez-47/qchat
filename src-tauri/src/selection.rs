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
        Self(
            Mutex::new("Ctrl+Alt+Q".into()),
            Mutex::new(true),
            Mutex::new(false),
        )
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
pub fn get_selection_hotkey_available(state: tauri::State<State>) -> bool {
    state.0.lock().unwrap().is_empty() || *state.2.lock().unwrap()
}
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
            if *state.2.lock().unwrap() {
                let _ = app.global_shortcut().unregister(v);
            }
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
                if *state.2.lock().unwrap() {
                    let _ = app.global_shortcut().unregister(v);
                }
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
    // Keep the requested shortcut visible as unavailable; never silently choose another.
    if set_selection_hotkey(app.clone(), app.state(), saved.clone()).is_err() {
        *app.state::<State>().0.lock().unwrap() = saved;
        *app.state::<State>().2.lock().unwrap() = false;
    }
}
pub fn matches(app: &tauri::AppHandle, shortcut: &Shortcut) -> bool {
    if !*app.state::<State>().2.lock().unwrap() {
        return false;
    }
    parse(&app.state::<State>().0.lock().unwrap())
        .ok()
        .flatten()
        .as_ref()
        == Some(shortcut)
}
const MAX_SELECTION_CHARS: usize = 1_000_000;
fn cap(s: &str) -> String {
    s.chars().take(MAX_SELECTION_CHARS).collect()
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
        text.push_str(
            &ranges
                .GetElement(i)
                .ok()?
                .GetText(MAX_SELECTION_CHARS as i32)
                .ok()?
                .to_string(),
        );
        if text.chars().count() >= MAX_SELECTION_CHARS {
            break;
        }
    }
    Some(cap(&text))
}
// A broken accessibility provider can block a COM call indefinitely. Keep at most
// one such call alive and let clipboard capture continue after a short UIA budget.
fn automation_with_timeout(foreground: isize) -> Option<String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static UIA_BUSY: AtomicBool = AtomicBool::new(false);
    if UIA_BUSY.swap(true, Ordering::AcqRel) {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("selection-uia".into())
        .spawn(move || {
            struct Gate;
            impl Drop for Gate {
                fn drop(&mut self) {
                    UIA_BUSY.store(false, Ordering::Release);
                }
            }
            let _gate = Gate;
            unsafe {
                let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
                let result = if GetForegroundWindow().0 as isize == foreground {
                    automation()
                } else {
                    None
                };
                if initialized {
                    CoUninitialize();
                }
                let _ = tx.send(result);
            }
        })
        .is_err()
    {
        UIA_BUSY.store(false, Ordering::Release);
        return None;
    }
    let text = rx.recv_timeout(Duration::from_millis(800)).ok().flatten();
    if unsafe { GetForegroundWindow().0 as isize } == foreground {
        text
    } else {
        None
    }
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
    let foreground = unsafe { GetForegroundWindow().0 as isize };
    let app = app.clone();
    std::thread::spawn(move || {
        // Reset even when dispatch fails or the callback is dropped during shutdown.
        struct Gate;
        impl Drop for Gate {
            fn drop(&mut self) {
                BUSY.store(false, std::sync::atomic::Ordering::Release);
            }
        }
        let gate = Gate;
        let result = unsafe {
            let result = if GetForegroundWindow().0 as isize != foreground {
                Err("Selection capture cancelled because the active window changed.".into())
            } else if let Some(text) =
                automation_with_timeout(foreground).filter(|s| !s.trim().is_empty())
            {
                Ok(text)
            } else if *app.state::<State>().1.lock().unwrap() {
                copy_selection(HWND(foreground as *mut _))
            } else {
                Err(
                    "No selected text was available. Enable clipboard capture to try Ctrl+C."
                        .into(),
                )
            };
            result
        };
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _gate = gate;
            crate::show(&handle);
            if let Some(w) = handle.get_webview_window("main") {
                match result {
                    Ok(text) => {
                        let _ = w.emit("qchat://selection", text);
                    }
                    Err(error) => {
                        let _ = w.emit("qchat://selection-error", error);
                    }
                }
            }
        });
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cap_and_validation() {
        assert_eq!(
            cap(&"\u{1f600}".repeat(MAX_SELECTION_CHARS + 1))
                .chars()
                .count(),
            MAX_SELECTION_CHARS
        );
        assert!(parse("Ctrl+Alt+Q").unwrap().is_some());
        assert!(parse("").unwrap().is_none());
        assert!(parse("invalid shortcut").is_err());
    }
}
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::{HANDLE, HGLOBAL, HWND},
    Graphics::Gdi::{DeleteEnhMetaFile, DeleteMetaFile, DeleteObject, HENHMETAFILE, HGDIOBJ},
    System::{DataExchange::*, Memory::*},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
// This API duplicates both memory-backed registered formats and native GDI formats.
#[link(name = "ole32")]
unsafe extern "system" {
    fn OleDuplicateData(data: HANDLE, format: u16, flags: u32) -> HANDLE;
}
struct ClipboardOpen;
impl ClipboardOpen {
    unsafe fn new(owner: Option<HWND>) -> Result<Self, String> {
        for _ in 0..40 {
            if OpenClipboard(owner).is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("The clipboard is busy. Try the selection shortcut again.".into())
    }
}
impl Drop for ClipboardOpen {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}
struct ClipboardFormat(u32, HANDLE);
impl ClipboardFormat {
    unsafe fn duplicate(format: u32, data: HANDLE) -> Result<Self, String> {
        let duplicate = OleDuplicateData(data, format as u16, 0);
        if duplicate.is_invalid() {
            Err("Cannot preserve a clipboard format. The copied selection will remain on the clipboard.".into())
        } else {
            Ok(Self(format, duplicate))
        }
    }
}
impl Drop for ClipboardFormat {
    fn drop(&mut self) {
        unsafe {
            match self.0 {
                2 | 9 | 0x82 => {
                    let _ = DeleteObject(HGDIOBJ(self.1 .0));
                }
                14 | 0x8e => {
                    let _ = DeleteEnhMetaFile(Some(HENHMETAFILE(self.1 .0)));
                }
                3 | 0x83 => {
                    let memory = HGLOBAL(self.1 .0);
                    let p = GlobalLock(memory) as *const METAFILEPICT;
                    if !p.is_null() {
                        let _ = DeleteMetaFile((*p).hMF);
                        let _ = GlobalUnlock(memory);
                    }
                    let _ = windows::Win32::Foundation::GlobalFree(Some(memory));
                }
                _ => {
                    let _ = windows::Win32::Foundation::GlobalFree(Some(HGLOBAL(self.1 .0)));
                }
            }
        }
    }
}
struct ClipboardSnapshot(Vec<ClipboardFormat>);
impl ClipboardSnapshot {
    // Called with the clipboard open. Preserve every materializable format, or
    // return an error so capture can leave the newly copied text on the clipboard.
    // Indexed OLE streams (e.g. virtual FileContents) cannot be cloned this way.
    unsafe fn take() -> Result<Self, String> {
        let mut result = Self(Vec::new());
        let mut format = EnumClipboardFormats(0);
        while format != 0 {
            let data = GetClipboardData(format).map_err(|_| {
                "Cannot preserve the current clipboard. Copy text manually and try again."
            })?;
            result.0.push(ClipboardFormat::duplicate(format, data)?);
            format = EnumClipboardFormats(format);
        }
        Ok(result)
    }
    unsafe fn restore(mut self, owner: HWND, expected: u32) -> Result<(), String> {
        let _open = ClipboardOpen::new(Some(owner))?;
        // A concurrent clipboard operation belongs to the user, not this capture.
        if GetClipboardSequenceNumber() != expected {
            return Ok(());
        }
        EmptyClipboard().map_err(|_| "Could not restore the clipboard")?;
        for data in self.0.drain(..) {
            SetClipboardData(data.0, Some(data.1))
                .map_err(|_| "Could not restore a clipboard format")?;
            std::mem::forget(data); // Ownership passed back to Windows.
        }
        Ok(())
    }
}
struct ClipboardWindow(HWND);
impl ClipboardWindow {
    unsafe fn new() -> Result<Self, String> {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::w!("STATIC"),
            windows::core::w!("QChat clipboard"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
        .map(Self)
        .map_err(|_| "Could not create clipboard owner".into())
    }
}
impl Drop for ClipboardWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}
unsafe fn read_text() -> Option<String> {
    let h = GetClipboardData(13).ok()?;
    let mem = HGLOBAL(h.0);
    let p = GlobalLock(mem) as *const u16;
    if p.is_null() {
        return None;
    }
    let n = (GlobalSize(mem) / 2).min(MAX_SELECTION_CHARS * 2);
    let slice = std::slice::from_raw_parts(p, n);
    let text = String::from_utf16_lossy(&slice[..slice.iter().position(|v| *v == 0).unwrap_or(n)]);
    let _ = GlobalUnlock(mem);
    Some(cap(&text))
}
fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
unsafe fn copy_selection(foreground: HWND) -> Result<String, String> {
    if GetForegroundWindow() != foreground {
        return Err("Selection capture cancelled because the active window changed.".into());
    }
    // Users often hold the shortcut for longer than 400ms. Wait for release,
    // cancelling if they switch apps, so Ctrl+C never lands in another window.
    let deadline = Instant::now() + Duration::from_secs(30);
    while [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|v| GetAsyncKeyState(v.0 as i32) < 0)
    {
        if GetForegroundWindow() != foreground {
            return Err("Selection capture cancelled because the active window changed.".into());
        }
        if Instant::now() >= deadline {
            return Err(
                "Release the shortcut keys, then try capturing the selection again.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let owner = ClipboardWindow::new()?;
    let (snapshot, sequence) = {
        let _open = ClipboardOpen::new(None)?;
        let snapshot = ClipboardSnapshot::take().ok();
        (snapshot, GetClipboardSequenceNumber())
    };
    if GetForegroundWindow() != foreground || GetClipboardSequenceNumber() != sequence {
        return Err(
            "Selection capture cancelled because the active window or clipboard changed.".into(),
        );
    }
    let keys = [
        key(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
        key(VIRTUAL_KEY(0x43), KEYBD_EVENT_FLAGS(0)),
        key(VIRTUAL_KEY(0x43), KEYEVENTF_KEYUP),
        key(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    let sent = SendInput(&keys, std::mem::size_of::<INPUT>() as i32);
    if sent != keys.len() as u32 {
        // Release any partially injected chord. Elevated/protected apps can reject input.
        let _ = SendInput(
            &[
                key(VIRTUAL_KEY(0x43), KEYEVENTF_KEYUP),
                key(VK_CONTROL, KEYEVENTF_KEYUP),
            ],
            std::mem::size_of::<INPUT>() as i32,
        );
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while GetClipboardSequenceNumber() == sequence && Instant::now() < deadline {
        if GetForegroundWindow() != foreground {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let (result, copied_sequence) = {
        let _open = ClipboardOpen::new(None)?;
        let copied_sequence = GetClipboardSequenceNumber();
        if copied_sequence == sequence {
            return Err("No text was copied. Select text and try again. Elevated or protected apps may not allow capture.".into());
        }
        let mut source_pid = 0;
        let mut clipboard_pid = 0;
        GetWindowThreadProcessId(foreground, Some(&mut source_pid));
        if let Ok(clipboard_owner) = GetClipboardOwner() {
            GetWindowThreadProcessId(clipboard_owner, Some(&mut clipboard_pid));
        }
        if source_pid != clipboard_pid || GetForegroundWindow() != foreground {
            return Err(
                "Selection capture cancelled because another app changed the clipboard or focus."
                    .into(),
            );
        }
        (
            read_text()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "The selection did not contain readable text.".to_string()),
            // Reading a delayed-rendered format can itself advance the sequence.
            GetClipboardSequenceNumber(),
        )
    };
    if let Some(snapshot) = snapshot {
        snapshot.restore(owner.0, copied_sequence)?;
    }
    result
}

#[cfg(test)]
mod native_capture_tests {
    use super::*;
    use windows::Win32::Foundation::{LPARAM, WPARAM};

    unsafe fn put(format: u32, bytes: &[u8]) {
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).unwrap();
        let pointer = GlobalLock(memory);
        assert!(!pointer.is_null());
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(memory);
        SetClipboardData(format, Some(HANDLE(memory.0))).unwrap();
    }
    unsafe fn bytes(format: u32) -> Vec<u8> {
        let h = HGLOBAL(GetClipboardData(format).unwrap().0);
        let p = GlobalLock(h);
        assert!(!p.is_null());
        let out = std::slice::from_raw_parts(p.cast::<u8>(), GlobalSize(h)).to_vec();
        let _ = GlobalUnlock(h);
        out
    }
    unsafe fn capture_while_pumping(held: bool) -> Result<String, String> {
        if held {
            assert_eq!(
                SendInput(
                    &[
                        key(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
                        key(VK_MENU, KEYBD_EVENT_FLAGS(0))
                    ],
                    std::mem::size_of::<INPUT>() as i32
                ),
                2
            );
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let foreground = GetForegroundWindow().0 as isize;
        std::thread::spawn(move || {
            let _ = tx.send(copy_selection(HWND(foreground as *mut _)));
        });
        let start = Instant::now();
        let mut released = !held;
        loop {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !released && start.elapsed() > Duration::from_millis(750) {
                SendInput(
                    &[
                        key(VK_MENU, KEYEVENTF_KEYUP),
                        key(VK_CONTROL, KEYEVENTF_KEYUP),
                    ],
                    std::mem::size_of::<INPUT>() as i32,
                );
                released = true;
            }
            if let Ok(result) = rx.try_recv() {
                return result;
            }
            assert!(
                start.elapsed() < Duration::from_secs(6),
                "native fixture timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn duplicate_rich_custom_and_dib_without_changing_live_clipboard() {
        unsafe {
            let rich = RegisterClipboardFormatW(windows::core::w!("Rich Text Format"));
            let custom = RegisterClipboardFormatW(windows::core::w!("QChat native clone fixture"));
            let mut dib = [0u8; 44];
            dib[..4].copy_from_slice(&40u32.to_le_bytes());
            dib[4..8].copy_from_slice(&1i32.to_le_bytes());
            dib[8..12].copy_from_slice(&1i32.to_le_bytes());
            dib[12..14].copy_from_slice(&1u16.to_le_bytes());
            dib[14..16].copy_from_slice(&24u16.to_le_bytes());
            dib[40..].copy_from_slice(&[0, 0, 255, 0]);
            for (format, payload) in [
                (rich, b"{\\rtf1 fixture}\0".as_slice()),
                (custom, &[0, 255, 32, 7, 0, 9]),
                (8, dib.as_slice()),
            ] {
                let memory = GlobalAlloc(GMEM_MOVEABLE, payload.len()).unwrap();
                let source = ClipboardFormat(format, HANDLE(memory.0));
                let p = GlobalLock(memory);
                assert!(!p.is_null());
                std::ptr::copy_nonoverlapping(payload.as_ptr(), p.cast::<u8>(), payload.len());
                let _ = GlobalUnlock(memory);
                let duplicate = ClipboardFormat::duplicate(format, source.1).unwrap();
                assert_ne!(duplicate.1, source.1);
                let copied = GlobalLock(HGLOBAL(duplicate.1 .0));
                assert!(!copied.is_null());
                assert_eq!(
                    std::slice::from_raw_parts(copied.cast::<u8>(), payload.len()),
                    payload
                );
                let _ = GlobalUnlock(HGLOBAL(duplicate.1 .0));
            }
        }
    }
    #[test]
    #[ignore = "Temporarily focuses a synthetic EDIT window and sends Ctrl+C; run explicitly on an idle desktop"]
    fn native_ctrl_c_preserves_rich_clipboard_and_rejects_no_selection() {
        unsafe {
            let original_foreground = GetForegroundWindow();
            let owner = ClipboardWindow::new().unwrap();
            let original = {
                let _open = ClipboardOpen::new(None).unwrap();
                match ClipboardSnapshot::take() {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        eprintln!("SKIP native Ctrl+C fixture: the live clipboard contains unmaterializable OLE data; no clipboard writes or input sent");
                        return;
                    }
                }
            };
            struct Restore {
                snapshot: Option<ClipboardSnapshot>,
                owner: HWND,
                foreground: HWND,
            }
            impl Drop for Restore {
                fn drop(&mut self) {
                    unsafe {
                        // This explicit, bounded desktop fixture owns clipboard use until cleanup.
                        if let Some(snapshot) = self.snapshot.take() {
                            let _ = snapshot.restore(self.owner, GetClipboardSequenceNumber());
                        }
                        let _ = SetForegroundWindow(self.foreground);
                    }
                }
            }
            let _restore = Restore {
                snapshot: Some(original),
                owner: owner.0,
                foreground: original_foreground,
            };
            let rich = RegisterClipboardFormatW(windows::core::w!("Rich Text Format"));
            let custom =
                RegisterClipboardFormatW(windows::core::w!("QChat native selection fixture"));
            let mut dib = vec![0u8; 44];
            dib[..4].copy_from_slice(&40u32.to_le_bytes());
            dib[4..8].copy_from_slice(&1i32.to_le_bytes());
            dib[8..12].copy_from_slice(&1i32.to_le_bytes());
            dib[12..14].copy_from_slice(&1u16.to_le_bytes());
            dib[14..16].copy_from_slice(&24u16.to_le_bytes());
            dib[40..].copy_from_slice(&[0, 0, 255, 0]);
            {
                let _open = ClipboardOpen::new(Some(owner.0)).unwrap();
                EmptyClipboard().unwrap();
                put(13, &[b'S', 0, b'T', 0, b'A', 0, b'L', 0, b'E', 0, 0, 0]);
                put(rich, b"{\\rtf1 old clipboard}\0");
                put(custom, &[0, 255, 32, 7, 0, 9]);
                put(8, &dib);
            }
            let expected = {
                let _open = ClipboardOpen::new(None).unwrap();
                [13, rich, custom, 8].map(|f| (f, bytes(f)))
            };
            let fixture = ClipboardWindow(
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    windows::core::w!("EDIT"),
                    windows::core::w!("native selection fixture"),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    50,
                    50,
                    400,
                    160,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            );
            let _ = SetForegroundWindow(fixture.0);
            let _ = SetFocus(Some(fixture.0));
            assert_eq!(
                GetForegroundWindow(),
                fixture.0,
                "OS did not grant fixture focus"
            );
            SendMessageW(fixture.0, 0x00b1, Some(WPARAM(0)), Some(LPARAM(-1)));
            assert_eq!(
                capture_while_pumping(true).unwrap(),
                "native selection fixture"
            );
            {
                let _open = ClipboardOpen::new(None).unwrap();
                for (format, data) in &expected {
                    assert_eq!(&bytes(*format), data, "clipboard format {format} changed");
                }
            }
            SendMessageW(fixture.0, 0x00b1, Some(WPARAM(0)), Some(LPARAM(0)));
            assert!(capture_while_pumping(false)
                .unwrap_err()
                .contains("No text was copied"));
            {
                let _open = ClipboardOpen::new(None).unwrap();
                for (format, data) in expected {
                    assert_eq!(
                        bytes(format),
                        data,
                        "clipboard format {format} changed after no selection"
                    );
                }
            }
            // An advertised but unrenderable OLE/custom format must not block capture.
            // The original clipboard is safely backed up by this fixture's guard.
            let unavailable =
                RegisterClipboardFormatW(windows::core::w!("QChat unavailable fixture"));
            {
                let _open = ClipboardOpen::new(Some(owner.0)).unwrap();
                EmptyClipboard().unwrap();
                // NULL successfully advertises delayed rendering but also returns NULL.
                let _ = SetClipboardData(unavailable, None);
                assert!(IsClipboardFormatAvailable(unavailable).is_ok());
            }
            SendMessageW(fixture.0, 0x00b1, Some(WPARAM(0)), Some(LPARAM(-1)));
            assert_eq!(
                capture_while_pumping(false).unwrap(),
                "native selection fixture"
            );
            {
                let _open = ClipboardOpen::new(None).unwrap();
                assert_eq!(read_text().unwrap(), "native selection fixture");
            }
        }
    }
}
