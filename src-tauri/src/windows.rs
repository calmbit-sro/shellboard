// Scratch windows: extra, project-less windows (Cmd/Ctrl+Shift+N). Each one is a
// separate webview window labelled `scratch-<id>` whose session/buffers live in
// their own store files (`scratch-<id>.session.json` / `.buffers.json`), so a
// scratch window survives restarts and can be discarded independently of the
// main window's state.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const LABEL_PREFIX: &str = "scratch-";
const SESSION_SUFFIX: &str = ".session.json";
const BUFFERS_SUFFIX: &str = ".buffers.json";
const MAX_ID_LEN: usize = 64;
// Label of the window that had focus when the app quit, so the next launch can
// hand focus back to it. Plain text next to the store files.
const LAST_FOCUSED_FILE: &str = "last-focused-window";

// Ids end up in file names and window labels, so restrict them to a safe
// charset (uuid-shaped: ASCII alphanumerics and '-') — no path separators or dots.
pub fn is_valid_scratch_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn scratch_session_file(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}{SESSION_SUFFIX}")
}

pub fn scratch_buffers_file(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}{BUFFERS_SUFFIX}")
}

// `scratch-<id>.session.json` → `Some(id)` when the id is valid.
pub fn parse_scratch_session_file(name: &str) -> Option<&str> {
    let id = name
        .strip_prefix(LABEL_PREFIX)?
        .strip_suffix(SESSION_SUFFIX)?;
    is_valid_scratch_id(id).then_some(id)
}

fn scratch_label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

// Create (or focus, if it already exists) the scratch window for `id`. The
// frontend learns what it is via `window.__SHELLBOARD_WINDOW__`, injected before
// any page script runs.
fn build_scratch_window<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    cwd: Option<&str>,
    restored: bool,
) -> Result<(), String> {
    if !is_valid_scratch_id(id) {
        return Err(format!("invalid scratch window id: {id}"));
    }
    let label = scratch_label(id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        return existing.set_focus().map_err(|e| e.to_string());
    }

    let payload = serde_json::json!({
        "kind": "scratch",
        "id": id,
        "cwd": cwd,
        "restored": restored,
    });
    let script = format!("window.__SHELLBOARD_WINDOW__ = {payload};");

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Shellboard")
        .inner_size(1024.0, 720.0)
        .min_inner_size(400.0, 240.0)
        .initialization_script(script);
    // Same reason as the main window's config: deliver the window-activating
    // click to the webview (see CLAUDE.md, acceptFirstMouse).
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

// Async on purpose: sync commands run on the main thread, and creating a window
// from there deadlocks on Windows.
#[tauri::command]
pub async fn open_scratch_window<R: Runtime>(
    app: AppHandle<R>,
    id: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let restored = id.is_some();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    build_scratch_window(&app, &id, cwd.as_deref(), restored)?;
    Ok(id)
}

// Delete a scratch window's persisted session + buffers (the user chose to
// discard it rather than keep it for the next launch).
#[tauri::command]
pub async fn discard_scratch_window<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    if !is_valid_scratch_id(&id) {
        return Err(format!("invalid scratch window id: {id}"));
    }
    for name in [scratch_session_file(&id), scratch_buffers_file(&id)] {
        let path = tauri_plugin_store::resolve_store_path(&app, &name).map_err(|e| e.to_string())?;
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn window_labels<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    app.webview_windows().into_keys().collect()
}

#[tauri::command]
pub fn exit_app<R: Runtime>(app: AppHandle<R>) {
    // Best effort: a failed write just means launch focuses the main window.
    if let Ok(path) = tauri_plugin_store::resolve_store_path(&app, LAST_FOCUSED_FILE) {
        let _ = std::fs::write(path, focused_window_label(&app));
    }
    app.exit(0);
}

// Reopen every scratch window that has a persisted session. Scans the same
// directory the store plugin resolves its files against (AppData), so the names
// match the frontend's store files exactly.
pub fn restore_scratch_windows<R: Runtime>(app: &AppHandle<R>) {
    let Ok(probe) = tauri_plugin_store::resolve_store_path(app, scratch_session_file("probe")) else {
        return;
    };
    let Some(dir) = probe.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = parse_scratch_session_file(name) else { continue };
        if let Err(e) = build_scratch_window(app, id, None, true) {
            eprintln!("shellboard: failed to restore scratch window {id}: {e}");
        }
    }
    // Restored windows open on top and take focus; hand it to the window that
    // was focused at quit (falls back to main if that window is gone).
    let last = std::fs::read_to_string(dir.join(LAST_FOCUSED_FILE)).unwrap_or_default();
    let target = app
        .get_webview_window(last.trim())
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = target {
        let _ = window.set_focus();
    }
}

// Label of the focused webview window, falling back to the main window (e.g. a
// menu click while no app window is key).
pub fn focused_window_label<R: Runtime>(app: &AppHandle<R>) -> String {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
        .unwrap_or_else(|| "main".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_ids() {
        assert!(is_valid_scratch_id("3f2b9c1e-0000-4a4a-9b9b-123456789abc"));
        assert!(!is_valid_scratch_id(""));
        assert!(!is_valid_scratch_id("../etc"));
        assert!(!is_valid_scratch_id("a/b"));
        assert!(!is_valid_scratch_id(&"a".repeat(65)));
        assert!(is_valid_scratch_id(&"a".repeat(64)));
        assert!(!is_valid_scratch_id("a_b"));
    }

    #[test]
    fn file_names_round_trip() {
        assert_eq!(scratch_session_file("abc-1"), "scratch-abc-1.session.json");
        assert_eq!(scratch_buffers_file("abc-1"), "scratch-abc-1.buffers.json");
        assert_eq!(parse_scratch_session_file("scratch-abc-1.session.json"), Some("abc-1"));
        assert_eq!(parse_scratch_session_file("scratch-abc-1.buffers.json"), None);
        assert_eq!(parse_scratch_session_file("scratch-../x.session.json"), None);
        assert_eq!(parse_scratch_session_file("session.json"), None);
        let long = format!("scratch-{}.session.json", "a".repeat(200));
        assert_eq!(parse_scratch_session_file(&long), None);
        assert_eq!(parse_scratch_session_file("SCRATCH-abc.session.json"), None);
        assert_eq!(parse_scratch_session_file("scratch-.session.json"), None);
    }
}
