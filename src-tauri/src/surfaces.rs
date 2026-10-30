use std::{sync::Mutex, time::Duration};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Surface {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    r: f64,
}
impl Surface {
    fn hit(&self, x: f64, y: f64, scale: f64) -> bool {
        let (x, y) = (x / scale, y / scale);
        if x < self.x || y < self.y || x > self.x + self.w || y > self.y + self.h {
            return false;
        }
        let r = self.r.max(0.).min(self.w / 2.).min(self.h / 2.);
        let cx = x.clamp(self.x + r, self.x + self.w - r);
        let cy = y.clamp(self.y + r, self.y + self.h - r);
        (x - cx).powi(2) + (y - cy).powi(2) <= r * r
    }
    fn inset(&self) -> Option<Self> {
        if self.w <= 3. || self.h <= 3. {
            return None;
        }
        Some(Self {
            x: self.x + 1.5,
            y: self.y + 1.5,
            w: self.w - 3.,
            h: self.h - 3.,
            r: (self.r - 1.5).max(0.),
        })
    }
}
struct Data {
    rects: Option<Vec<Surface>>,
    blur: bool,
    tint: u32,
    revision: u64,
    hotkey: String,
    autostart: bool,
}
pub struct State(Mutex<Data>);
impl Default for State {
    fn default() -> Self {
        Self(Mutex::new(Data {
            rects: None,
            blur: false,
            tint: 0x99202020,
            revision: 0,
            hotkey: "Alt+Q".into(),
            autostart: false,
        }))
    }
}
#[tauri::command]
pub fn surfaces_set(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
    rects: Vec<Surface>,
) -> Result<Vec<Surface>, String> {
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    if rects.len() > 512
        || rects.iter().any(|r| {
            ![r.x, r.y, r.w, r.h, r.r]
                .iter()
                .all(|v| v.is_finite() && v.abs() < 100000.)
                || r.w < 0.
                || r.h < 0.
                || r.r < 0.
        })
    {
        return Err("Invalid surface geometry".into());
    }
    let mut s = state.0.lock().unwrap();
    s.rects = Some(rects.clone());
    s.revision += 1;
    Ok(rects)
}
#[tauri::command]
pub fn surfaces_set_blur(state: tauri::State<State>, enabled: bool, tint_argb: u32) {
    let mut s = state.0.lock().unwrap();
    s.blur = enabled;
    s.tint = tint_argb;
    s.revision += 1;
}
fn config(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::test_profile()
        .map(Ok)
        .unwrap_or_else(|| app.path().app_data_dir().map_err(|e| e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("hotkey.json"))
}
fn parse(s: &str) -> Result<Shortcut, String> {
    s.parse().map_err(|e| format!("Invalid shortcut: {e}"))
}
#[tauri::command]
pub fn get_hotkey(state: tauri::State<State>) -> String {
    state.0.lock().unwrap().hotkey.clone()
}
#[tauri::command]
pub fn set_hotkey(
    app: tauri::AppHandle,
    state: tauri::State<State>,
    accelerator: String,
) -> Result<String, String> {
    let new = parse(&accelerator)?;
    let mut s = state.0.lock().unwrap();
    let old = parse(&s.hotkey)?;
    if crate::test_profile().is_none() {
        app.global_shortcut()
            .unregister(old)
            .map_err(|e| e.to_string())?;
        if let Err(e) = app.global_shortcut().register(new) {
            let rollback = app.global_shortcut().register(old);
            return Err(format!(
                "Shortcut unavailable: {e}; restored previous shortcut: {}",
                rollback.is_ok()
            ));
        }
    }
    let persist = config(&app).and_then(|p| {
        std::fs::write(p, serde_json::to_vec(&accelerator).unwrap()).map_err(|e| e.to_string())
    });
    if let Err(e) = persist {
        if crate::test_profile().is_none() {
            let _ = app.global_shortcut().unregister(new);
            let _ = app.global_shortcut().register(old);
        }
        return Err(e);
    }
    s.hotkey = accelerator.clone();
    Ok(accelerator)
}
#[tauri::command]
pub fn get_autostart(state: tauri::State<State>) -> bool {
    if crate::test_profile().is_some() {
        return state.0.lock().unwrap().autostart;
    }
    registry(None).unwrap_or(false)
}
#[tauri::command]
pub fn set_autostart(state: tauri::State<State>, enabled: bool) -> Result<(), String> {
    if crate::test_profile().is_some() {
        state.0.lock().unwrap().autostart = enabled;
        return Ok(());
    }
    registry(Some(enabled)).map(|_| ())
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn registry(set: Option<bool>) -> Result<bool, String> {
    unsafe {
        let mut key = 0isize;
        let path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        let name = wide("QChat");
        let code = RegOpenKeyExW(
            0x80000001u32 as i32 as isize,
            path.as_ptr(),
            0,
            if set.is_some() { 2 } else { 1 },
            &mut key,
        );
        if code != 0 {
            return Err(format!("Cannot open login settings ({code})"));
        }
        let code = match set {
            Some(true) => {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let value = wide(&format!("\"{}\"", exe.display()));
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    1,
                    value.as_ptr() as _,
                    (value.len() * 2) as u32,
                )
            }
            Some(false) => {
                let c = RegDeleteValueW(key, name.as_ptr());
                if c == 2 {
                    0
                } else {
                    c
                }
            }
            None => {
                let mut size = 0;
                let c = RegQueryValueExW(
                    key,
                    name.as_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut size,
                );
                RegCloseKey(key);
                return Ok(c == 0);
            }
        };
        RegCloseKey(key);
        if code == 0 {
            Ok(set.unwrap_or(false))
        } else {
            Err(format!("Cannot update login settings ({code})"))
        }
    }
}
#[repr(C)]
#[derive(Default, PartialEq, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
#[derive(Default)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
#[derive(Default)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    point: Point,
    private: u32,
}
#[repr(C)]
struct Accent {
    state: i32,
    flags: i32,
    color: u32,
    animation: i32,
}
#[repr(C)]
struct Composition {
    attribute: i32,
    data: *mut Accent,
    size: usize,
}
#[link(name = "user32")]
extern "system" {
    fn PeekMessageW(m: *mut Msg, h: isize, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(m: *const Msg) -> i32;
    fn DispatchMessageW(m: *const Msg) -> isize;
    fn GetCursorPos(p: *mut Point) -> i32;
    fn GetAsyncKeyState(k: i32) -> i16;
    fn GetWindowRect(h: isize, r: *mut Rect) -> i32;
    fn IsWindowVisible(h: isize) -> i32;
    fn IsIconic(h: isize) -> i32;
    fn GetDpiForWindow(h: isize) -> u32;
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: *const u8,
    ) -> isize;
    fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, w: i32, height: i32, flags: u32)
        -> i32;
    fn ShowWindow(h: isize, cmd: i32) -> i32;
    fn SetWindowRgn(h: isize, r: isize, redraw: i32) -> i32;
    fn SetLayeredWindowAttributes(h: isize, key: u32, alpha: u8, flags: u32) -> i32;
}
#[link(name = "gdi32")]
extern "system" {
    fn CreateRectRgn(a: i32, b: i32, c: i32, d: i32) -> isize;
    fn CreateRoundRectRgn(a: i32, b: i32, c: i32, d: i32, e: i32, f: i32) -> isize;
    fn CombineRgn(a: isize, b: isize, c: isize, mode: i32) -> i32;
    fn DeleteObject(h: isize) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(s: *const u16) -> isize;
    fn GetProcAddress(h: isize, s: *const u8) -> *const ();
}
#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(h: isize, s: *const u16, o: u32, a: u32, k: *mut isize) -> i32;
    fn RegCloseKey(h: isize) -> i32;
    fn RegSetValueExW(h: isize, n: *const u16, r: u32, t: u32, d: *const u8, l: u32) -> i32;
    fn RegDeleteValueW(h: isize, n: *const u16) -> i32;
    fn RegQueryValueExW(
        h: isize,
        n: *const u16,
        r: *mut u32,
        t: *mut u32,
        d: *mut u8,
        l: *mut u32,
    ) -> i32;
}
pub fn start(app: &tauri::AppHandle) {
    let saved = config(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .filter(|s| parse(s).is_ok())
        .unwrap_or("Alt+Q".into());
    app.state::<State>().0.lock().unwrap().hotkey = saved.clone();
    if crate::test_profile().is_none() {
        if let Err(e) = app.global_shortcut().register(saved.as_str()) {
            eprintln!("Shortcut unavailable: {e}")
        }
    }
    let app = app.clone();
    std::thread::spawn(move || unsafe {
        let Some(w) = app.get_webview_window("main") else {
            return;
        };
        let Ok(hwnd) = w.hwnd() else { return };
        let main = hwnd.0 as isize;
        let glass = CreateWindowExW(
            0x80 | 0x08000000 | 0x20 | 0x80000,
            wide("STATIC").as_ptr(),
            wide("").as_ptr(),
            0x80000000,
            0,
            0,
            0,
            0,
            main,
            0,
            0,
            std::ptr::null(),
        );
        SetLayeredWindowAttributes(glass, 0, 255, 2);
        let proc = GetProcAddress(
            GetModuleHandleW(wide("user32.dll").as_ptr()),
            b"SetWindowCompositionAttribute\0".as_ptr(),
        );
        let mut previous = None;
        let mut ignored = false;
        let mut revision = u64::MAX;
        let mut oldscale = 0.;
        let mut blur_ok = false;
        loop {
            let mut msg = Msg::default();
            while PeekMessageW(&mut msg, 0, 0, 0, 1) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let visible = IsWindowVisible(main) != 0 && IsIconic(main) == 0;
            if !visible {
                ShowWindow(glass, 0);
                if ignored {
                    let _ = w.set_ignore_cursor_events(false);
                    ignored = false
                }
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            let scale = GetDpiForWindow(main) as f64 / 96.;
            let mut bounds = Rect::default();
            GetWindowRect(main, &mut bounds);
            let (rects, blur, tint, rev) = {
                let state = app.state::<State>();
                let s = state.0.lock().unwrap();
                (s.rects.clone(), s.blur, s.tint, s.revision)
            };
            if rev != revision || scale != oldscale {
                let region = CreateRectRgn(0, 0, 0, 0);
                for r in rects.iter().flatten().filter_map(Surface::inset) {
                    let n = |v: f64| (v * scale).round() as i32;
                    let part = CreateRoundRectRgn(
                        n(r.x),
                        n(r.y),
                        n(r.x + r.w),
                        n(r.y + r.h),
                        n(r.r * 2.),
                        n(r.r * 2.),
                    );
                    CombineRgn(region, region, part, 2);
                    DeleteObject(part);
                }
                if SetWindowRgn(glass, region, 0) == 0 {
                    DeleteObject(region);
                }
                if !proc.is_null() {
                    let f: unsafe extern "system" fn(isize, *mut Composition) -> i32 =
                        std::mem::transmute(proc);
                    let mut accent = Accent {
                        state: if blur { 3 } else { 0 },
                        flags: 0,
                        color: (tint & 0xff00ff00) | ((tint & 255) << 16) | ((tint >> 16) & 255),
                        animation: 0,
                    };
                    let mut data = Composition {
                        attribute: 19,
                        data: &mut accent,
                        size: std::mem::size_of::<Accent>(),
                    };
                    blur_ok = f(glass, &mut data) != 0;
                }
                revision = rev;
                oldscale = scale;
            }
            if blur && blur_ok {
                if previous != Some(bounds) {
                    SetWindowPos(
                        glass,
                        main,
                        bounds.left,
                        bounds.top,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        0x10 | 0x40,
                    );
                    previous = Some(bounds);
                } else {
                    SetWindowPos(glass, main, 0, 0, 0, 0, 0x10 | 0x40 | 1 | 2);
                }
            } else {
                ShowWindow(glass, 0);
            }
            let mut p = Point::default();
            if GetCursorPos(&mut p) != 0
                && [1, 2, 4, 5, 6].iter().all(|k| GetAsyncKeyState(*k) >= 0)
            {
                let desired = rects.as_ref().is_some_and(|rs| {
                    !rs.iter().any(|r| {
                        r.hit((p.x - bounds.left) as f64, (p.y - bounds.top) as f64, scale)
                    })
                });
                if desired != ignored && w.set_ignore_cursor_events(desired).is_ok() {
                    ignored = desired
                }
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rounded() {
        let r = Surface {
            x: 10.,
            y: 10.,
            w: 100.,
            h: 40.,
            r: 20.,
        };
        assert!(!r.hit(10., 10., 1.));
        assert!(r.hit(30., 10., 1.));
        assert!(r.hit(60., 20., 2.));
        assert!(!r.hit(20., 20., 2.));
        let i = r.inset().unwrap();
        assert_eq!(i.x, 11.5);
        assert_eq!(i.r, 18.5);
        assert_eq!(i.w, 97.);
    }
    #[test]
    fn shortcuts() {
        assert!(parse("Alt+Q").is_ok());
        assert!(parse("this is invalid").is_err());
    }
}
