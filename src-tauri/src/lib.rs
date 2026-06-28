mod pty;

use std::collections::HashMap;

use pty::{
    git_branch, git_status, home_dir, kill_pty, resize_pty, running_apps_snapshot, spawn_pty,
    write_to_pty, PtyManager,
};
use std::path::Path;

use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

// Per-item shortcut display the frontend pushes (see set_menu_shortcuts). `accel`
// is a Tauri/muda accelerator string (used on macOS for a real, right-aligned
// accelerator); `text` is the human-readable combo (appended to the label on
// Linux/Windows). Both reflect the user's CURRENT bindings, so rebinding in
// Settings updates the menu live.
// Both fields are deserialized cross-platform; only one is read per platform
// (accel on macOS, text elsewhere), so allow the other to look unused.
#[derive(serde::Deserialize, Default)]
#[allow(dead_code)]
struct ShortcutInfo {
    #[serde(default)]
    accel: String,
    #[serde(default)]
    text: String,
}

// macOS fallback accelerators (Tauri/muda format) matching the DEFAULT bindings
// in src/shortcuts/registry.ts. Used at startup before the frontend pushes the
// live bindings, so shortcuts show immediately. Real accelerators render
// right-aligned natively (like the system Copy/Paste). They don't double-fire
// with the app's JS dispatcher: WKWebView delivers the key to the page first and
// the JS handler consumes bound keys, so the menu accelerator is display-only —
// proven by the app's ⌘W closing a tab today rather than "Close Window".
#[cfg(target_os = "macos")]
fn mac_accel(id: &str) -> &'static str {
    match id {
        "menu.tab.new" => "CmdOrCtrl+T",
        "menu.tab.close" => "CmdOrCtrl+W",
        "menu.panel.close" => "CmdOrCtrl+Shift+W",
        "menu.tab.next" => "CmdOrCtrl+Shift+]",
        "menu.tab.prev" => "CmdOrCtrl+Shift+[",
        "menu.split.vertical" => "CmdOrCtrl+D",
        "menu.split.horizontal" => "CmdOrCtrl+Shift+D",
        "menu.split.left" => "CmdOrCtrl+Shift+Left",
        "menu.split.right" => "CmdOrCtrl+Shift+Right",
        "menu.split.up" => "CmdOrCtrl+Shift+Up",
        "menu.split.down" => "CmdOrCtrl+Shift+Down",
        "menu.focus.left" => "CmdOrCtrl+Alt+Left",
        "menu.focus.right" => "CmdOrCtrl+Alt+Right",
        "menu.focus.up" => "CmdOrCtrl+Alt+Up",
        "menu.focus.down" => "CmdOrCtrl+Alt+Down",
        "menu.search.terminal" => "CmdOrCtrl+F",
        "menu.search.global" => "CmdOrCtrl+Shift+F",
        "menu.zoom.in" => "CmdOrCtrl+=",
        "menu.zoom.out" => "CmdOrCtrl+-",
        "menu.zoom.reset" => "CmdOrCtrl+0",
        "menu.project.quickAdd" => "CmdOrCtrl+N",
        "menu.sidebar.toggle" => "CmdOrCtrl+B",
        "menu.settings.open" => "CmdOrCtrl+,",
        "menu.palette.open" => "CmdOrCtrl+K",
        _ => "",
    }
}

// Linux/Windows fallback combo text (default bindings, formatted like
// src/shortcuts/binding.ts `formatBinding`). Shown as plain label text — real
// accelerators there would double-fire with the webview / steal terminal keys
// (Ctrl+C is SIGINT).
#[cfg(not(target_os = "macos"))]
fn linux_combo(id: &str) -> &'static str {
    match id {
        "menu.tab.new" => "Ctrl+T",
        "menu.tab.close" => "Ctrl+W",
        "menu.panel.close" => "Ctrl+Shift+W",
        "menu.tab.next" => "Ctrl+Shift+]",
        "menu.tab.prev" => "Ctrl+Shift+[",
        "menu.split.vertical" => "Ctrl+D",
        "menu.split.horizontal" => "Ctrl+Shift+D",
        "menu.split.left" => "Ctrl+Shift+←",
        "menu.split.right" => "Ctrl+Shift+→",
        "menu.split.up" => "Ctrl+Shift+↑",
        "menu.split.down" => "Ctrl+Shift+↓",
        "menu.focus.left" => "Ctrl+Alt+←",
        "menu.focus.right" => "Ctrl+Alt+→",
        "menu.focus.up" => "Ctrl+Alt+↑",
        "menu.focus.down" => "Ctrl+Alt+↓",
        "menu.search.terminal" => "Ctrl+F",
        "menu.search.global" => "Ctrl+Shift+F",
        "menu.zoom.in" => "Ctrl+=",
        "menu.zoom.out" => "Ctrl+-",
        "menu.zoom.reset" => "Ctrl+0",
        "menu.project.quickAdd" => "Ctrl+N",
        "menu.sidebar.toggle" => "Ctrl+B",
        "menu.settings.open" => "Ctrl+,",
        "menu.palette.open" => "Ctrl+K",
        _ => "",
    }
}

// Build a menu item for an app action that has a keyboard shortcut, using the
// pushed live binding when present and the per-platform default otherwise. macOS
// gets a real (display-only-in-practice) accelerator so it renders right-aligned;
// other platforms get the combo as plain label text. Falls back to a plain item
// if an accelerator string fails to parse, so a typo can never take the whole
// menu down.
fn shortcut_item<R: Runtime>(
    h: &AppHandle<R>,
    id: &str,
    base: &str,
    shortcuts: &HashMap<String, ShortcutInfo>,
) -> tauri::Result<MenuItem<R>> {
    #[cfg(target_os = "macos")]
    {
        let accel = shortcuts
            .get(id)
            .map(|s| s.accel.clone())
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| mac_accel(id).to_string());
        if !accel.is_empty() {
            if let Ok(item) = MenuItemBuilder::with_id(id, base)
                .accelerator(accel.as_str())
                .build(h)
            {
                return Ok(item);
            }
        }
        MenuItemBuilder::with_id(id, base).build(h)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let combo = shortcuts
            .get(id)
            .map(|s| s.text.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| linux_combo(id).to_string());
        let label = if combo.is_empty() {
            base.to_string()
        } else {
            format!("{base}\t{combo}")
        };
        MenuItemBuilder::with_id(id, label).build(h)
    }
}

// Native application menu. Click events are forwarded to the frontend via
// `menu://action` (App.tsx listens and dispatches to the same store actions the
// keyboard shortcuts use). The macOS Edit/Window submenus reproduce the default
// macOS menu we replace (their predefined ⌘C/⌘V/⌘M… never collide with the app's
// bindings); on Linux/Windows we omit the predefined editing items because their
// Ctrl+C/Ctrl+V would hijack the terminal's SIGINT and Ctrl+Shift+C/V.
fn build_menu<R: Runtime>(
    h: &AppHandle<R>,
    shortcuts: &HashMap<String, ShortcutInfo>,
) -> tauri::Result<Menu<R>> {
    let quit = {
        let b = MenuItemBuilder::with_id("menu.app.quit", "Quit Shellboard");
        #[cfg(target_os = "macos")]
        let b = b.accelerator("CmdOrCtrl+Q");
        b.build(h)?
    };

    // Cross-platform submenus.
    let view = SubmenuBuilder::new(h, "View")
        .item(&shortcut_item(h, "menu.sidebar.toggle", "Toggle Sidebar", shortcuts)?)
        .item(&shortcut_item(h, "menu.palette.open", "Command Palette…", shortcuts)?)
        .separator()
        .item(&shortcut_item(h, "menu.zoom.in", "Zoom In", shortcuts)?)
        .item(&shortcut_item(h, "menu.zoom.out", "Zoom Out", shortcuts)?)
        .item(&shortcut_item(h, "menu.zoom.reset", "Reset Zoom", shortcuts)?)
        .separator()
        .text("menu.theme.toggle", "Toggle Light/Dark Chrome")
        .text("menu.broadcast.toggle", "Toggle Broadcast Input")
        .build()?;

    let terminal = SubmenuBuilder::new(h, "Terminal")
        .item(&shortcut_item(h, "menu.split.vertical", "Split Vertical (Panel Right)", shortcuts)?)
        .item(&shortcut_item(h, "menu.split.horizontal", "Split Horizontal (Panel Down)", shortcuts)?)
        .separator()
        .item(&shortcut_item(h, "menu.split.left", "Split Left", shortcuts)?)
        .item(&shortcut_item(h, "menu.split.right", "Split Right", shortcuts)?)
        .item(&shortcut_item(h, "menu.split.up", "Split Up", shortcuts)?)
        .item(&shortcut_item(h, "menu.split.down", "Split Down", shortcuts)?)
        .separator()
        .item(&shortcut_item(h, "menu.focus.left", "Focus Left", shortcuts)?)
        .item(&shortcut_item(h, "menu.focus.right", "Focus Right", shortcuts)?)
        .item(&shortcut_item(h, "menu.focus.up", "Focus Up", shortcuts)?)
        .item(&shortcut_item(h, "menu.focus.down", "Focus Down", shortcuts)?)
        .separator()
        .item(&shortcut_item(h, "menu.tab.next", "Next Tab", shortcuts)?)
        .item(&shortcut_item(h, "menu.tab.prev", "Previous Tab", shortcuts)?)
        .separator()
        .item(&shortcut_item(h, "menu.apps.running", "Running Apps…", shortcuts)?)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(h, "Shellboard")
            .text("menu.app.about", "About Shellboard")
            .separator()
            .item(&shortcut_item(h, "menu.settings.open", "Settings…", shortcuts)?)
            .separator()
            .item(&PredefinedMenuItem::services(h, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(h, None)?)
            .item(&PredefinedMenuItem::hide_others(h, None)?)
            .item(&PredefinedMenuItem::show_all(h, None)?)
            .separator()
            .item(&quit)
            .build()?;

        let file = SubmenuBuilder::new(h, "File")
            .item(&shortcut_item(h, "menu.tab.new", "New Tab", shortcuts)?)
            .text("menu.tab.duplicate", "Duplicate Tab")
            .separator()
            .text("menu.project.add", "Add Project…")
            .item(&shortcut_item(h, "menu.project.quickAdd", "Quick-Add Project from cwd", shortcuts)?)
            .separator()
            .item(&shortcut_item(h, "menu.tab.close", "Close Tab", shortcuts)?)
            .text("menu.tab.closeOthers", "Close Other Tabs")
            .text("menu.tab.closeRight", "Close Tabs to the Right")
            .item(&shortcut_item(h, "menu.panel.close", "Close Panel", shortcuts)?)
            .build()?;

        // Predefined editing items are REQUIRED on macOS (we replace the default
        // menu). Their ⌘C/⌘V/⌘A are safe: while the terminal is first responder
        // WKWebView handles them before the menu, so xterm copy/paste still wins.
        let edit = SubmenuBuilder::new(h, "Edit")
            .item(&PredefinedMenuItem::undo(h, None)?)
            .item(&PredefinedMenuItem::redo(h, None)?)
            .separator()
            .item(&PredefinedMenuItem::cut(h, None)?)
            .item(&PredefinedMenuItem::copy(h, None)?)
            .item(&PredefinedMenuItem::paste(h, None)?)
            .item(&PredefinedMenuItem::select_all(h, None)?)
            .separator()
            .text("menu.tab.rename", "Rename Tab…")
            .item(&shortcut_item(h, "menu.search.terminal", "Find in Terminal", shortcuts)?)
            .item(&shortcut_item(h, "menu.search.global", "Global Search…", shortcuts)?)
            .build()?;

        let window = SubmenuBuilder::new(h, "Window")
            .item(&PredefinedMenuItem::minimize(h, None)?)
            .separator()
            .item(&PredefinedMenuItem::fullscreen(h, None)?)
            .build()?;

        let help = SubmenuBuilder::new(h, "Help")
            .text("menu.help.shortcuts", "Keyboard Shortcuts")
            .separator()
            .text("menu.app.about", "About Shellboard")
            .build()?;

        return MenuBuilder::new(h)
            .item(&app_menu)
            .item(&file)
            .item(&edit)
            .item(&view)
            .item(&terminal)
            .item(&window)
            .item(&help)
            .build();
    }

    #[cfg(not(target_os = "macos"))]
    {
        let file = SubmenuBuilder::new(h, "File")
            .item(&shortcut_item(h, "menu.tab.new", "New Tab", shortcuts)?)
            .text("menu.tab.duplicate", "Duplicate Tab")
            .separator()
            .text("menu.project.add", "Add Project…")
            .item(&shortcut_item(h, "menu.project.quickAdd", "Quick-Add Project from cwd", shortcuts)?)
            .separator()
            .item(&shortcut_item(h, "menu.settings.open", "Settings…", shortcuts)?)
            .separator()
            .item(&shortcut_item(h, "menu.tab.close", "Close Tab", shortcuts)?)
            .text("menu.tab.closeOthers", "Close Other Tabs")
            .text("menu.tab.closeRight", "Close Tabs to the Right")
            .item(&shortcut_item(h, "menu.panel.close", "Close Panel", shortcuts)?)
            .separator()
            .item(&quit)
            .build()?;

        // No predefined Ctrl+C / Ctrl+V items here — they would steal the
        // terminal's Ctrl+C (SIGINT). The webview handles input editing natively.
        let edit = SubmenuBuilder::new(h, "Edit")
            .text("menu.tab.rename", "Rename Tab…")
            .item(&shortcut_item(h, "menu.search.terminal", "Find in Terminal", shortcuts)?)
            .item(&shortcut_item(h, "menu.search.global", "Global Search…", shortcuts)?)
            .build()?;

        let help = SubmenuBuilder::new(h, "Help")
            .text("menu.help.shortcuts", "Keyboard Shortcuts")
            .separator()
            .text("menu.app.about", "About Shellboard")
            .build()?;

        return MenuBuilder::new(h)
            .item(&file)
            .item(&edit)
            .item(&view)
            .item(&terminal)
            .item(&help)
            .build();
    }
}

// Rebuild the menu with the user's current shortcut combos and apply it. The
// frontend calls this on startup and whenever keybindings change, passing
// { menuItemId: { accel, text } }. Menu mutation touches AppKit, which aborts the
// process off the main thread on macOS — so build + apply on the main thread.
#[tauri::command]
fn set_menu_shortcuts(
    app: AppHandle,
    shortcuts: HashMap<String, ShortcutInfo>,
) -> Result<(), String> {
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        if let Ok(menu) = build_menu(&app_main, &shortcuts) {
            let _ = app_main.set_menu(menu);
        }
    })
    .map_err(|e| e.to_string())
}

// The bundle identifier changed from cz.petrhlozek.shellboard to
// cz.calmbit.shellboard, which moves the per-app config/data dir. To avoid
// orphaning existing users' projects, sessions and scrollback, copy the old
// dir into the new one on first launch under the new identifier. We COPY (not
// move) so the old dir stays as a backup if anything goes wrong, and only when
// the new dir doesn't yet exist — so we never clobber data the user already
// created under the new id, and the migration runs exactly once.
//
// After a successful copy we drop a countdown marker into the new dir and only
// delete the old dir once the user has launched the migrated app a few times,
// so the backup survives long enough to recover from a bad first run.
const OLD_BUNDLE_ID: &str = "cz.petrhlozek.shellboard";
const NEW_BUNDLE_ID: &str = "cz.calmbit.shellboard";
const CLEANUP_MARKER: &str = ".legacy-cleanup";
const CLEANUP_LAUNCHES: u32 = 3;

fn migrate_legacy_config<R: Runtime>(app: &AppHandle<R>) {
    // On macOS app_config_dir == app_data_dir; on Linux they differ, so handle
    // both, de-duplicating so the same path isn't processed twice in one launch.
    let candidates = [app.path().app_config_dir(), app.path().app_data_dir()];
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    for new_dir in candidates.into_iter().flatten() {
        if seen.contains(&new_dir) {
            continue;
        }
        seen.push(new_dir.clone());

        let Some(parent) = new_dir.parent() else { continue };
        let old_dir = parent.join(OLD_BUNDLE_ID);
        // Only act when the new dir is actually the new bundle id and the old
        // dir is a real, distinct directory.
        if new_dir.file_name().and_then(|n| n.to_str()) != Some(NEW_BUNDLE_ID) {
            continue;
        }
        if old_dir == new_dir {
            continue;
        }

        if !new_dir.exists() {
            // First launch under the new id: migrate if there's anything to copy.
            if !old_dir.is_dir() {
                continue;
            }
            if let Err(e) = copy_dir_recursive(&old_dir, &new_dir) {
                eprintln!("shellboard: legacy config migration failed: {e}");
                // Don't leave a half-copied dir that would block a retry.
                let _ = std::fs::remove_dir_all(&new_dir);
                continue;
            }
            // Arm the delayed cleanup of the old dir (the backup).
            let _ = std::fs::write(new_dir.join(CLEANUP_MARKER), CLEANUP_LAUNCHES.to_string());
        } else {
            // Already migrated (or a native new-id install): advance any pending
            // cleanup of the leftover backup.
            tick_legacy_cleanup(&new_dir.join(CLEANUP_MARKER), &old_dir);
        }
    }
}

// Count down successful launches and, once the budget is spent, delete the old
// backup dir and the marker. If the backup is already gone, just drop the marker.
fn tick_legacy_cleanup(marker: &Path, old_dir: &Path) {
    let Ok(contents) = std::fs::read_to_string(marker) else { return };
    if !old_dir.is_dir() {
        let _ = std::fs::remove_file(marker);
        return;
    }
    let remaining = contents.trim().parse::<u32>().unwrap_or(0).saturating_sub(1);
    if remaining == 0 {
        let _ = std::fs::remove_dir_all(old_dir);
        let _ = std::fs::remove_file(marker);
    } else {
        let _ = std::fs::write(marker, remaining.to_string());
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            migrate_legacy_config(app.handle());
            Ok(())
        })
        .menu(|handle| build_menu(handle, &HashMap::new()))
        .on_menu_event(|app, event| {
            let _ = app.emit("menu://action", event.id().as_ref());
        })
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_to_pty,
            resize_pty,
            kill_pty,
            home_dir,
            git_branch,
            git_status,
            running_apps_snapshot,
            set_menu_shortcuts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
