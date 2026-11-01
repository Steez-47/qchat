// Updates from GitHub releases.
//
// update_check asks GitHub for the latest published release and remembers it when it is newer
// than this build. update_install downloads that release's portable QChat.exe (the same binary
// the installer ships), checks its SHA-256 against the digest GitHub reports for the asset or
// against the release's SHA256SUMS.txt, swaps it in for the running executable and relaunches.
//
// The web view never chooses what is downloaded: it can only ask to install the release this
// module found, and only files from this repository's release downloads are accepted.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        Foundation::CloseHandle,
        Networking::WinHttp::*,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    },
};

const LATEST: &str = "https://api.github.com/repos/Steez-47/qchat/releases/latest";
const DOWNLOADS: &str = "https://github.com/Steez-47/qchat/releases/download/";
const PAGES: &str = "https://github.com/Steez-47/qchat/releases/";
const ASSET: &str = "QChat.exe";
const SUMS: &str = "SHA256SUMS.txt";
const MAX_JSON: usize = 4 << 20;
const MAX_EXE: usize = 128 << 20;
const RESTART_ARG: &str = "--updated-from";

type Version = (u64, u64, u64);

#[derive(Clone, Debug, PartialEq)]
struct Release {
    version: Version,
    label: String,
    page: String,
    exe_url: String,
    size: u64,
    sha256: Option<String>,
    sums_url: Option<String>,
}

#[derive(Default)]
pub struct State {
    found: Mutex<Option<Release>>,
    installing: AtomicBool,
}

fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim().trim_start_matches(['v', 'V']);
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut next = |required: bool| match parts.next() {
        Some(p) => p.parse::<u64>().ok(),
        None if required => None,
        None => Some(0),
    };
    let version = (next(true)?, next(false)?, next(false)?);
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

fn current() -> Version {
    parse_version(env!("CARGO_PKG_VERSION")).expect("package version")
}

fn hex_digest(text: &str) -> Option<String> {
    let hex = text.trim().to_ascii_lowercase();
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

fn parse_release(json: &Value) -> Result<Release, String> {
    if json["draft"].as_bool() == Some(true) || json["prerelease"].as_bool() == Some(true) {
        return Err("no_release".into());
    }
    let tag = json["tag_name"].as_str().ok_or("no_release")?;
    let version = parse_version(tag).ok_or("bad_version")?;
    let page = json["html_url"].as_str().filter(|u| u.starts_with(PAGES)).ok_or("no_release")?;
    let assets = json["assets"].as_array().ok_or("no_asset")?;
    let find = |name: &str| {
        assets.iter().find(|a| {
            a["name"].as_str() == Some(name)
                && a["browser_download_url"].as_str().is_some_and(|u| u.starts_with(DOWNLOADS))
        })
    };
    let exe = find(ASSET).ok_or("no_asset")?;
    let sha256 = exe["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).and_then(hex_digest);
    let sums_url = find(SUMS).and_then(|a| a["browser_download_url"].as_str()).map(str::to_owned);
    if sha256.is_none() && sums_url.is_none() {
        return Err("no_checksum".into());
    }
    Ok(Release {
        version,
        label: format!("{}.{}.{}", version.0, version.1, version.2),
        page: page.to_owned(),
        exe_url: exe["browser_download_url"].as_str().unwrap_or_default().to_owned(),
        size: exe["size"].as_u64().unwrap_or(0),
        sha256,
        sums_url,
    })
}

// A SHA256SUMS.txt line is "<hex>  <name>" (or "<hex> *<name>" from binary-mode tools).
fn sum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.trim().split_once(char::is_whitespace)?;
        (file.trim().trim_start_matches('*') == name).then(|| hex_digest(hash)).flatten()
    })
}

struct Handle(*mut core::ffi::c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}
fn handle(raw: *mut core::ffi::c_void) -> Result<Handle, String> {
    if raw.is_null() {
        Err(format!("offline: {}", windows::core::Error::from_thread()))
    } else {
        Ok(Handle(raw))
    }
}

// HTTPS GET through the system's proxy settings. WinHTTP follows GitHub's redirect from the
// release download to its asset host by itself.
fn get(url: &str, accept: &str, limit: usize, mut progress: impl FnMut(usize)) -> Result<Vec<u8>, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("https_only".into());
    }
    let host = parsed.host_str().ok_or("bad_url")?;
    let path = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_owned(),
    };
    let offline = |e: windows::core::Error| format!("offline: {e}");
    unsafe {
        let agent = HSTRING::from(format!("QChat/{}", env!("CARGO_PKG_VERSION")));
        let session = handle(WinHttpOpen(&agent, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0))?;
        WinHttpSetTimeouts(session.0, 15_000, 15_000, 30_000, 60_000).map_err(offline)?;
        let connect = handle(WinHttpConnect(session.0, &HSTRING::from(host), parsed.port_or_known_default().unwrap_or(443), 0))?;
        let request = handle(WinHttpOpenRequest(connect.0, w!("GET"), &HSTRING::from(path), PCWSTR::null(), PCWSTR::null(), std::ptr::null(), WINHTTP_FLAG_SECURE))?;
        let headers: Vec<u16> = format!("Accept: {accept}\r\nCache-Control: no-cache").encode_utf16().collect();
        WinHttpSendRequest(request.0, Some(&headers), None, 0, 0, 0).map_err(offline)?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(offline)?;
        let mut status = 0u32;
        let mut length = std::mem::size_of::<u32>() as u32;
        WinHttpQueryHeaders(request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, PCWSTR::null(), Some(&mut status as *mut u32 as *mut _), &mut length, std::ptr::null_mut()).map_err(offline)?;
        if status != 200 {
            return Err(format!("http_{status}"));
        }
        let mut body = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            WinHttpReadData(request.0, chunk.as_mut_ptr() as *mut _, chunk.len() as u32, &mut read).map_err(offline)?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read as usize]);
            if body.len() > limit {
                return Err("too_large".into());
            }
            progress(body.len());
        }
        Ok(body)
    }
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Value, String> {
    let now = current();
    let label = env!("CARGO_PKG_VERSION");
    // Test profiles stay offline.
    if crate::test_profile().is_some() {
        return Ok(json!({"available": false, "current": label}));
    }
    let body = tauri::async_runtime::spawn_blocking(|| get(LATEST, "application/vnd.github+json", MAX_JSON, |_| {}))
        .await
        .map_err(|e| e.to_string())??;
    let json: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let release = parse_release(&json)?;
    let available = release.version > now;
    let result = json!({"available": available, "version": release.label, "current": label, "url": release.page});
    *app.state::<State>().found.lock().unwrap() = available.then_some(release);
    Ok(result)
}

fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    exe.with_file_name(name)
}

// Windows lets a running executable be renamed but not overwritten, so the old one steps
// aside as "<name>.old" and is deleted by the next launch.
fn swap(exe: &Path, bytes: &[u8]) -> Result<(), String> {
    let new = sibling(exe, ".new");
    let old = sibling(exe, ".old");
    std::fs::write(&new, bytes).map_err(|e| format!("not_writable: {e}"))?;
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(exe, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(format!("not_writable: {e}"));
    }
    if let Err(e) = std::fs::rename(&new, exe) {
        let _ = std::fs::rename(&old, exe);
        let _ = std::fs::remove_file(&new);
        return Err(format!("not_writable: {e}"));
    }
    Ok(())
}
fn restore(exe: &Path) {
    let old = sibling(exe, ".old");
    if old.exists() {
        let _ = std::fs::remove_file(exe);
        let _ = std::fs::rename(old, exe);
    }
}

fn download(app: &tauri::AppHandle, release: &Release) -> Result<Vec<u8>, String> {
    let expected = match (&release.sha256, &release.sums_url) {
        (Some(hash), _) => hash.clone(),
        (None, Some(url)) => {
            let sums = get(url, "application/octet-stream", MAX_JSON, |_| {})?;
            sum_for(&String::from_utf8_lossy(&sums), ASSET).ok_or("no_checksum")?
        }
        (None, None) => return Err("no_checksum".into()),
    };
    let total = release.size;
    let mut shown = u64::MAX;
    let bytes = get(&release.exe_url, "application/octet-stream", MAX_EXE, |received| {
        let percent = if total > 0 { (received as u64 * 100 / total).min(100) } else { 0 };
        if percent != shown {
            shown = percent;
            let _ = app.emit_to("main", "qchat://update-progress", json!({"received": received, "total": total}));
        }
    })?;
    if total > 0 && bytes.len() as u64 != total {
        return Err("incomplete".into());
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err("checksum_mismatch".into());
    }
    if !bytes.starts_with(b"MZ") {
        return Err("not_executable".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let release = state.found.lock().unwrap().clone().ok_or("no_update")?;
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bytes = download(&worker, &release)?;
        swap(&exe, &bytes)?;
        if let Err(e) = std::process::Command::new(&exe).arg(RESTART_ARG).arg(std::process::id().to_string()).spawn() {
            restore(&exe);
            return Err(format!("relaunch_failed: {e}"));
        }
        Ok(exe)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    match result {
        Ok(_) => {
            crate::quit_app(app.clone());
            Ok(())
        }
        Err(e) => {
            app.state::<State>().installing.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}

/// Whether this launch is the relaunch after an update.
pub fn relaunched() -> bool {
    std::env::args().any(|a| a == RESTART_ARG)
}

/// Runs first thing in main. A relaunch after an update waits for the old process to exit, so
/// single-instance doesn't hand this launch back to it. Every launch clears a leftover old exe.
pub fn after_restart() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pid) = args.iter().position(|a| a == RESTART_ARG).and_then(|i| args.get(i + 1)).and_then(|p| p.parse::<u32>().ok()) {
        unsafe {
            if let Ok(process) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                let _ = WaitForSingleObject(process, 15_000);
                let _ = CloseHandle(process);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let old = sibling(&exe, ".old");
        if old.exists() {
            std::thread::spawn(move || {
                for _ in 0..40 {
                    if std::fs::remove_file(&old).is_ok() || !old.exists() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_json(digest: Option<&str>, sums: bool) -> Value {
        let mut exe = json!({"name": "QChat.exe", "size": 6174720, "browser_download_url": "https://github.com/Steez-47/qchat/releases/download/v1.5.0/QChat.exe"});
        if let Some(d) = digest {
            exe["digest"] = json!(d);
        }
        let mut assets = vec![json!({"name": "QChat_1.5.0_x64-setup.exe", "browser_download_url": "https://github.com/Steez-47/qchat/releases/download/v1.5.0/QChat_1.5.0_x64-setup.exe"}), exe];
        if sums {
            assets.push(json!({"name": "SHA256SUMS.txt", "browser_download_url": "https://github.com/Steez-47/qchat/releases/download/v1.5.0/SHA256SUMS.txt"}));
        }
        json!({"tag_name": "v1.5.0", "draft": false, "prerelease": false, "html_url": "https://github.com/Steez-47/qchat/releases/tag/v1.5.0", "assets": assets})
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(parse_version("v1.4.1"), Some((1, 4, 1)));
        assert_eq!(parse_version("2.0"), Some((2, 0, 0)));
        assert_eq!(parse_version("1.10.0-beta.1"), Some((1, 10, 0)));
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("latest"), None);
        assert!(parse_version("1.10.0") > parse_version("1.9.9"));
        assert_eq!(current(), parse_version(env!("CARGO_PKG_VERSION")).unwrap());
    }

    #[test]
    fn release_uses_github_digest_or_checksums_file() {
        let hash = "73ea650e184d73ea34b72b831ec6716fb965216a30ef63b5a4dcd14947eb1036";
        let r = parse_release(&release_json(Some(&format!("sha256:{}", hash.to_uppercase())), false)).unwrap();
        assert_eq!(r.version, (1, 5, 0));
        assert_eq!(r.label, "1.5.0");
        assert_eq!(r.sha256.as_deref(), Some(hash));
        assert!(r.exe_url.ends_with("/v1.5.0/QChat.exe"));
        assert_eq!(r.size, 6174720);
        let r = parse_release(&release_json(None, true)).unwrap();
        assert_eq!(r.sha256, None);
        assert!(r.sums_url.unwrap().ends_with("SHA256SUMS.txt"));
        assert_eq!(parse_release(&release_json(None, false)), Err("no_checksum".into()));
    }

    #[test]
    fn release_rejects_drafts_and_foreign_downloads() {
        let mut draft = release_json(Some("sha256:00"), true);
        draft["prerelease"] = json!(true);
        assert!(parse_release(&draft).is_err());
        let mut foreign = release_json(None, true);
        foreign["assets"][1]["browser_download_url"] = json!("https://example.com/QChat.exe");
        assert_eq!(parse_release(&foreign), Err("no_asset".into()));
        let mut page = release_json(None, true);
        page["html_url"] = json!("https://example.com/");
        assert!(parse_release(&page).is_err());
    }

    #[test]
    fn checksums_file_lines_are_matched_by_name() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let sums = format!("{a}  QChat_1.5.0_x64-setup.exe\n{b} *QChat.exe\n");
        assert_eq!(sum_for(&sums, "QChat.exe"), Some("b".repeat(64)));
        assert_eq!(sum_for(&sums, "QChat"), None);
        assert_eq!(sum_for("zz  QChat.exe", "QChat.exe"), None);
    }

    #[test]
    fn swap_replaces_the_file_and_keeps_the_old_one_aside() {
        let dir = std::env::temp_dir().join(format!("qchat-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("qchat.exe");
        std::fs::write(&exe, b"old").unwrap();
        swap(&exe, b"new").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(std::fs::read(sibling(&exe, ".old")).unwrap(), b"old");
        assert!(!sibling(&exe, ".new").exists());
        restore(&exe);
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(dir);
    }
}
