use base64::{engine::general_purpose::STANDARD, Engine};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
    Graphics::Gdi::*,
    UI::WindowsAndMessaging::*,
};
static TARGET: Mutex<Option<(isize, u32)>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);
#[link(name = "user32")]
unsafe extern "system" {
    fn PrintWindow(hwnd: HWND, dc: HDC, flags: u32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn QueryFullProcessImageNameW(
        process: isize,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}
unsafe fn owner(h: HWND) -> Result<Option<u32>, ()> {
    if !IsWindow(Some(h)).as_bool() {
        return Ok(None);
    }
    let mut pid = 0;
    GetWindowThreadProcessId(h, Some(&mut pid));
    if pid == 0 || pid == std::process::id() {
        return Ok(None);
    }
    let process = OpenProcess(0x1000, 0, pid);
    if process == 0 {
        return Err(());
    }
    let mut name = [0u16; 32768];
    let mut len = name.len() as u32;
    let ok = QueryFullProcessImageNameW(process, 0, name.as_mut_ptr(), &mut len);
    CloseHandle(process);
    if ok == 0 {
        return Err(());
    }
    let path = String::from_utf16_lossy(&name[..len as usize]);
    let own = std::env::current_exe().map_err(|_| ())?;
    let file = std::path::Path::new(&path)
        .file_name()
        .ok_or(())?
        .to_string_lossy();
    if file.eq_ignore_ascii_case("qchat.exe")
        || own
            .file_name()
            .ok_or(())?
            .to_string_lossy()
            .eq_ignore_ascii_case(&file)
    {
        return Ok(None);
    }
    if matches!(
        file.to_ascii_lowercase().as_str(),
        "startmenuexperiencehost.exe" | "shellexperiencehost.exe" | "searchhost.exe"
    ) {
        return Ok(None);
    }
    Ok(Some(pid))
}
unsafe fn eligible(h: HWND) -> Result<Option<u32>, ()> {
    if !IsWindowVisible(h).as_bool()
        || IsIconic(h).as_bool()
        || h == GetDesktopWindow()
        || h == GetShellWindow()
        || GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0
    {
        return Ok(None);
    }
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(
        h,
        DWMWA_CLOAKED,
        (&mut cloaked as *mut u32).cast(),
        std::mem::size_of::<u32>() as u32,
    );
    let mut bounds = RECT::default();
    if cloaked != 0
        || GetWindowRect(h, &mut bounds).is_err()
        || bounds.right - bounds.left < 64
        || bounds.bottom - bounds.top < 48
    {
        return Ok(None);
    }
    let mut class = [0u16; 256];
    let n = GetClassNameW(h, &mut class);
    if matches!(
        String::from_utf16_lossy(&class[..n.max(0) as usize]).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return Ok(None);
    }
    owner(h)
}
fn record_target(
    current: &mut Option<(isize, u32)>,
    handle: isize,
    candidate: Result<Option<u32>, ()>,
) {
    match candidate {
        Ok(Some(pid)) => *current = Some((handle, pid)),
        Err(()) => *current = None, // Never substitute an older app for an inaccessible one.
        Ok(None) => {}              // QChat and transient shell surfaces preserve the app target.
    }
}
pub fn observe_foreground() {
    unsafe {
        let mut target = TARGET.lock().unwrap();
        let h = GetForegroundWindow();
        // This runs with the glass loop. Recheck ownership at capture time instead of
        // opening and querying the same external process on every display tick.
        if let Some((handle, pid)) = *target {
            if h.0 as isize == handle {
                let mut current_pid = 0;
                GetWindowThreadProcessId(h, Some(&mut current_pid));
                if current_pid == pid {
                    return;
                }
            }
        }
        record_target(&mut target, h.0 as isize, eligible(h));
    }
}
pub(crate) fn selection_target() -> Result<(isize, u32), String> {
    observe_foreground();
    let target = TARGET.lock().unwrap().ok_or("No previous external app window is available")?;
    if !valid_target(target) {
        return Err("The previous app window is no longer available".into());
    }
    Ok(target)
}
pub(crate) fn valid_target(target: (isize, u32)) -> bool {
    unsafe { eligible(HWND(target.0 as *mut _)) == Ok(Some(target.1)) }
}
fn size(w: i32, h: i32) -> Result<usize, String> {
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 || (w as u64 * h as u64) > 16 * 1024 * 1024 {
        return Err("Snapshot window is too large or has invalid dimensions".into());
    }
    Ok(w as usize * h as usize * 4)
}
fn encode(bgra: &[u8], w: i32, h: i32) -> Result<Vec<u8>, String> {
    if bgra.len() != size(w, h)? {
        return Err("Invalid snapshot pixels".into());
    }
    let mut rgba = bgra.to_vec();
    for p in rgba.chunks_exact_mut(4) {
        p.swap(0, 2);
        p[3] = 255;
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}
struct Dib {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
}
impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            if !self.old.0.is_null() {
                SelectObject(self.dc, self.old);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(self.bitmap.into());
            }
            let _ = DeleteDC(self.dc);
        }
    }
}
unsafe fn capture(target: (isize, u32)) -> Result<Vec<u8>, String> {
    let hwnd = HWND(target.0 as *mut _);
    if eligible(hwnd) != Ok(Some(target.1)) {
        return Err("The previous app window is unavailable or minimized".into());
    }
    let mut rect = RECT::default();
    GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    let bytes = size(w, h)?;
    let dc = CreateCompatibleDC(None);
    if dc.0.is_null() {
        return Err("Cannot create snapshot context".into());
    }
    let mut dib = Dib {
        dc,
        bitmap: HBITMAP::default(),
        old: HGDIOBJ::default(),
    };
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = w;
    info.bmiHeader.biHeight = -h;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    let mut bits = std::ptr::null_mut();
    dib.bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        .map_err(|e| e.to_string())?;
    dib.old = SelectObject(dc, dib.bitmap.into());
    if dib.old.0.is_null() || dib.old.0 as isize == -1 {
        return Err("Cannot select snapshot bitmap".into());
    }
    std::ptr::write_bytes(bits, 0, bytes);
    if PrintWindow(hwnd, dc, 2) == 0 {
        return Err("This app does not support window capture".into());
    }
    let _ = GdiFlush();
    if eligible(hwnd) != Ok(Some(target.1)) {
        return Err("Snapshot target became unavailable".into());
    }
    let pixels = std::slice::from_raw_parts(bits as *const u8, bytes);
    if pixels.chunks_exact(4).all(|p| p[..3] == [0, 0, 0]) {
        return Err("The app returned a blank or protected snapshot".into());
    }
    encode(pixels, w, h)
}
#[derive(serde::Serialize)]
pub struct Snapshot {
    name: String,
    mime: &'static str,
    data: String,
}
#[tauri::command]
pub async fn snapshot_capture(window: tauri::WebviewWindow) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("Main window only".into());
    }
    observe_foreground();
    let target = *TARGET.lock().unwrap();
    #[cfg(debug_assertions)]
    let target = {
        let mut target = target;
        if crate::test_profile().is_some() {
            // Explicit isolated harness target prevents tests from capturing user content.
            if let Ok(value) = std::env::var("QCHAT_TEST_SNAPSHOT_HWND") {
                let raw = if value == "self" {
                    window.hwnd().map_err(|e| e.to_string())?.0 as isize
                } else {
                    value.parse::<isize>().map_err(|_| "Invalid test target")?
                };
                let h = HWND(raw as *mut _);
                let mut pid = 0;
                unsafe {
                    GetWindowThreadProcessId(h, Some(&mut pid));
                }
                target = Some((raw, pid));
            }
        }
        target
    };
    let target = target.ok_or("No previous external app window is available")?;
    if BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A snapshot capture is still running".into());
    }
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    // A timed-out PrintWindow cannot be safely killed. Keep the gate held until it exits,
    // bounding stuck native work to one thread, with no retries or focus manipulation.
    if let Err(e) = std::thread::Builder::new()
        .name("snapshot".into())
        .spawn(move || {
            struct Gate;
            impl Drop for Gate {
                fn drop(&mut self) {
                    BUSY.store(false, Ordering::Release);
                }
            }
            let _gate = Gate;
            let _ = tx.send(unsafe { capture(target) });
        })
    {
        BUSY.store(false, Ordering::Release);
        return Err(e.to_string());
    }
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(4), &mut rx)
        .await
        .map_err(|_| "Window capture timed out; this app may not support capture")?
        .map_err(|_| "Snapshot worker failed")??;
    Ok(Snapshot {
        name: "Snapshot.png".into(),
        mime: "image/png",
        data: STANDARD.encode(bytes),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_changes_do_not_substitute_an_older_app() {
        let mut current = Some((10, 100));
        record_target(&mut current, 20, Ok(Some(200)));
        assert_eq!(current, Some((20, 200)));
        record_target(&mut current, 30, Ok(None));
        assert_eq!(current, Some((20, 200)));
        record_target(&mut current, 40, Err(()));
        assert_eq!(current, None);
        record_target(&mut current, 30, Ok(None));
        assert_eq!(current, None);
    }
    #[test]
    fn limits() {
        for (w, h) in [(0, 1), (-1, 1), (16385, 1), (8192, 8192)] {
            assert!(size(w, h).is_err());
        }
        assert_eq!(size(2, 3).unwrap(), 24);
    }
    #[test]
    fn pixels() {
        let bytes = encode(&[3, 2, 1, 0, 6, 5, 4, 0], 2, 1).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut out = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut out).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&out[..8], &[1, 2, 3, 255, 4, 5, 6, 255]);
        assert!(encode(&[], 1, 1).is_err());
    }
}
