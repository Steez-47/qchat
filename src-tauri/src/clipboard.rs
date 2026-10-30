use base64::{engine::general_purpose::STANDARD, Engine};
use windows::Win32::{
    Foundation::{GlobalFree, HANDLE, HGLOBAL},
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
};

const MAX_PIXELS: usize = 16 * 1024 * 1024;
fn bitmap(rgba: &[u8], width: u32, height: u32, alpha: bool) -> Result<Vec<u8>, String> {
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or("Image too large")?;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || pixels > MAX_PIXELS
        || rgba.len() != pixels * 4
    {
        return Err("Invalid image dimensions".into());
    }
    let header = if alpha { 124 } else { 40 };
    let stride = if alpha {
        width as usize * 4
    } else {
        (width as usize * 3 + 3) & !3
    };
    let mut dib = vec![0u8; header + stride * height as usize];
    dib[..4].copy_from_slice(&(header as u32).to_le_bytes());
    dib[4..8].copy_from_slice(&width.to_le_bytes());
    dib[8..12].copy_from_slice(
        &(if alpha {
            -(height as i32)
        } else {
            height as i32
        })
        .to_le_bytes(),
    );
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&(if alpha { 32u16 } else { 24u16 }).to_le_bytes());
    dib[20..24].copy_from_slice(&((stride * height as usize) as u32).to_le_bytes());
    if alpha {
        dib[16..20].copy_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
        for (offset, mask) in [
            (40, 0x00ff0000u32),
            (44, 0x0000ff00),
            (48, 0x000000ff),
            (52, 0xff000000),
            (56, 0x73524742),
            (108, 4),
        ] {
            dib[offset..offset + 4].copy_from_slice(&mask.to_le_bytes());
        }
    }
    for y in 0..height as usize {
        for x in 0..width as usize {
            let src = (y * width as usize + x) * 4;
            let dst = header
                + (if alpha { y } else { height as usize - y - 1 }) * stride
                + x * if alpha { 4 } else { 3 };
            for (channel, source) in [2, 1, 0].into_iter().enumerate() {
                dib[dst + channel] = if alpha {
                    rgba[src + source]
                } else {
                    ((rgba[src + source] as u32 * rgba[src + 3] as u32
                        + 255 * (255 - rgba[src + 3] as u32)
                        + 127)
                        / 255) as u8
                };
            }
            if alpha {
                dib[dst + 3] = rgba[src + 3];
            }
        }
    }
    Ok(dib)
}
struct Memory(HGLOBAL);
impl Drop for Memory {
    fn drop(&mut self) {
        unsafe {
            let _ = GlobalFree(Some(self.0));
        }
    }
}
impl Memory {
    fn new(bytes: &[u8]) -> Result<Self, String> {
        unsafe {
            let memory = Self(
                GlobalAlloc(GMEM_MOVEABLE, bytes.len())
                    .map_err(|_| "Clipboard allocation failed")?,
            );
            let pointer = GlobalLock(memory.0);
            if pointer.is_null() {
                return Err("Clipboard allocation failed".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(memory.0);
            Ok(memory)
        }
    }
    fn give(self, format: u32) -> Result<(), String> {
        unsafe {
            SetClipboardData(format, Some(HANDLE(self.0 .0)))
                .map_err(|_| "Could not copy image")?;
            std::mem::forget(self);
            Ok(())
        }
    }
}
#[tauri::command]
pub fn image_copy(
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
    rgba: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Not permitted".into());
    }
    if rgba.len() > MAX_PIXELS * 4 * 4 / 3 + 4 {
        return Err("Image is too large to copy".into());
    }
    let bytes = STANDARD.decode(rgba).map_err(|_| "Invalid image data")?;
    let alpha = Memory::new(&bitmap(&bytes, width, height, true)?)?;
    let compatible = Memory::new(&bitmap(&bytes, width, height, false)?)?;
    let owner = window.hwnd().map_err(|_| "Window unavailable")?;
    unsafe {
        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(Some(owner)).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened {
            return Err("Clipboard is busy. Try copying again.".into());
        }
        struct Close;
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _close = Close;
        EmptyClipboard().map_err(|_| "Clipboard is unavailable")?;
        alpha.give(17)?;
        compatible.give(8)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_bitmaps_preserve_pixels_and_alpha() {
        let rgba = [255, 0, 0, 255, 0, 0, 255, 0];
        let v5 = bitmap(&rgba, 2, 1, true).unwrap();
        assert_eq!(&v5[124..], &[0, 0, 255, 255, 255, 0, 0, 0]);
        assert_eq!(i32::from_le_bytes(v5[8..12].try_into().unwrap()), -1);
        let dib = bitmap(&rgba, 2, 1, false).unwrap();
        assert_eq!(&dib[40..], &[0, 0, 255, 255, 255, 255, 0, 0]);
        assert!(bitmap(&[], 0, 1, true).is_err());
        assert!(bitmap(&[0; 4], 2, 1, true).is_err());
        assert!(bitmap(&[], 16385, 1, true).is_err());
    }
}
