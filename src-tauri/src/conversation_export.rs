use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};
use tauri::Manager;

const LIMIT: usize = 4 * 1024 * 1024;
const ERROR: &str = "Could not save conversation";

fn title_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c, '\u{ad}' | '\u{61c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
                && !"<>:\"/\\|?*".contains(*c)
        })
        .take(80)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(|c| c == '.' || c == ' ');
    if cleaned.is_empty() {
        "Conversation".into()
    } else {
        cleaned.into()
    }
}

fn save(dir: &Path, title: &str, markdown: &str) -> Result<String, String> {
    if markdown.trim().is_empty() || markdown.len() > LIMIT {
        return Err(ERROR.into());
    }
    fs::create_dir_all(dir).map_err(|_| ERROR)?;
    let title = title_name(title);
    for suffix in 0..10000 {
        let name = if suffix == 0 {
            format!("QChat - {title}.md")
        } else {
            format!("QChat - {title} ({suffix}).md")
        };
        let path = dir.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if file
                    .write_all(markdown.as_bytes())
                    .and_then(|_| file.sync_all())
                    .is_err()
                {
                    drop(file);
                    let _ = fs::remove_file(path);
                    return Err(ERROR.into());
                }
                return Ok(name);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(ERROR.into()),
        }
    }
    Err(ERROR.into())
}

#[tauri::command]
pub async fn conversation_export(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: String,
    markdown: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err(ERROR.into());
    }
    if markdown.trim().is_empty() || markdown.len() > LIMIT {
        return Err(ERROR.into());
    }
    let dir = if let Some(p) = crate::test_profile() {
        p.join("Downloads")
    } else {
        app.path().download_dir().map_err(|_| ERROR)?
    };
    tauri::async_runtime::spawn_blocking(move || save(&dir, &title, &markdown))
        .await
        .map_err(|_| ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    fn dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "qchat-export-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn conversation_export_filenames() {
        assert_eq!(title_name("  <>CON:/\\|?*... "), "CON");
        assert_eq!(title_name(" . . "), "Conversation");
        assert_eq!(title_name(&"猫".repeat(81)).chars().count(), 80);
        assert_eq!(title_name("a\nb.md"), "ab.md");
        assert_eq!(title_name("Safe\u{85}\u{200b}\u{200c}\u{200d}\u{200e}\u{200f}\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}\u{2066}\u{2067}\u{2068}\u{2069}\u{feff}name"), "Safename");
        assert_eq!(
            title_name("Safe\u{ad}\u{61c}\u{2060}\u{2061}\u{2062}\u{2063}\u{2064}name"),
            "Safename"
        );
    }
    #[test]
    fn conversation_export_bytes_bounds_and_collisions() {
        let d = dir();
        assert!(save(&d, "x", "  \n").is_err());
        assert!(save(&d, "x", &"é".repeat(LIMIT / 2 + 1)).is_err());
        assert!(!d.exists());
        let name = save(&d, "x", "héllo\n").unwrap();
        assert_eq!(fs::read(d.join(&name)).unwrap(), "héllo\n".as_bytes());
        let mut threads = vec![];
        for _ in 0..8 {
            let d = d.clone();
            threads.push(std::thread::spawn(move || save(&d, "x", "other").unwrap()));
        }
        let mut names: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 8);
        assert_eq!(fs::read(d.join(name)).unwrap(), "héllo\n".as_bytes());
        assert!(save(&d, "limit", &"x".repeat(LIMIT)).is_ok());
        fs::remove_dir_all(d).unwrap();
    }
}
