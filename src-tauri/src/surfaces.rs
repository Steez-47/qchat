use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Surface {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    r: f64,
    // Hit-test only when false: controls outside the glass never get a blur panel.
    #[serde(default = "blurred_by_default")]
    b: bool,
}
fn blurred_by_default() -> bool {
    true
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
    fn physical_inset(&self, scale: f64) -> Option<Self> {
        let r = self.inset()?;
        Some(Self {
            x: r.x * scale,
            y: r.y * scale,
            w: r.w * scale,
            h: r.h * scale,
            r: r.r.min(r.w / 2.).min(r.h / 2.) * scale,
            b: self.b,
        })
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
            b: self.b,
        })
    }
}
struct Data {
    debug: DebugState,
    rects: Option<Vec<Surface>>,
    reported: std::time::Instant,
    blur: bool,
    tint: u32,
    strength: f64,
    revision: u64,
    hotkey: String,
    registered: bool,
    autostart: bool,
}
pub struct State(Mutex<Data>);
impl Default for State {
    fn default() -> Self {
        Self(Mutex::new(Data {
            debug: DebugState::default(),
            rects: None,
            reported: std::time::Instant::now(),
            blur: false,
            tint: 0x99202020,
            strength: 1.,
            revision: 0,
            hotkey: "Alt+Q".into(),
            registered: false,
            autostart: false,
        }))
    }
}
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugState {
    blur_ok: bool,
    glass_hwnd: isize,
    main_hwnd: isize,
    glass_visible: bool,
    rect_count: usize,
    ignoring: bool,
    glass_is_below_main: bool,
    composition_error: Option<String>,
    composition_scale: f64,
    composition_revision: u64,
}
// No state mutation or native window operations are exposed by this test hook.
#[tauri::command]
pub fn surfaces_debug(state: tauri::State<State>) -> Result<DebugState, String> {
    if crate::test_profile().is_none() {
        return Err("Test profile required".into());
    }
    let s = state.0.lock().unwrap();
    let mut debug = s.debug.clone();
    debug.rect_count = s.rects.as_ref().map_or(0, Vec::len);
    unsafe {
        debug.glass_visible = IsWindowVisible(debug.glass_hwnd) != 0;
        debug.glass_is_below_main = below_main(debug.main_hwnd, debug.glass_hwnd, false);
    }
    Ok(debug)
}
// Hidden helper windows can intervene without painting between the two surfaces.
unsafe fn below_main(main: isize, glass: isize, adjacent_visible: bool) -> bool {
    if main == 0 || glass == 0 {
        return false;
    }
    let mut next = GetWindow(main, 2); // GW_HWNDNEXT walks down the z-order.
    for _ in 0..10000 {
        if next == glass {
            return true;
        }
        if next == 0 || (adjacent_visible && IsWindowVisible(next) != 0) {
            return false;
        }
        next = GetWindow(next, 2);
    }
    false
}
#[tauri::command]
pub fn surfaces_set(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
    rects: Vec<Surface>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    if rects.len() > 2048
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
    s.rects = Some(rects);
    s.reported = std::time::Instant::now();
    s.revision += 1;
    Ok(())
}
#[tauri::command]
pub fn surfaces_set_blur(state: tauri::State<State>, enabled: bool, tint_argb: u32, strength: Option<f64>) {
    let mut s = state.0.lock().unwrap();
    s.blur = enabled;
    s.tint = tint_argb;
    s.strength = strength.filter(|v| v.is_finite()).unwrap_or(1.).clamp(0., 1.);
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
pub fn get_hotkey_available(state: tauri::State<State>) -> bool { state.0.lock().unwrap().registered }
#[tauri::command]
pub fn set_hotkey(
    app: tauri::AppHandle,
    state: tauri::State<State>,
    accelerator: String,
) -> Result<String, String> {
    let new = parse(&accelerator)?;
    if crate::selection::matches(&app, &new) { return Err("Shortcut already used for selection".into()) }
    let mut s = state.0.lock().unwrap();
    let old = parse(&s.hotkey)?;
    if crate::test_profile().is_none() {
        if s.registered { let _ = app.global_shortcut().unregister(old); }
        if let Err(e) = app.global_shortcut().register(new) {
            let rollback = app.global_shortcut().register(old);
            s.registered = rollback.is_ok();
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
            s.registered = app.global_shortcut().register(old).is_ok();
        }
        return Err(e);
    }
    s.registered = true;
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
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let expected = format!("\"{}\"", exe.display());
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
                let value = wide(&expected);
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
                let mut size = 32768u32;
                let mut value = vec![0u16; 16384];
                let c = RegQueryValueExW(key,name.as_ptr(),std::ptr::null_mut(),std::ptr::null_mut(),value.as_mut_ptr() as _,&mut size);
                RegCloseKey(key);
                return Ok(c == 0 && String::from_utf16_lossy(&value[..(size as usize / 2).min(value.len())]).trim_end_matches('\0') == expected);

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
struct WndClass {
    style: u32,
    proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
    cls_extra: i32,
    wnd_extra: i32,
    instance: isize,
    icon: isize,
    cursor: isize,
    background: isize,
    menu: *const u16,
    class: *const u16,
}
#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(c: *const WndClass) -> u16;
    fn DefWindowProcW(h: isize, m: u32, w: usize, l: isize) -> isize;
    fn GetWindow(h: isize, command: u32) -> isize;
    fn GetWindowLongPtrW(h: isize, index: i32) -> isize;
    fn IsWindow(h: isize) -> i32;
    fn DestroyWindow(h: isize) -> i32;
    fn PeekMessageW(m: *mut Msg, h: isize, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(m: *const Msg) -> i32;
    fn DispatchMessageW(m: *const Msg) -> isize;
    fn GetCursorPos(p: *mut Point) -> i32;
    fn GetAsyncKeyState(k: i32) -> i16;
    fn GetWindowRect(h: isize, r: *mut Rect) -> i32;
    fn IsWindowVisible(h: isize) -> i32;
    fn GetForegroundWindow() -> isize;
    fn SetForegroundWindow(h: isize) -> i32;
    fn GetWindowThreadProcessId(h: isize, process: *mut u32) -> u32;
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
    fn MsgWaitForMultipleObjectsEx(
        count: u32,
        handles: *const isize,
        ms: u32,
        mask: u32,
        flags: u32,
    ) -> u32;
}
#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(
        h: isize,
        proc: unsafe extern "system" fn(isize, u32, usize, isize, usize, usize) -> isize,
        id: usize,
        data: usize,
    ) -> i32;
    fn DefSubclassProc(h: isize, m: u32, w: usize, l: isize) -> isize;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(s: *const u16) -> isize;
    fn GetCurrentProcessId() -> u32;
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
#[repr(C)]
struct WindowPos {
    hwnd: isize,
    after: isize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    flags: u32,
}
// Runs inside the main window's own move, so the companion is told in the same
// breath. Async: the companion thread must never be able to block this window.
unsafe extern "system" fn follow_main(
    h: isize,
    message: u32,
    w: usize,
    l: isize,
    _id: usize,
    glass: usize,
) -> isize {
    const WM_WINDOWPOSCHANGING: u32 = 0x0046;
    const SWP_NOSIZE: u32 = 1;
    const SWP_NOMOVE: u32 = 2;
    if message == WM_WINDOWPOSCHANGING && l != 0 {
        let p = &*(l as *const WindowPos);
        if p.flags & SWP_NOSIZE == 0 || p.flags & SWP_NOMOVE == 0 {
            let mut now = Rect::default();
            GetWindowRect(h, &mut now);
            let (x, y) = if p.flags & SWP_NOMOVE == 0 { (p.x, p.y) } else { (now.left, now.top) };
            let (cx, cy) = if p.flags & SWP_NOSIZE == 0 {
                (p.w, p.h)
            } else {
                (now.right - now.left, now.bottom - now.top)
            };
            // NOZORDER | NOACTIVATE | ASYNCWINDOWPOS
            SetWindowPos(glass as isize, 0, x, y, cx, cy, 0x4 | 0x10 | 0x4000);
        }
    }
    DefSubclassProc(h, message, w, l)
}
static LAUNCH_FOREGROUND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
// Must run before any window exists: creating them is what takes the foreground.
pub fn remember_launch_foreground() {
    LAUNCH_FOREGROUND.store(unsafe { GetForegroundWindow() }, std::sync::atomic::Ordering::Relaxed);
}
// The hidden ChatGPT page lives off screen but is a real window, and it or its webview can take the
// foreground when shown or when the page loads. Focus there goes nowhere, so hand it straight back.
unsafe fn return_stray_focus(w: &tauri::WebviewWindow, last_other: &mut isize) {
    let front = GetForegroundWindow();
    if front == 0 {
        return;
    }
    let mut process = 0u32;
    GetWindowThreadProcessId(front, &mut process);
    if process != GetCurrentProcessId() {
        *last_other = front;
        return;
    }
    let mut at = Rect::default();
    GetWindowRect(front, &mut at);
    if at.left < -10000 && *last_other != 0 && IsWindow(*last_other) != 0 {
        // Windows only honours this from the thread that owns the current foreground window.
        let target = *last_other;
        let _ = w.run_on_main_thread(move || unsafe {
            SetForegroundWindow(target);
        });
    }
}
// One call, so the top edge and the size change in the same frame.
pub fn place_window(w: &tauri::WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    if let Ok(hwnd) = w.hwnd() {
        // NOZORDER | NOACTIVATE
        unsafe { SetWindowPos(hwnd.0 as isize, 0, x, y, width, height, 0x4 | 0x10) };
    }
}
// All WinRT objects live on the companion thread and are released there.
struct GlassComposition {
    compositor: windows::UI::Composition::Compositor,
    _target: windows::UI::Composition::Desktop::DesktopWindowTarget,
    root: windows::UI::Composition::ContainerVisual,
    brush: windows::UI::Composition::CompositionBackdropBrush,
    sprites: std::cell::RefCell<Vec<(windows::UI::Composition::SpriteVisual, windows::UI::Composition::CompositionRoundedRectangleGeometry)>>,
    _queue: windows::System::DispatcherQueueController,
}
impl GlassComposition {
    unsafe fn new(hwnd: isize) -> windows::core::Result<Self> {
        use windows::{
            core::Interface,
            Win32::{
                Foundation::HWND,
                Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_HOSTBACKDROPBRUSH},
                System::WinRT::{
                    Composition::ICompositorDesktopInterop, CreateDispatcherQueueController,
                    DispatcherQueueOptions, DQTAT_COM_STA, DQTYPE_THREAD_CURRENT,
                },
            },
        };
        let queue = CreateDispatcherQueueController(DispatcherQueueOptions {
            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_STA,
        })?;
        let enabled = 1i32;
        DwmSetWindowAttribute(
            HWND(hwnd as _),
            DWMWA_USE_HOSTBACKDROPBRUSH,
            &enabled as *const _ as _,
            4,
        )?;
        let compositor = windows::UI::Composition::Compositor::new()?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        let target = interop.CreateDesktopWindowTarget(HWND(hwnd as _), false)?;
        let root = compositor.CreateContainerVisual()?;
        target.SetRoot(&root)?;
        let brush = compositor.CreateHostBackdropBrush()?;
        Ok(Self {
            compositor,
            _target: target,
            root,
            brush,
            sprites: Default::default(),
            _queue: queue,
        })
    }
    fn update(&self, rects: &[Surface], scale: f64, strength: f64) -> windows::core::Result<()> {
        let c = &self.compositor;
        // Existing sprites are moved in place. Replacing the tree on every small change
        // makes all the glass blink, which reads as the whole window jittering.
        let wanted: Vec<Surface> = rects.iter().filter(|r| r.b).filter_map(|r| r.physical_inset(scale)).collect();
        let children = self.root.Children()?;
        let mut sprites = self.sprites.borrow_mut();
        while sprites.len() > wanted.len() {
            if let Some((sprite, _)) = sprites.pop() {
                children.Remove(&sprite)?;
            }
        }
        for (index, r) in wanted.iter().enumerate() {
            if index == sprites.len() {
                let sprite = c.CreateSpriteVisual()?;
                let geometry = c.CreateRoundedRectangleGeometry()?;
                sprite.SetClip(&c.CreateGeometricClipWithGeometry(&geometry)?)?;
                sprite.SetBrush(&self.brush)?;
                children.InsertAtTop(&sprite)?;
                sprites.push((sprite, geometry));
            }
            let (sprite, geometry) = &sprites[index];
            // The system blur has a fixed radius; strength crossfades it with the sharp desktop.
            sprite.SetOpacity(strength as f32)?;
            let mut size = sprite.Size()?;
            size.X = r.w as f32;
            size.Y = r.h as f32;
            sprite.SetSize(size)?;
            let mut offset = sprite.Offset()?;
            offset.X = r.x as f32;
            offset.Y = r.y as f32;
            sprite.SetOffset(offset)?;
            geometry.SetSize(size)?;
            let mut radius = geometry.CornerRadius()?;
            radius.X = r.r as f32;
            radius.Y = radius.X;
            geometry.SetCornerRadius(radius)?;
        }
        let _ = c.RequestCommitAsync()?;
        Ok(())
    }
}
pub fn start(app: &tauri::AppHandle) {
    let saved = config(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .filter(|s| parse(s).is_ok())
        .unwrap_or("Alt+Q".into());
    let mut chosen = saved.clone();
    let registered = crate::test_profile().is_some() || app.global_shortcut().register(saved.as_str()).is_ok();
    let registered = if !registered { chosen = "Alt+Q".into(); app.global_shortcut().register(chosen.as_str()).is_ok() } else { true };
    { let state=app.state::<State>(); let mut s=state.0.lock().unwrap(); s.hotkey=chosen; s.registered=registered; }
    let app = app.clone();
    let mut last_other = LAUNCH_FOREGROUND.load(std::sync::atomic::Ordering::Relaxed);
    std::thread::spawn(move || unsafe {
        let Some(w) = app.get_webview_window("main") else {
            return;
        };
        let Ok(hwnd) = w.hwnd() else { return };
        let main = hwnd.0 as isize;
        let class = wide("QChatGlass");
        let wc = WndClass {
            style: 0,
            proc: Some(DefWindowProcW),
            cls_extra: 0,
            wnd_extra: 0,
            instance: GetModuleHandleW(std::ptr::null()),
            icon: 0,
            cursor: 0,
            background: 0, // The composition tree is the only content.
            menu: std::ptr::null(),
            class: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let glass = CreateWindowExW(
            // NOREDIRECTIONBITMAP hosts the alpha composition tree; LAYERED +
            // TRANSPARENT makes the entire companion click-through across threads.
            0x8 | 0x80 | 0x08000000 | 0x20 | 0x00200000 | 0x00080000,
            class.as_ptr(),
            wide("").as_ptr(),
            0x80000000,
            0,
            0,
            0,
            0,
            0, // Unowned: an owned window cannot sit below its owner.
            0,
            0,
            std::ptr::null(),
        );
        if glass == 0 {
            return;
        }
        let hook = glass as usize;
        let _ = w.run_on_main_thread(move || {
            SetWindowSubclass(main, follow_main, 1, hook);
        });
        let (composition, mut composition_error) = match GlassComposition::new(glass) {
            Ok(c) => (Some(c), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let mut previous = None;
        let mut ignored = false;
        let mut revision = u64::MAX;
        let mut oldscale = 0.;
        let mut blur_ok = composition.is_some();
        let mut cached_rects = None;
        let mut reported_rects = None;
        let mut applied_blur = None;
        loop {
            let mut msg = Msg::default();
            while PeekMessageW(&mut msg, 0, 0, 0, 1) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if IsWindow(main) == 0 {
                DestroyWindow(glass);
                break;
            }
            return_stray_focus(&w, &mut last_other);
            let visible = IsWindowVisible(main) != 0 && IsIconic(main) == 0;
            let scale = GetDpiForWindow(main) as f64 / 96.;
            let mut bounds = Rect::default();
            GetWindowRect(main, &mut bounds);
            let (blur, tint, strength, rev) = {
                let state = app.state::<State>();
                let s = state.0.lock().unwrap();
                if s.revision != revision {
                    reported_rects = s.rects.clone();
                }
                (s.blur, s.tint, s.strength, s.revision)
            };
            let rects = &reported_rects;
            let bounds_changed = previous != Some(bounds);
            // The glass stays up during a drag: hiding it is what made the window look
            // more transparent while moving. follow_main keeps the two together.
            let wanted_blur = (blur, tint, strength.to_bits());
            // Hit-test-only rects change as controls appear; they do not touch the glass.
            let blur_rects: Option<Vec<Surface>> = rects.as_ref().map(|all| all.iter().filter(|r| r.b).cloned().collect());
            if blur_rects != cached_rects || scale != oldscale || applied_blur != Some(wanted_blur) {
                // Tint is supplied by the existing web glass fill above this window.
                blur_ok = composition.as_ref().is_some_and(|c| {
                    match c.update(
                        if blur {
                            rects.as_deref().unwrap_or(&[])
                        } else {
                            &[]
                        },
                        scale,
                        strength,
                    ) {
                        Ok(()) => {
                            composition_error = None;
                            true
                        }
                        Err(e) => {
                            composition_error = Some(e.to_string());
                            false
                        }
                    }
                });
                cached_rects = blur_rects;
                oldscale = scale;
                applied_blur = Some(wanted_blur);
            }
            revision = rev;
            // HWND_NOTOPMOST explicitly drops the companion out of the topmost band.
            let topmost = GetWindowLongPtrW(main, -20) & 8 != 0;
            if (GetWindowLongPtrW(glass, -20) & 8 != 0) != topmost {
                SetWindowPos(
                    glass,
                    if topmost { -1 } else { -2 },
                    0,
                    0,
                    0,
                    0,
                    0x10 | 1 | 2,
                );
            }
            let show = visible
                && blur
                && blur_ok
                && rects.as_ref().is_some_and(|rs| !rs.is_empty());
            let glass_visible = IsWindowVisible(glass) != 0;
            if !show && glass_visible {
                ShowWindow(glass, 0);
            }
            if bounds_changed || !below_main(main, glass, true) || (show && !glass_visible) {
                // Besides the hook's positions, this repairs any missed one and the z-order.
                if SetWindowPos(
                    glass,
                    main,
                    bounds.left,
                    bounds.top,
                    bounds.right - bounds.left,
                    bounds.bottom - bounds.top,
                    0x10 | if show { 0x40 } else { 0 },
                ) != 0
                {
                    previous = Some(bounds);
                }
            }
            if !visible && ignored {
                if w.set_ignore_cursor_events(false).is_ok() {
                    ignored = false;
                }
            }
            let mut p = Point::default();
            if visible
                && GetCursorPos(&mut p) != 0
            {
                let desired = rects.as_ref().is_some_and(|rs| {
                    !rs.is_empty() && app.state::<State>().0.lock().unwrap().reported.elapsed().as_secs_f64() < 2. && !rs.iter().any(|r| {
                        r.hit((p.x - bounds.left) as f64, (p.y - bounds.top) as f64, scale)
                    })
                });
                if desired != ignored && (!desired || [1,2,4,5,6].iter().all(|k| GetAsyncKeyState(*k) >= 0)) && w.set_ignore_cursor_events(desired).is_ok() {
                    ignored = desired
                }
            }
            {
                let state = app.state::<State>();
                let mut s = state.0.lock().unwrap();
                s.debug.blur_ok = blur_ok;
                s.debug.composition_error = composition_error.clone();
                s.debug.composition_scale = scale;
                s.debug.composition_revision = revision;
                s.debug.glass_hwnd = glass;
                s.debug.main_hwnd = main;
                s.debug.ignoring = ignored;
            }
            // Pump dispatcher work promptly, but block between pointer/position samples.
            MsgWaitForMultipleObjectsEx(
                0,
                std::ptr::null(),
                if visible { 16 } else { 250 },
                0x04ff,
                0x0004,
            );
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
            b: true,
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
    fn physical_geometry_preserves_css_inset_at_100_and_150_percent() {
        let r = Surface {
            x: 28.,
            y: 28.,
            w: 460.,
            h: 74.,
            r: 24.,
            b: true,
        };
        for scale in [1., 1.5] {
            let p = r.physical_inset(scale).unwrap();
            assert_eq!(p.x, 29.5 * scale);
            assert_eq!(p.y, 29.5 * scale);
            assert_eq!(p.w, 457. * scale);
            assert_eq!(p.h, 71. * scale);
            assert_eq!(p.r, 22.5 * scale);
            assert!(p.hit(p.x + p.r, p.y, 1.));
        }
        assert!(Surface { w: 3., ..r.clone() }.physical_inset(1.5).is_none());
        let square = Surface { r: 0., ..r };
        assert_eq!(square.physical_inset(1.5).unwrap().r, 0.);
    }
    #[test]
    fn surface_blur_flag_defaults_on_and_survives_inset() {
        let r: Surface = serde_json::from_str(r#"{"x":0,"y":0,"w":20,"h":20,"r":4}"#).unwrap();
        assert!(r.b);
        let hit: Surface = serde_json::from_str(r#"{"x":0,"y":0,"w":20,"h":20,"r":4,"b":false}"#).unwrap();
        assert!(!hit.physical_inset(1.).unwrap().b);
    }
    #[test]
    fn shortcuts() {
        assert!(parse("Alt+Q").is_ok());
        assert!(parse("this is invalid").is_err());
    }
}
