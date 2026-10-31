use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use windows::core::HSTRING;

const LIMIT: u64 = 512 * 1024 * 1024;
const CHUNK: usize = 512 * 1024;
const RETRY_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize)]
pub struct Attachment {
    id: String,
    name: String,
    mime: String,
    size: u64,
    kind: String,
}
struct Staged {
    meta: Attachment,
    path: PathBuf,
    written: u64,
    ready: bool,
    owner: Option<String>,
    retry_until: Option<Instant>,
    dispatched: bool,
}
#[derive(Clone)]
struct Cached {
    id: String,
    name: String,
    mime: String,
    kind: String,
    path: PathBuf,
    size: u64,
    revision: u64,
}
#[derive(Default)]
pub struct MediaState {
    staged: Mutex<HashMap<String, Staged>>,
    cached: Mutex<HashMap<String, Cached>>,
    download_gate: tokio::sync::Mutex<()>,
    generation: AtomicU64,
    upload_generation: AtomicU64,
    pending: Mutex<Option<PendingDownload>>,
}
struct PendingDownload {
    media_id: String,
    item: Cached,
    generation: u64,
    sender: tokio::sync::oneshot::Sender<Result<Cached, String>>,
    requested: bool,
}
struct PendingCleanup {
    app: tauri::AppHandle,
    media_id: String,
    generation: u64,
    path: PathBuf,
}
impl Drop for PendingCleanup {
    fn drop(&mut self) {
        let state = self.app.state::<MediaState>();
        let mut slot = state.pending.lock().unwrap();
        if slot
            .as_ref()
            .is_some_and(|p| p.media_id == self.media_id && p.generation == self.generation)
        {
            if let Some(pending) = slot.take() {
                let _ = pending.sender.send(Err("Media operation ended".into()));
            }
        }
        drop(slot);
        if !state
            .cached
            .lock()
            .unwrap()
            .values()
            .any(|v| v.path == self.path)
        {
            remove_cached_file(&self.path);
        }
    }
}
#[derive(Clone)]
enum Scope {
    Turn(String),
    Send(String),
    Media(u64),
}

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Not permitted".into())
    }
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = if let Some(p) = crate::test_profile() {
        p.join("qchat-cache")
    } else {
        app.path()
            .app_cache_dir()
            .map_err(|_| "Cache unavailable")?
    };
    let result = base.join("media-session");
    std::fs::create_dir_all(&result).map_err(|_| "Cache unavailable")?;
    Ok(result)
}
fn safe_name(name: &str) -> String {
    let mut result: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(150)
        .collect();
    result = result.trim_matches(|c| c == '.' || c == ' ').to_string();
    let stem = result.split('.').next().unwrap_or("").to_ascii_uppercase();
    if result.is_empty()
        || [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
    {
        result = format!("file_{result}");
    }
    result
}
fn image_name(name: String, mime: &str) -> String {
    if Path::new(&name).extension().is_some() {
        return name;
    }
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        _ => return name,
    };
    format!("{name}.{extension}")
}
fn kind(mime: &str) -> String {
    if matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/bmp"
    ) {
        "image"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime.starts_with("video/") {
        "video"
    } else {
        "file"
    }
    .into()
}
fn mime_for(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}
fn clean_mime(value: &str, name: &str) -> String {
    let candidate = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if candidate != "application/octet-stream"
        && candidate != "binary/octet-stream"
        && candidate.len() <= 100
        && candidate.contains('/')
        && candidate
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/.-+".contains(&b))
    {
        candidate
    } else {
        mime_for(name).into()
    }
}

#[tauri::command]
pub fn attachment_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    mime: String,
    size: u64,
    upload_generation: u64,
) -> Result<Attachment, String> {
    main_only(&window)?;
    if name.contains(['/', '\\']) || name.chars().any(char::is_control) {
        return Err("Attachment names cannot contain a path".into());
    }
    if size > LIMIT {
        return Err(
            "Files must be 512 MiB or smaller. Provider may have lower limits for this format."
                .into(),
        );
    }
    let state = app.state::<MediaState>();
    let mut staged = state.staged.lock().unwrap();
    if upload_generation != state.upload_generation.load(Ordering::SeqCst) {
        return Err("Attachment session ended. Attach the file again.".into());
    }
    reap_staged(&mut staged, Instant::now());
    if staged.len() >= 32 || staged.values().map(|v| v.meta.size).sum::<u64>() + size > LIMIT {
        return Err("Attachment cache is full. Start a new chat to clear it.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = safe_name(&name);
    let mime = clean_mime(&mime, &name);
    let directory = root(&app)?.join("uploads").join(&id);
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare attachment")?;
    let path = directory.join(&name);
    File::create(&path).map_err(|_| "Cannot prepare attachment")?;
    let meta = Attachment {
        id: id.clone(),
        name,
        kind: kind(&mime),
        mime,
        size,
    };
    staged.insert(
        id,
        Staged {
            meta: meta.clone(),
            path,
            written: 0,
            ready: false,
            owner: None,
            retry_until: None,
            dispatched: false,
        },
    );
    Ok(meta)
}
#[tauri::command]
pub fn attachment_chunk(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    offset: u64,
    data: String,
) -> Result<(), String> {
    main_only(&window)?;
    if data.len() > (CHUNK + 2) / 3 * 4 {
        return Err("Attachment chunk is too large".into());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid attachment chunk")?;
    let state = app.state::<MediaState>();
    let mut staged = state.staged.lock().unwrap();
    let item = staged.get_mut(&id).ok_or("Attachment was removed")?;
    if item.ready
        || offset != item.written
        || bytes.len() > CHUNK
        || item.written + bytes.len() as u64 > item.meta.size
    {
        return Err("Attachment chunk is out of sequence".into());
    }
    OpenOptions::new()
        .append(true)
        .open(&item.path)
        .and_then(|mut f| f.write_all(&bytes))
        .map_err(|_| "Could not write attachment")?;
    item.written += bytes.len() as u64;
    Ok(())
}
#[tauri::command]
pub fn attachment_finish(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Attachment, String> {
    main_only(&window)?;
    let state = app.state::<MediaState>();
    let mut staged = state.staged.lock().unwrap();
    let item = staged.get_mut(&id).ok_or("Attachment was removed")?;
    if item.written != item.meta.size
        || std::fs::metadata(&item.path)
            .map_err(|_| "Attachment unavailable")?
            .len()
            != item.meta.size
    {
        return Err("Attachment is incomplete".into());
    }
    item.ready = true;
    Ok(item.meta.clone())
}
#[tauri::command]
pub fn attachment_remove(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    if let Some(item) = app.state::<MediaState>().staged.lock().unwrap().remove(&id) {
        remove_cached_file(&item.path);
    }
    Ok(())
}
pub fn clear_uploads(app: &tauri::AppHandle) {
    for (_, item) in app.state::<MediaState>().staged.lock().unwrap().drain() {
        remove_cached_file(&item.path);
    }
}
pub fn upload_generation(app: &tauri::AppHandle) -> u64 {
    app.state::<MediaState>().upload_generation.load(Ordering::SeqCst)
}
pub fn draft_uploads(app: &tauri::AppHandle) -> Vec<String> {
    app.state::<MediaState>().staged.lock().unwrap().iter()
        .filter(|(_, item)| item.owner.is_none()).map(|(id, _)| id.clone()).collect()
}
pub fn reset_uploads(app: &tauri::AppHandle) {
    let state = app.state::<MediaState>();
    let mut staged = state.staged.lock().unwrap();
    state.upload_generation.fetch_add(1, Ordering::SeqCst);
    for (_, item) in staged.drain() { remove_cached_file(&item.path); }
}
fn reap_staged(staged: &mut HashMap<String, Staged>, now: Instant) {
    staged.retain(|_, item| {
        let expired = item.retry_until.is_some_and(|deadline| now >= deadline);
        if expired { remove_cached_file(&item.path); }
        !expired
    });
}
pub fn expire_uploads(app: &tauri::AppHandle) {
    reap_staged(&mut app.state::<MediaState>().staged.lock().unwrap(), Instant::now());
}
fn remove_cached_file(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
    }
}
fn claim_staged(staged: &mut HashMap<String, Staged>, id: &str, files: &[String]) -> Result<(), String> {
    reap_staged(staged, Instant::now());
    // Validate the whole set before transferring anything. One file has one owner.
    for file in files {
        let item = staged.get(file).ok_or("Attachment is unavailable. Select it again.")?;
        if !item.ready { return Err("Wait for the attachment to finish staging".into()); }
        if item.owner.as_deref().is_some_and(|owner| owner != id) && item.retry_until.is_none() {
            return Err("Attachment is already being sent".into());
        }
    }
    for file in files {
        let item = staged.get_mut(file).unwrap();
        item.owner = Some(id.into());
        item.retry_until = None;
        item.dispatched = false;
    }
    Ok(())
}
pub fn track_turn(app: &tauri::AppHandle, id: &str, files: &[String]) -> Result<(), String> {
    claim_staged(&mut app.state::<MediaState>().staged.lock().unwrap(), id, files)
}
fn retain_staged(staged: &mut HashMap<String, Staged>, id: &str, now: Instant) {
    for item in staged.values_mut().filter(|item| item.owner.as_deref() == Some(id) && item.retry_until.is_none()) {
        item.retry_until = Some(now + RETRY_TTL);
    }
}
pub fn abandon_turn(app: &tauri::AppHandle, id: &str) {
    retain_staged(&mut app.state::<MediaState>().staged.lock().unwrap(), id, Instant::now());
}
pub fn terminal_turn(app: &tauri::AppHandle, id: &str, error: bool, code: Option<&str>) {
    terminal_staged(&mut app.state::<MediaState>().staged.lock().unwrap(), id, error, code);
}
fn terminal_staged(staged: &mut HashMap<String, Staged>, id: &str, error: bool, code: Option<&str>) {
    if error && matches!(code, Some("send_failed" | "stream_failed" | "timeout" | "not_ready" | "temporary_unavailable")) {
        retain_staged(staged, id, Instant::now());
    } else {
        finish_staged(staged, id, false);
    }
}
fn finish_staged(staged: &mut HashMap<String, Staged>, id: &str, include_retained: bool) {
    staged.retain(|_, item| {
        let owned = item.owner.as_deref() == Some(id) && (include_retained || item.retry_until.is_none());
        if owned { remove_cached_file(&item.path); }
        !owned
    });
}
pub fn cancel_turn(app: &tauri::AppHandle, id: &str) -> Vec<String> {
    let state = app.state::<MediaState>();
    let mut staged = state.staged.lock().unwrap();
    let mut drafts = Vec::new();
    staged.retain(|file, item| {
        if item.owner.as_deref() != Some(id) { return true; }
        if item.dispatched { remove_cached_file(&item.path); return false; }
        item.owner = None;
        item.retry_until = None;
        drafts.push(file.clone());
        true
    });
    drafts
}
pub fn clear_all(app: &tauri::AppHandle) {
    clear_reply_media(app);
    clear_uploads(app);
}
pub fn clear_reply_media(app: &tauri::AppHandle) {
    let state = app.state::<MediaState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(pending) = state.pending.lock().unwrap().take() {
        remove_cached_file(&pending.item.path);
        let _ = pending
            .sender
            .send(Err("Media request was cancelled".into()));
    }
    for (_, item) in state.cached.lock().unwrap().drain() {
        remove_cached_file(&item.path);
    }
}

pub async fn cdp(app: &tauri::AppHandle, method: &str, params: Value) -> Result<Value, String> {
    cdp_scoped(app, method, params, None).await
}
async fn cdp_scoped(
    app: &tauri::AppHandle,
    method: &str,
    params: Value,
    scope: Option<Scope>,
) -> Result<Value, String> {
    cdp_provider(app, method, params, scope, crate::active_provider(app)).await
}
async fn cdp_provider(
    app: &tauri::AppHandle,
    method: &str,
    params: Value,
    scope: Option<Scope>,
    provider: String,
) -> Result<Value, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let method = HSTRING::from(method);
    let params = HSTRING::from(params.to_string());
    let error_sender = sender.clone();
    let scope_app = app.clone();
    app.get_webview_window(&provider)
        .ok_or("Provider window unavailable")?
        .with_webview(move |w| unsafe {
            let allowed = match &scope {
                Some(Scope::Turn(id) | Scope::Send(id)) => {
                    scope_app
                        .state::<crate::Host>()
                        .0
                        .lock()
                        .unwrap()
                        .flight_id
                        .as_deref()
                        == Some(id)
                }
                Some(Scope::Media(generation)) => {
                    scope_app
                        .state::<MediaState>()
                        .generation
                        .load(Ordering::SeqCst)
                        == *generation
                }
                None => true,
            };
            if !allowed {
                if let Some(tx) = error_sender.lock().unwrap().take() {
                    let _ = tx.send(Err("Operation was cancelled".into()));
                }
                return;
            }
            if let Some(Scope::Send(id)) = &scope {
                for item in scope_app.state::<MediaState>().staged.lock().unwrap().values_mut().filter(|item| item.owner.as_deref() == Some(id)) {
                    item.dispatched = true;
                }
            }
            let callback_sender = sender.clone();
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    let value = result
                        .map_err(|_| "Provider operation failed".to_string())
                        .and_then(|_| {
                            serde_json::from_str(&json)
                                .map_err(|_| "Invalid Provider reply".to_string())
                        });
                    if let Some(tx) = callback_sender.lock().unwrap().take() {
                        let _ = tx.send(value);
                    }
                    Ok(())
                },
            ));
            let result = w
                .controller()
                .CoreWebView2()
                .and_then(|core| core.CallDevToolsProtocolMethod(&method, &params, &callback));
            if result.is_err() {
                if let Some(tx) = error_sender.lock().unwrap().take() {
                    let _ = tx.send(Err("Provider operation unavailable".into()));
                }
            }
        })
        .map_err(|_| "Provider operation unavailable")?;
    tokio::time::timeout(Duration::from_secs(90), rx)
        .await
        .map_err(|_| "Provider operation timed out")?
        .map_err(|_| "Provider operation ended")?
}
pub async fn evaluate(app: &tauri::AppHandle, expression: String) -> Result<Value, String> {
    let value = cdp(
        app,
        "Runtime.evaluate",
        json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),
    )
    .await?;
    if value.get("exceptionDetails").is_some() {
        if value["exceptionDetails"]["exception"]["description"].as_str().is_some_and(|message| message.contains("attachment_pending:")) {
            return Err("attachment_pending: Clear pending attachments in the provider or start a new chat.".into());
        }
        return Err(
            "Provider could not complete this media operation. Use View in provider for details."
                .into(),
        );
    }
    Ok(value["result"]["value"].clone())
}
pub async fn dispatch_turn(app: &tauri::AppHandle, id: &str, expression: String) -> Result<(), String> {
    let value = cdp_scoped(app, "Runtime.evaluate", json!({"expression":expression,"returnByValue":true}), Some(Scope::Send(id.into()))).await?;
    if value.get("exceptionDetails").is_some() {
        return Err("Provider could not send this message".into());
    }
    Ok(())
}
pub async fn attach_temporary(app: &tauri::AppHandle, ids: &[String], turn_id: &str) -> Result<(), String> {
    if ids.is_empty() { return Ok(()); }
    if ids.len() > 10 { return Err("Attach up to 10 files at once".into()); }
    let paths: Vec<String> = {
        let state = app.state::<MediaState>();
        let staged = state.staged.lock().unwrap();
        ids.iter().map(|id| {
            let item = staged.get(id).ok_or("Attachment is unavailable. Select it again.")?;
            if !item.ready { return Err("Wait for the attachment to finish staging"); }
            Ok(item.path.to_string_lossy().into_owned())
        }).collect::<Result<_, &str>>().map_err(str::to_string)?
    };
    let provider = crate::active_provider(app);
    let id = serde_json::to_string(turn_id).map_err(|e| e.to_string())?;
    let result: Result<(), String> = async {
        let stage = cdp_provider(app, "Runtime.evaluate", json!({"expression":format!("window.__qchat.stageTemporaryFiles({id})"),"awaitPromise":true,"returnByValue":false}), Some(Scope::Turn(turn_id.into())), provider.clone()).await?;
        if stage.get("exceptionDetails").is_some() {
            if let Some(object) = stage["result"]["objectId"].as_str() {
                let _ = cdp_provider(app, "Runtime.releaseObject", json!({"objectId":object}), None, provider.clone()).await;
            }
            if stage["exceptionDetails"]["exception"]["description"].as_str().is_some_and(|message| message.contains("attachment_pending:")) {
                return Err("attachment_pending: Clear pending attachments in the provider or start a new chat.".into());
            }
            return Err("temporary_unavailable: Temporary attachment preparation failed".into());
        }
        let object = stage["result"]["objectId"].as_str().ok_or("temporary_unavailable: Temporary attachment preparation failed")?.to_owned();
        let handoff: Result<(), String> = async {
            cdp_provider(app, "DOM.setFileInputFiles", json!({"objectId":object,"files":paths}), Some(Scope::Turn(turn_id.into())), provider.clone()).await?;
            let commit = cdp_provider(app, "Runtime.evaluate", json!({"expression":format!("window.__qchat.commitTemporaryFiles({id})"),"returnByValue":true}), Some(Scope::Turn(turn_id.into())), provider.clone()).await?;
            if commit["result"]["value"] != true { return Err("temporary_unavailable: Temporary chat could not be confirmed".into()); }
            Ok(())
        }.await;
        let _ = cdp_provider(app, "Runtime.releaseObject", json!({"objectId":object}), None, provider.clone()).await;
        handoff
    }.await;
    let _ = cdp_provider(app, "Runtime.evaluate", json!({"expression":format!("window.__qchat && window.__qchat.clearTemporaryStage({id})"),"returnByValue":true}), None, provider.clone()).await;
    result
}
pub async fn attach(app: &tauri::AppHandle, ids: &[String], turn_id: &str) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    if ids.len() > 10 {
        return Err("Attach up to 10 files at once".into());
    }
    let paths: Vec<String> = {
        let state = app.state::<MediaState>();
        let staged = state.staged.lock().unwrap();
        ids.iter()
            .map(|id| {
                let item = staged
                    .get(id)
                    .ok_or("Attachment is unavailable. Select it again.")?;
                if !item.ready {
                    return Err("Wait for the attachment to finish staging".into());
                }
                Ok(item.path.to_string_lossy().into_owned())
            })
            .collect::<Result<_, String>>()?
    };
    let selector = evaluate(app, "window.__qchat.attachmentInput()".into())
        .await?
        .as_str()
        .ok_or("Provider attachment input unavailable")?
        .to_owned();
    let document = cdp(app, "DOM.getDocument", json!({})).await?;
    let node = cdp(
        app,
        "DOM.querySelector",
        json!({"nodeId":document["root"]["nodeId"],"selector":selector}),
    )
    .await?;
    if node["nodeId"].as_u64().unwrap_or(0) == 0 {
        return Err("Provider attachment input unavailable".into());
    }
    cdp_scoped(
        app,
        "DOM.setFileInputFiles",
        json!({"nodeId":node["nodeId"],"files":paths}),
        Some(Scope::Turn(turn_id.into())),
    )
    .await?;
    Ok(())
}
fn allowed_media_url(raw: &str) -> bool {
    if raw.starts_with("blob:https://chatgpt.com/") || raw.starts_with("blob:https://gemini.google.com/") {
        return true;
    }
    if raw.starts_with("data:image/") {
        return ["png", "jpeg", "gif", "webp", "avif", "bmp"]
            .iter()
            .any(|m| raw.starts_with(&format!("data:image/{m};base64,")))
            && raw.len() < 48 * 1024 * 1024;
    }
    let Ok(url) = tauri::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && [
            "chatgpt.com",
            "oaiusercontent.com",
            "oaistatic.com",
            "cdn.openai.com",
            "images.openai.com",
        ]
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
        || (url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && (host.ends_with(".blob.core.windows.net") || host=="gemini.google.com" || host.ends_with(".googleusercontent.com") || host.strip_prefix("encrypted-tbn").and_then(|h| h.strip_suffix(".gstatic.com")).is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))))
}
async fn load(app: &tauri::AppHandle, media_id: &str, revision: u64) -> Result<Cached, String> {
    let state = app.state::<MediaState>();
    let generation = state.generation.load(Ordering::SeqCst);
    let _guard = state.download_gate.lock().await;
    if state.generation.load(Ordering::SeqCst) != generation {
        return Err("Media request was cancelled".into());
    }
    if let Some(item) = state
        .cached
        .lock()
        .unwrap()
        .get(media_id)
        .filter(|item| item.revision >= revision)
        .cloned()
    {
        return Ok(item);
    }
    let args = serde_json::to_string(media_id).map_err(|_| "Invalid media")?;
    let source = match evaluate(app, format!("window.__qchat.resolveMedia({args})")).await {
        Ok(value) => value,
        Err(_) => return site_download(app, media_id, generation, revision).await,
    };
    let url = source["url"]
        .as_str()
        .ok_or("This item must be opened in Provider")?;
    if !allowed_media_url(url) {
        return Err("This media source must be opened in Provider".into());
    }
    let name = safe_name(source["name"].as_str().unwrap_or("download"));
    let mut mime = clean_mime(source["mime"].as_str().unwrap_or(""), &name);
    let id = uuid::Uuid::new_v4().to_string();
    let directory = root(app)?.join("replies").join(&id);
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare media cache")?;
    let path = directory.join(&name);
    let mut file = File::create(&path).map_err(|_| "Cannot prepare media cache")?;
    let result: Result<u64,String>=async {
        if url.starts_with("data:") {
            mime=clean_mime(url.strip_prefix("data:").unwrap_or("").split(';').next().unwrap_or(""),&name);
            let bytes=STANDARD.decode(url.split_once(',').ok_or("Invalid image")?.1).map_err(|_|"Invalid image")?;
            file.write_all(&bytes).map_err(|_|"Cannot cache image")?; return Ok(bytes.len() as u64);
        }
        let (handle,object_id)=if url.starts_with("blob:") {
            let encoded=serde_json::to_string(url).map_err(|_|"Invalid media URL")?;
            let object=cdp(app,"Runtime.evaluate",json!({"expression":format!("fetch({encoded}).then(r=>r.blob())"),"awaitPromise":true,"returnByValue":false})).await?;
            let object_id=object["result"]["objectId"].as_str().ok_or("This media blob is unavailable")?.to_owned();
            let blob_result:Result<String,String>=async {
                let blob_type=cdp(app,"Runtime.callFunctionOn",json!({"objectId":object_id,"functionDeclaration":"function(){return this.type}","returnByValue":true})).await?;
                if let Some(actual)=blob_type["result"]["value"].as_str(){mime=clean_mime(actual,&name);}
                let resolved=cdp(app,"IO.resolveBlob",json!({"objectId":object_id})).await?;
                let uuid=resolved["uuid"].as_str().ok_or("This media blob is unavailable")?;
                Ok(format!("blob:{uuid}"))
            }.await;
            if blob_result.is_err(){let _=cdp(app,"Runtime.releaseObject",json!({"objectId":object_id})).await;}
            (blob_result?,Some(object_id))
        } else {
            let frame=cdp(app,"Page.getFrameTree",json!({})).await?;
            let resource=cdp(app,"Network.loadNetworkResource",json!({"frameId":frame["frameTree"]["frame"]["id"],"url":url,"options":{"disableCache":true,"includeCredentials":true}})).await?;
            let resource=&resource["resource"];
            if resource["success"]!=true || resource["httpStatusCode"].as_u64().is_some_and(|status|!(200..300).contains(&status)) {
                if let Some(handle)=resource["stream"].as_str(){let _=cdp(app,"IO.close",json!({"handle":handle})).await;}
                return Err("Could not load this media. Use View in provider.".into());
            }
            if let Some(headers)=resource["headers"].as_object() { if let Some(actual)=headers.iter().find(|(key,_)|key.eq_ignore_ascii_case("content-type")).and_then(|(_,value)|value.as_str()) {mime=clean_mime(actual,&name);} }
            (resource["stream"].as_str().ok_or("This media has no downloadable content")?.to_owned(),None)
        };
        let read_result: Result<u64,String>=async {
            let mut size=0u64;
            loop {
                let packet=cdp(app,"IO.read",json!({"handle":handle,"size":CHUNK})).await?;
                if state.generation.load(Ordering::SeqCst)!=generation {return Err("Media request was cancelled".into());}
                let data=packet["data"].as_str().ok_or("Invalid media data")?;
                let bytes=if packet["base64Encoded"]==true { STANDARD.decode(data).map_err(|_|"Invalid media data")? } else { data.as_bytes().to_vec() };
                size+=bytes.len() as u64; if size>LIMIT { return Err("This media is too large to preview in QChat".into()); }
                file.write_all(&bytes).map_err(|_|"Cannot cache media")?;
                if packet["eof"]==true { break; }
            }
            Ok(size)
        }.await;
        let _=cdp(app,"IO.close",json!({"handle":handle})).await;
        if let Some(object_id)=object_id {let _=cdp(app,"Runtime.releaseObject",json!({"objectId":object_id})).await;}
        read_result
    }.await;
    drop(file);
    let size = match result {
        Ok(n) => n,
        Err(e) => {
            remove_cached_file(&path);
            if source["kind"] == "file" && state.generation.load(Ordering::SeqCst) == generation {
                return site_download(app, media_id, generation, revision).await;
            }
            return Err(e);
        }
    };
    let mut cached = state.cached.lock().unwrap();
    if state.generation.load(Ordering::SeqCst) != generation {
        remove_cached_file(&path);
        return Err("Media request was cancelled".into());
    }
    if cached
        .iter()
        .filter(|(key, _)| key.as_str() != media_id)
        .map(|(_, v)| v.size)
        .sum::<u64>()
        + size
        > LIMIT
    {
        remove_cached_file(&path);
        return Err("Media cache is full. Start a new chat to clear it.".into());
    }
    let item = Cached {
        id,
        name: image_name(name, &mime),
        mime: mime.clone(),
        kind: kind(&mime),
        path,
        size,
        revision,
    };
    if let Some(previous) = cached.insert(media_id.into(), item.clone()) {
        remove_cached_file(&previous.path);
    }
    Ok(item)
}
#[tauri::command]
pub async fn media_load(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    media_id: String,
    revision: Option<u64>,
) -> Result<Value, String> {
    main_only(&window)?;
    crate::resume(&app);
    let item = load(&app, &media_id, revision.unwrap_or(0)).await?;
    Ok(
        json!({"id":media_id,"name":item.name,"kind":item.kind,"mime":item.mime,"src":format!("http://qchat-media.localhost/{}",item.id)}),
    )
}
#[tauri::command]
pub async fn media_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    media_id: String,
    revision: Option<u64>,
) -> Result<String, String> {
    main_only(&window)?;
    crate::resume(&app);
    let item = load(&app, &media_id, revision.unwrap_or(0)).await?;
    let destination = if let Some(p) = crate::test_profile() {
        p.join("Downloads")
    } else {
        app.path()
            .download_dir()
            .map_err(|_| "Downloads folder unavailable")?
    };
    std::fs::create_dir_all(&destination).map_err(|_| "Downloads folder unavailable")?;
    for suffix in 0..10000 {
        let name = if suffix == 0 {
            item.name.clone()
        } else {
            let p = Path::new(&item.name);
            format!(
                "{} ({suffix}){}",
                p.file_stem().and_then(|v| v.to_str()).unwrap_or("download"),
                p.extension()
                    .and_then(|v| v.to_str())
                    .map(|e| format!(".{e}"))
                    .unwrap_or_default()
            )
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination.join(&name))
        {
            Ok(mut out) => {
                std::io::copy(
                    &mut File::open(&item.path).map_err(|_| "Cached file unavailable")?,
                    &mut out,
                )
                .map_err(|_| "Could not save file")?;
                return Ok(name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Could not save to Downloads".into()),
        }
    }
    Err("Choose a different download filename".into())
}
async fn site_download(
    app: &tauri::AppHandle,
    media_id: &str,
    generation: u64,
    revision: u64,
) -> Result<Cached, String> {
    let encoded = serde_json::to_string(media_id).map_err(|_| "Invalid media")?;
    let info = evaluate(app, format!("window.__qchat.mediaInfo({encoded})")).await?;
    let name = safe_name(info["name"].as_str().unwrap_or("download"));
    let mime = clean_mime(info["mime"].as_str().unwrap_or(""), &name);
    let id = uuid::Uuid::new_v4().to_string();
    let folder = root(app)?.join("replies").join(&id);
    std::fs::create_dir_all(&folder).map_err(|_| "Cannot prepare download")?;
    let item = Cached {
        id,
        name: name.clone(),
        mime: mime.clone(),
        kind: kind(&mime),
        path: folder.join(name),
        size: 0,
        revision,
    };
    let _cleanup = PendingCleanup {
        app: app.clone(),
        media_id: media_id.into(),
        generation,
        path: item.path.clone(),
    };
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    let state = app.state::<MediaState>();
    if state.generation.load(Ordering::SeqCst) != generation {
        return Err("Media request was cancelled".into());
    }
    *state.pending.lock().unwrap() = Some(PendingDownload {
        media_id: media_id.into(),
        item,
        generation,
        sender,
        requested: false,
    });
    let started=cdp(app,"Runtime.evaluate",json!({"expression":format!("window.__qchat.activateMedia({encoded},{{coordinates:true}})"),"awaitPromise":true,"returnByValue":true,"userGesture":true})).await;
    if started.as_ref().is_err()
        || started.as_ref().is_ok_and(|v| {
            v.get("exceptionDetails").is_some()
                || (v["result"]["value"] != true && !v["result"]["value"].is_object())
        })
    {
        state.pending.lock().unwrap().take();
        return Err("Provider could not start this download. Use View in provider.".into());
    }
    if let Ok(value) = &started {
        click_point(app, &value["result"]["value"], generation).await?;
    }
    for _ in 0..12 {
        match receiver.try_recv() {
            Ok(result) => return result,
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                return Err("Provider download ended".into())
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
        }
        if state
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.requested)
        {
            break;
        }
        let action=cdp(app,"Runtime.evaluate",json!({"expression":format!("window.__qchat.mediaDownloadAction?.({encoded}) || null"),"awaitPromise":true,"returnByValue":true})).await?;
        if !action["result"]["value"].is_null() && action.get("exceptionDetails").is_none() {
            click_point(app, &action["result"]["value"], generation).await?;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    match tokio::time::timeout(Duration::from_secs(90), receiver).await {
        Ok(Ok(result)) => result,
        _ => {
            state.pending.lock().unwrap().take();
            Err("Provider download timed out. Use View in provider.".into())
        }
    }
}
async fn click_point(app: &tauri::AppHandle, value: &Value, generation: u64) -> Result<(), String> {
    let Some(point) = value.get("point") else {
        return Ok(());
    };
    let x = point["x"].as_f64().ok_or("Invalid media control")?;
    let y = point["y"].as_f64().ok_or("Invalid media control")?;
    if !x.is_finite() || !y.is_finite() || x < 0. || y < 0. || x > 10000. || y > 10000. {
        return Err("Provider download control is unavailable".into());
    }
    cdp_scoped(
        app,
        "Input.dispatchMouseEvent",
        json!({"type":"mouseMoved","x":x,"y":y}),
        Some(Scope::Media(generation)),
    )
    .await?;
    let pressed = cdp_scoped(
        app,
        "Input.dispatchMouseEvent",
        json!({"type":"mousePressed","x":x,"y":y,"button":"left","buttons":1,"clickCount":1}),
        Some(Scope::Media(generation)),
    )
    .await;
    let released = cdp(
        app,
        "Input.dispatchMouseEvent",
        json!({"type":"mouseReleased","x":x,"y":y,"button":"left","buttons":0,"clickCount":1}),
    )
    .await;
    if released.is_err() {
        let _ = cdp(
            app,
            "Input.dispatchMouseEvent",
            json!({"type":"mouseReleased","x":x,"y":y,"button":"left","buttons":0,"clickCount":1}),
        )
        .await;
    }
    pressed?;
    released?;
    Ok(())
}
pub fn on_download(app: &tauri::AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    let state = app.state::<MediaState>();
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let mut pending = state.pending.lock().unwrap();
            if let Some(current) = pending.as_mut() {
                if allowed_media_url(url.as_str())
                    && current.generation == state.generation.load(Ordering::SeqCst)
                {
                    *destination = current.item.path.clone();
                    current.requested = true;
                    true
                } else {
                    if let Some(item) = pending.take() {
                        remove_cached_file(&item.item.path);
                        let _ = item
                            .sender
                            .send(Err("This download must be opened in Provider".into()));
                    }
                    false
                }
            } else {
                !app.state::<crate::Host>().0.lock().unwrap().background
            }
        }
        tauri::webview::DownloadEvent::Finished { path, success, .. } => {
            let matching = state.pending.lock().unwrap().as_ref().is_some_and(|p| {
                path.as_ref().is_some_and(|v| v == &p.item.path) || (path.is_none() && !success)
            });
            if matching {
                if let Some(mut pending) = state.pending.lock().unwrap().take() {
                    let result = (|| -> Result<Cached, String> {
                        if !success || pending.generation != state.generation.load(Ordering::SeqCst)
                        {
                            return Err("Provider download did not complete".into());
                        }
                        pending.item.size = std::fs::metadata(&pending.item.path)
                            .map_err(|_| "Downloaded file is unavailable")?
                            .len();
                        let mut cached = state.cached.lock().unwrap();
                        if pending.item.size > LIMIT
                            || cached
                                .iter()
                                .filter(|(id, _)| id.as_str() != pending.media_id)
                                .map(|(_, v)| v.size)
                                .sum::<u64>()
                                + pending.item.size
                                > LIMIT
                        {
                            return Err("Media cache is full. Start a new chat to clear it.".into());
                        }
                        if pending.generation != state.generation.load(Ordering::SeqCst) {
                            return Err("Media request was cancelled".into());
                        }
                        if let Some(previous) =
                            cached.insert(pending.media_id.clone(), pending.item.clone())
                        {
                            remove_cached_file(&previous.path);
                        }
                        Ok(pending.item.clone())
                    })();
                    if result.is_err() {
                        remove_cached_file(&pending.item.path);
                    }
                    let _ = pending.sender.send(result);
                }
            } else if let Some(path) = path {
                let managed = root(app).ok().is_some_and(|root| {
                    path.parent().and_then(|p| p.parent()) == Some(root.join("replies").as_path())
                        && path
                            .parent()
                            .and_then(|p| p.file_name())
                            .and_then(|n| n.to_str())
                            .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
                });
                if managed
                    && !state
                        .cached
                        .lock()
                        .unwrap()
                        .values()
                        .any(|v| v.path == path)
                {
                    remove_cached_file(&path);
                }
            }
            true
        }
        _ => false,
    }
}
pub fn protocol(
    app: &tauri::AppHandle,
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let response = || {
        tauri::http::Response::builder()
            .header("Access-Control-Allow-Origin", "http://tauri.localhost")
            .header(
                "Access-Control-Expose-Headers",
                "Content-Range, Accept-Ranges, Content-Length",
            )
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
    };
    let denied = || response().status(404).body(Vec::new()).unwrap();
    if label != "main" || !matches!(request.method().as_str(), "GET" | "HEAD") {
        return denied();
    }
    let token = request.uri().path().trim_start_matches('/');
    let entry = app
        .state::<MediaState>()
        .cached
        .lock()
        .unwrap()
        .values()
        .find(|c| c.id == token)
        .cloned();
    let Some(entry) = entry else { return denied() };
    let range = request.headers().get("range").and_then(|v| v.to_str().ok());
    let (start, end) = match byte_range(range, entry.size) {
        Some(v) => v,
        None => {
            return response()
                .status(416)
                .header("Content-Range", format!("bytes */{}", entry.size))
                .body(Vec::new())
                .unwrap()
        }
    };
    let len = if entry.size == 0 { 0 } else { end - start + 1 };
    if len > 64 * 1024 * 1024 && request.method() != tauri::http::Method::HEAD {
        return response().status(413).body(Vec::new()).unwrap();
    }
    let mut body = vec![
        0u8;
        if request.method() == tauri::http::Method::HEAD {
            0
        } else {
            len as usize
        }
    ];
    if !body.is_empty()
        && File::open(&entry.path)
            .and_then(|mut f| {
                f.seek(SeekFrom::Start(start))?;
                f.read_exact(&mut body)
            })
            .is_err()
    {
        return denied();
    }
    let mut response = response()
        .status(if range.is_some() { 206 } else { 200 })
        .header(
            "Content-Type",
            if matches!(entry.kind.as_str(), "image" | "audio" | "video") {
                entry.mime.as_str()
            } else {
                "application/octet-stream"
            },
        )
        .header("Content-Length", len.to_string())
        .header("Accept-Ranges", "bytes");
    if range.is_some() {
        response = response.header(
            "Content-Range",
            format!("bytes {start}-{end}/{}", entry.size),
        )
    }
    response.body(body).unwrap()
}
fn byte_range(range: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return if range.is_none() { Some((0, 0)) } else { None };
    }
    let Some(range) = range else {
        return Some((0, size - 1));
    };
    let (a, b) = range.strip_prefix("bytes=")?.split_once('-')?;
    if a.is_empty() {
        let suffix = b.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = size.saturating_sub(suffix);
        return Some((start, (start + 8 * 1024 * 1024 - 1).min(size - 1)));
    }
    let start = a.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }
    let end = if b.is_empty() {
        (start + 8 * 1024 * 1024 - 1).min(size - 1)
    } else {
        b.parse::<u64>()
            .ok()?
            .min(size - 1)
            .min(start + 8 * 1024 * 1024 - 1)
    };
    if end < start {
        None
    } else {
        Some((start, end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn staged_fixture() -> (HashMap<String, Staged>, PathBuf) {
        let directory = std::env::temp_dir().join(format!("qchat-upload-unit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.txt");
        std::fs::write(&path, b"fixture").unwrap();
        let item = Staged { meta: Attachment { id:"file".into(),name:"fixture.txt".into(),mime:"text/plain".into(),size:7,kind:"file".into() },path:path.clone(),written:7,ready:true,owner:None,retry_until:None,dispatched:false };
        ([("file".into(), item)].into(), path)
    }
    #[test]
    fn retry_claims_are_atomic_and_exclusive() {
        let (mut files, path) = staged_fixture();
        assert!(claim_staged(&mut files, "old", &["file".into(),"missing".into()]).is_err());
        assert!(files["file"].owner.is_none());
        claim_staged(&mut files, "old", &["file".into()]).unwrap();
        assert!(claim_staged(&mut files, "other", &["file".into()]).is_err());
        assert_eq!(files["file"].owner.as_deref(), Some("old"));
        finish_staged(&mut files, "old", true);
        assert!(files.is_empty() && !path.exists());
    }
    #[test]
    fn temporary_mode_loss_retains_staged_file_for_retry() {
        let (mut files, path) = staged_fixture();
        std::fs::write(&path, [0, 128, 255, 17]).unwrap();
        claim_staged(&mut files, "first", &["file".into()]).unwrap();
        terminal_staged(&mut files, "first", true, Some("temporary_unavailable"));
        assert_eq!(std::fs::read(&path).unwrap(), [0, 128, 255, 17]);
        claim_staged(&mut files, "retry", &["file".into()]).unwrap();
        terminal_staged(&mut files, "retry", false, None);
        assert!(!path.exists());
    }
    #[test]
    fn stale_terminals_cannot_delete_retried_files_or_extend_retention() {
        let (mut files, path) = staged_fixture();
        claim_staged(&mut files, "old", &["file".into()]).unwrap();
        let now=Instant::now();
        retain_staged(&mut files, "old", now);
        retain_staged(&mut files, "old", now+Duration::from_secs(30));
        assert_eq!(files["file"].retry_until, Some(now+RETRY_TTL));
        finish_staged(&mut files, "old", false);
        assert!(path.exists());
        claim_staged(&mut files, "retry", &["file".into()]).unwrap();
        finish_staged(&mut files, "old", true);
        retain_staged(&mut files, "old", now);
        assert!(path.exists() && files["file"].retry_until.is_none());
        assert_eq!(files["file"].owner.as_deref(), Some("retry"));
        finish_staged(&mut files, "retry", false);
        assert!(files.is_empty() && !path.exists());
    }
    #[test]
    fn expiry_deletes_retained_bytes_but_keeps_drafts_and_active_sends() {
        let (mut files, path) = staged_fixture();
        let now=Instant::now();
        reap_staged(&mut files, now+RETRY_TTL+Duration::from_secs(1));
        assert!(path.exists());
        claim_staged(&mut files, "turn", &["file".into()]).unwrap();
        reap_staged(&mut files, now+RETRY_TTL+Duration::from_secs(1));
        assert!(path.exists());
        retain_staged(&mut files, "turn", now);
        reap_staged(&mut files, now+RETRY_TTL-Duration::from_millis(1));
        assert!(path.exists());
        reap_staged(&mut files, now+RETRY_TTL);
        assert!(files.is_empty() && !path.exists());
        assert!(claim_staged(&mut files, "retry", &["file".into()]).is_err());
    }
    #[test]
    fn names_stay_inside_the_cache_and_keep_unicode() {
        assert_eq!(safe_name("../hello 🥰.png"), "_hello 🥰.png");
        assert_eq!(safe_name("CON.txt"), "file_CON.txt");
        assert_eq!(safe_name("x.exe"), "x.exe");
        assert!(!safe_name("a\\b/c").contains(['\\', '/']));
        assert_eq!(
            image_name("Generated image 1".into(), "image/png"),
            "Generated image 1.png"
        );
        assert_eq!(image_name("photo.jpg".into(), "image/jpeg"), "photo.jpg");
    }
    #[test]
    fn media_sources_exclude_local_and_active_content() {
        for u in [
            "file:///C:/x",
            "https://localhost/x",
            "https://chatgpt.com.evil.test/x",
            "https://gemini.google.com.evil.test/x",
            "https://user:pass@gemini.google.com/x",
            "javascript:alert(1)",
            "data:image/svg+xml;base64,xxx",
            "https://user:pass@chatgpt.com/x",
        ] {
            assert!(!allowed_media_url(u), "{u}")
        }
        for u in [
            "https://chatgpt.com/backend-api/files/x",
            "https://files.oaiusercontent.com/x",
            "blob:https://chatgpt.com/synthetic",
            "data:image/png;base64,eA==",
        ] {
            assert!(allowed_media_url(u), "{u}")
        }
    }
    #[test]
    fn media_range_requests_support_seeking_and_reject_bad_ranges() {
        assert_eq!(byte_range(None, 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=100-"), 100), None);
        assert_eq!(byte_range(Some("bytes=2-1"), 100), None);
        assert_eq!(byte_range(Some("bytes=0-1,4-5"), 100), None);
        assert_eq!(
            byte_range(Some("bytes=0-"), LIMIT),
            Some((0, 8 * 1024 * 1024 - 1))
        );
        assert_eq!(
            byte_range(Some("bytes=0-99999999"), LIMIT),
            Some((0, 8 * 1024 * 1024 - 1))
        );
    }
}
