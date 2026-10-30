use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::{
    core::{Interface, HSTRING},
    Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};
const BASES: [&str; 2] = [
    "__Secure-next-auth.session-token",
    "__Secure-authjs.session-token",
];
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Cookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    #[serde(rename = "expirationDate")]
    expiration: Option<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    cookies: Vec<Cookie>,
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn family(n: &str) -> Option<(usize, Option<usize>)> {
    for (i, b) in BASES.iter().enumerate() {
        if n == *b {
            return Some((i, None));
        }
        if let Some(s) = n.strip_prefix(&format!("{b}.")) {
            if !s.is_empty()
                && s.len() <= 2
                && (s == "0" || !s.starts_with('0'))
                && s.bytes().all(|c| c.is_ascii_digit())
            {
                return Some((i, Some(s.parse().ok()?)));
            }
        }
    }
    None
}
fn validate(cs: &[Cookie]) -> Result<(), ()> {
    if cs.is_empty() || cs.len() > 32 {
        return Err(());
    }
    let mut seen = BTreeMap::new();
    let mut fam = None;
    for c in cs {
        let (f, n) = family(&c.name).ok_or(())?;
        if fam.is_some_and(|x| x != f)
            || seen.insert(n, ()).is_some()
            || !matches!(c.domain.as_str(), "chatgpt.com" | ".chatgpt.com")
            || c.path != "/"
            || c.value.is_empty()
            || c.value.len() > 8192
            || !c.value.bytes().all(|b| b >= 0x21 && b <= 0x7e && b != b';')
            || c.expiration.is_some_and(|e| !e.is_finite() || e <= now())
        {
            return Err(());
        }
        fam = Some(f);
    }
    if seen.contains_key(&None) {
        if cs.len() != 1 {
            return Err(());
        }
    } else {
        for n in 0..cs.len() {
            if !seen.contains_key(&Some(n)) {
                return Err(());
            }
        }
    }
    Ok(())
}
struct Attempt {
    id: String,
    token: String,
    deadline: Instant,
    active: bool,
}
#[derive(Default)]
pub struct Receiver(Mutex<Option<Arc<Mutex<Attempt>>>>);
fn event(app: &tauri::AppHandle, id: &str, state: &str) {
    let _ = app.emit_to(
        "main",
        "qchat://browser-signin",
        serde_json::json!({"id":id,"state":state}),
    );
}
fn main_only(w: &tauri::WebviewWindow) -> Result<(), String> {
    if w.label() == "main" {
        Ok(())
    } else {
        Err("Not permitted".into())
    }
}
fn cancel(app: &tauri::AppHandle) {
    if let Some(a) = app.state::<Receiver>().0.lock().unwrap().take() {
        let mut a = a.lock().unwrap();
        if a.active {
            a.active = false;
            a.token.clear();
            event(app, &a.id, "cancelled")
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    id: String,
    url: String,
    expires_at: u64,
}
#[tauri::command]
pub fn begin_browser_signin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    consent: bool,
) -> Result<Started, String> {
    main_only(&window)?;
    if !consent {
        return Err("Consent required".into());
    }
    cancel(&app);
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "Receiver unavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Receiver unavailable")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Receiver unavailable")?
        .port();
    let mut bytes = [0u8; 48];
    getrandom::fill(&mut bytes).map_err(|_| "Secure random unavailable")?;
    let hex = |b: &[u8]| b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let token = hex(&bytes[..32]);
    let id = hex(&bytes[32..]);
    let result = Started {
        id: id.clone(),
        url: format!("http://127.0.0.1:{port}/qchat-connect#{token}"),
        expires_at: ((now() + 300.) * 1000.) as u64,
    };
    let a = Arc::new(Mutex::new(Attempt {
        id,
        token,
        deadline: Instant::now() + Duration::from_secs(300),
        active: true,
    }));
    *app.state::<Receiver>().0.lock().unwrap() = Some(a.clone());
    std::thread::spawn(move || {
        let mut count = 0;
        loop {
            {
                let mut g = a.lock().unwrap();
                if !g.active {
                    break;
                }
                if Instant::now() >= g.deadline {
                    g.active = false;
                    g.token.clear();
                    event(&app, &g.id, "expired");
                    break;
                }
            }
            match listener.accept() {
                Ok((mut s, _)) => {
                    count += 1;
                    if count > 128 {
                        let mut g = a.lock().unwrap();
                        g.active = false;
                        g.token.clear();
                        event(&app, &g.id, "error");
                        break;
                    }
                    serve(&mut s, port, &a, &app);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => break,
            }
        }
    });
    Ok(result)
}
#[tauri::command]
pub fn cancel_browser_signin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    main_only(&window)?;
    cancel(&app);
    Ok(())
}
fn origin(s: &str) -> bool {
    s.strip_prefix("chrome-extension://")
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}
struct Request {
    method: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
fn read_request(s: &mut TcpStream, valid: impl Fn() -> bool) -> Result<Request, ()> {
    s.set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|_| ())?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let first_byte_deadline = Instant::now() + Duration::from_millis(500);
    let mut b = Vec::new();
    let end = loop {
        if !valid()
            || Instant::now() > deadline
            || (b.is_empty() && Instant::now() > first_byte_deadline)
            || b.len() >= 8192
        {
            return Err(());
        }
        let mut c = [0];
        match s.read(&mut c) {
            Ok(1) => b.push(c[0]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            _ => return Err(()),
        }
        if b.ends_with(b"\r\n\r\n") {
            break b.len();
        }
    };
    let h = std::str::from_utf8(&b).map_err(|_| ())?;
    let mut lines = h.split("\r\n");
    let first = lines.next().ok_or(())?.split(' ').collect::<Vec<_>>();
    if first.len() != 3 || first[1] != "/qchat-connect" || first[2] != "HTTP/1.1" {
        return Err(());
    }
    let method = first[0].to_string();
    let mut headers = BTreeMap::new();
    for l in lines.filter(|l| !l.is_empty()) {
        let (k, v) = l.split_once(':').ok_or(())?;
        if k.is_empty()
            || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || headers
                .insert(k.to_ascii_lowercase(), v.trim().to_string())
                .is_some()
        {
            return Err(());
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err(());
    }
    let len = match headers.get("content-length") {
        Some(v) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => {
            v.parse::<usize>().map_err(|_| ())?
        }
        None if method != "POST" => 0,
        _ => return Err(()),
    };
    if len > 131072 {
        return Err(());
    }
    while b.len() - end < len {
        if !valid() || Instant::now() > deadline {
            return Err(());
        }
        let mut buf = [0; 4096];
        let limit = (len - (b.len() - end)).min(buf.len());
        match s.read(&mut buf[..limit]) {
            Ok(0) => return Err(()),
            Ok(n) => b.extend_from_slice(&buf[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                ()
            }
            _ => return Err(()),
        }
    }
    Ok(Request {
        method,
        headers,
        body: b[end..].to_vec(),
    })
}
fn response(s: &mut TcpStream, status: &str, origin: Option<&str>, body: &str) {
    let _ = s.set_write_timeout(Some(Duration::from_millis(200)));
    let cors=origin.map(|o|format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: POST\r\nAccess-Control-Allow-Headers: content-type, x-qchat-token\r\n")).unwrap_or_default();
    let _=write!(s,"HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nContent-Type: text/html; charset=utf-8\r\n{cors}Content-Length: {}\r\n\r\n{body}",body.len());
}
fn authenticated(a: &Attempt, token: Option<&str>) -> bool {
    a.active && Instant::now() < a.deadline && token == Some(a.token.as_str())
}
fn serve(s: &mut TcpStream, port: u16, a: &Arc<Mutex<Attempt>>, app: &tauri::AppHandle) {
    let r = read_request(s, || {
        let g = a.lock().unwrap();
        g.active && Instant::now() < g.deadline
    });
    let Ok(r) = r else {
        response(s, "400 Bad Request", None, "Request rejected");
        return;
    };
    if r.headers.get("host") != Some(&format!("127.0.0.1:{port}")) {
        response(s, "403 Forbidden", None, "");
        return;
    }
    let o = r.headers.get("origin").filter(|o| origin(o));
    if r.method == "GET" {
        response(s,"200 OK",None,"<!doctype html><title>QChat helper</title><h1>Connect your browser to QChat</h1><p>Only continue if you trust this QChat app and helper: your session grants access to your account.</p><p>Load the unpacked QChat helper once from the folder opened by QChat: use edge://extensions or chrome://extensions, enable Developer mode, then Load unpacked.</p><p>Sign into https://chatgpt.com in this browser, then return to this tab. Open the QChat helper from the browser toolbar, review the warning and confirm.</p>");
        return;
    }
    if r.method == "OPTIONS" {
        if o.is_some()
            && r.headers
                .get("access-control-request-method")
                .is_some_and(|m| m == "POST")
            && r.headers
                .get("access-control-request-headers")
                .is_some_and(|h| {
                    let mut h = h
                        .split(',')
                        .map(|s| s.trim().to_ascii_lowercase())
                        .collect::<Vec<_>>();
                    h.sort();
                    h == ["content-type", "x-qchat-token"]
                })
        {
            response(s, "204 No Content", o.map(String::as_str), "")
        } else {
            response(s, "403 Forbidden", None, "")
        }
        return;
    }
    let authorized = {
        let g = a.lock().unwrap();
        authenticated(&g, r.headers.get("x-qchat-token").map(String::as_str))
    };
    if r.method != "POST"
        || o.is_none()
        || !authorized
        || r.headers.get("content-type").map(String::as_str) != Some("application/json")
    {
        response(s, "403 Forbidden", None, "");
        return;
    }
    let cs = serde_json::from_slice::<Payload>(&r.body)
        .ok()
        .filter(|p| validate(&p.cookies).is_ok());
    let Some(cs) = cs else {
        response(
            s,
            "400 Bad Request",
            o.map(String::as_str),
            "Invalid session cookies",
        );
        return;
    };
    let ac = a.clone();
    let callback_app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    crate::resume(app);
    let result = app.get_webview_window("chatgpt").ok_or(()).and_then(|w| {
        let navigate_home = w
            .url()
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .as_deref()
            != Some("chatgpt.com");
        w.with_webview(move |w| {
            let mut g = ac.lock().unwrap();
            let committing = g.active && Instant::now() < g.deadline;
            let result = if !committing {
                Err(())
            } else {
                g.active = false;
                g.token.clear();
                unsafe {
                    (|| -> windows::core::Result<()> {
                        let core = w.controller().CoreWebView2()?;
                        let manager = core.cast::<ICoreWebView2_2>()?.CookieManager()?;
                        for base in BASES {
                            for n in std::iter::once(base.to_string())
                                .chain((0..32).map(|i| format!("{base}.{i}")))
                            {
                                manager.DeleteCookies(
                                    &HSTRING::from(n),
                                    &HSTRING::from("https://chatgpt.com/"),
                                )?;
                            }
                        }
                        for c in cs.cookies {
                            let cookie = manager.CreateCookie(
                                &HSTRING::from(c.name),
                                &HSTRING::from(c.value),
                                &HSTRING::from(c.domain),
                                &HSTRING::from("/"),
                            )?;
                            if let Some(e) = c.expiration {
                                cookie.SetExpires(e)?;
                            }
                            cookie.SetIsSecure(true)?;
                            cookie.SetIsHttpOnly(true)?;
                            manager.AddOrUpdateCookie(&cookie)?;
                        }
                        if navigate_home {
                            core.Navigate(&HSTRING::from("https://chatgpt.com/"))?;
                        } else {
                            core.Reload()?;
                        }
                        Ok(())
                    })()
                    .map_err(|_| ())
                }
            };
            if committing {
                event(
                    &callback_app,
                    &g.id,
                    if result.is_ok() { "imported" } else { "error" },
                );
            }
            let _ = tx.send(result);
        })
        .map_err(|_| ())
    });
    let ok = result.is_ok()
        && rx
            .recv_timeout(Duration::from_secs(5))
            .is_ok_and(|r| r.is_ok());
    if !ok {
        let mut g = a.lock().unwrap();
        if g.active {
            g.active = false;
            g.token.clear();
            event(app, &g.id, "error");
        }
    }
    response(
        s,
        if ok { "200 OK" } else { "409 Conflict" },
        o.map(String::as_str),
        if ok {
            "Imported. QChat will check sign-in."
        } else {
            "Import unavailable"
        },
    );
}
#[tauri::command]
pub async fn disconnect_chatgpt(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    main_only(&window)?;
    cancel(&app);
    crate::resume(&app);
    let (tx, rx) = std::sync::mpsc::channel();
    app.get_webview_window("chatgpt")
        .ok_or("ChatGPT unavailable")?
        .with_webview(move |w| {
            let result = unsafe {
                (|| -> windows::core::Result<()> {
                    let core = w.controller().CoreWebView2()?;
                    core.cast::<ICoreWebView2_2>()?
                        .CookieManager()?
                        .DeleteAllCookies()?;
                    core.Navigate(&HSTRING::from("https://chatgpt.com/"))?;
                    Ok(())
                })()
            }
            .map_err(|_| "Disconnect unavailable".to_string());
            let _ = tx.send(result);
        })
        .map_err(|_| "Disconnect unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Disconnect unavailable".to_string())?
    })
    .await
    .map_err(|_| "Disconnect unavailable".to_string())?
}
#[tauri::command]
pub fn open_browser_helper(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    main_only(&window)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Helper unavailable")?
        .join("browser-helper");
    std::fs::create_dir_all(&path).map_err(|_| "Helper unavailable")?;
    for (name, data) in [
        (
            "manifest.json",
            include_str!("../../browser-helper/manifest.json"),
        ),
        (
            "popup.html",
            include_str!("../../browser-helper/popup.html"),
        ),
        ("popup.js", include_str!("../../browser-helper/popup.js")),
        ("helper.js", include_str!("../../browser-helper/helper.js")),
    ] {
        std::fs::write(path.join(name), data).map_err(|_| "Helper unavailable")?;
    }
    let r = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(path.as_os_str()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if r.0 as isize <= 32 {
        Err("Helper unavailable".into())
    } else {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn cookie(n: &str) -> Cookie {
        Cookie {
            name: n.into(),
            value: "synthetic".into(),
            domain: ".chatgpt.com".into(),
            path: "/".into(),
            expiration: Some(now() + 100.),
        }
    }
    #[test]
    fn allowlist_and_chunks() {
        let b = BASES[0];
        assert!(validate(&[cookie(b)]).is_ok());
        assert!(validate(&[cookie(&format!("{b}.0")), cookie(&format!("{b}.1"))]).is_ok());
        for cs in [
            vec![],
            vec![cookie("other")],
            vec![cookie(b), cookie(BASES[1])],
            vec![cookie(b), cookie(b)],
            vec![cookie(&format!("{b}.1"))],
            vec![cookie(b), cookie(&format!("{b}.0"))],
        ] {
            assert!(validate(&cs).is_err())
        }
        let mut c = cookie(b);
        c.domain = "other.com".into();
        assert!(validate(&[c]).is_err());
        let mut c = cookie(b);
        c.expiration = Some(now() - 1.);
        assert!(validate(&[c]).is_err());
    }
    #[test]
    fn origins() {
        assert!(origin(&format!("chrome-extension://{}", "a".repeat(32))));
        for o in ["https://chatgpt.com", "null", "chrome-extension://xyz", ""] {
            assert!(!origin(o))
        }
    }
    fn parse(raw: &[u8], valid: bool) -> Result<Request, ()> {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        client.write_all(raw).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let (mut s, _) = l.accept().unwrap();
        read_request(&mut s, || valid)
    }
    #[test]
    fn framing_and_cancel() {
        assert!(parse(
            b"POST /qchat-connect HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 2\r\n\r\n{}",
            true
        )
        .is_ok());
        for r in ["POST /qchat-connect HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n","POST /qchat-connect HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n","POST /qchat-connect HTTP/1.1\r\nContent-Length: +1\r\n\r\nx","POST /qchat-connect HTTP/1.1\r\nContent-Length: 999999\r\n\r\n"]{assert!(parse(r.as_bytes(),true).is_err())}
        assert!(parse(b"GET /qchat-connect HTTP/1.1\r\n\r\n", false).is_err())
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    #[test]
    fn auth_expiry_cancel_replay() {
        let mut a = Attempt {
            id: "public".into(),
            token: "synthetic".into(),
            deadline: Instant::now() + Duration::from_secs(60),
            active: true,
        };
        assert!(!authenticated(&a, None));
        assert!(!authenticated(&a, Some("wrong")));
        assert!(authenticated(&a, Some("synthetic")));
        a.active = false;
        assert!(!authenticated(&a, Some("synthetic")));
        a.active = true;
        a.deadline = Instant::now() - Duration::from_secs(1);
        assert!(!authenticated(&a, Some("synthetic")));
    }
}
