# Scratch Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd/Ctrl+Shift+N opens a project-less "scratch" Shellboard window (tabs, splits, everything but the sidebar); closing it discards it, quitting the app restores it next launch; zoom becomes per window.

**Architecture:** Same frontend bundle in every window. Rust creates scratch windows (label `scratch-<id>`) and injects `window.__SHELLBOARD_WINDOW__` via an initialization script; `App` boots in scratch mode from it. Each window keeps its own zustand store; a scratch window holds one in-memory synthetic project so all existing tab/mosaic/session code is reused, and `persistence.ts` routes its session/buffers to per-window files while making project/group/sidebar saves no-ops. Quit becomes app-wide: flush every window (bounded wait), then `app.exit(0)`.

**Tech Stack:** Tauri 2 (Rust), React 19 + TypeScript, zustand, `@tauri-apps/plugin-store` 2.5, `tauri-plugin-window-state`.

**Spec:** `docs/superpowers/specs/2026-10-16-scratch-windows-design.md`

## Global Constraints

- Shortcut: `primary({ shift: true, key: "n" })` (Cmd on macOS, Ctrl elsewhere — never plain Ctrl on macOS).
- Main window files (`shellboard.json` projects/groups/sidebar, `session.json`, `buffers.json`) must never receive scratch data; a scratch window may write only the `settings` key of `shellboard.json`.
- Quit must not wait more than **2000 ms** for other windows' flush acks.
- Scratch window config: `acceptFirstMouse: true`, title `Shellboard`, inner size 1024×720, min 400×240.
- Zoom: `settings.terminalFontSize` is the shared base; per-window integer `zoomOffset`; effective size clamped to `SETTINGS_LIMITS.terminalFontSize` (8–32); Cmd+0 sets offset to 0.
- Window-creating Tauri commands must be `async` (sync commands run on the main thread; window creation there deadlocks on Windows — see memory note on sync commands).
- All CLAUDE.md invariants hold in every window (store owns PTY lifecycle, remove state before killing PTYs, never throw from `xterm.write` callbacks).
- Gates: `npm run build` (tsc) and `cd src-tauri && cargo check && cargo test`. No frontend test runner exists; don't add one. GUI can't be launched in Claude's environment — manual checks are for the user.
- Commits authored as `Petr Hlozek <petr@petrhlozek.cz>` (`--author`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Deliberately closed scratch window resurrected on next launch.** `tauri-plugin-store` saves *every loaded store* on `RunEvent::Exit`; a deleted file whose store is still loaded gets rewritten. Expected: closing a window closes both its stores (`Store.close()`) *before* Rust deletes the files. (Task 5)
2. **A hung/slow window during quit.** Expected: quit completes within ~2 s anyway; that window's state is whatever its last autosave / the Exit-time store save holds. (Task 6)
3. **Corrupt or half-written scratch session file at launch.** Expected: that window closes itself and discards its files; the main window and other scratch windows are unaffected. (Task 4)
4. **Crafted/foreign file names in the app-data dir (`scratch-../x.session.json`, uppercase, 200-char ids).** Expected: ignored by restore; `discard_scratch_window` refuses ids that aren't `[A-Za-z0-9-]{1,64}` so it can never delete outside its own files. (Task 1)
5. **Menu item clicked while no Shellboard window is focused (all minimized / another app frontmost).** Expected: the action goes to the `main` window, never to every window. (Task 1)

---

### Task 1: Rust scratch-window backend + menu routing

**Files:**
- Create: `src-tauri/src/windows.rs`
- Modify: `src-tauri/src/lib.rs` (mod decl, `use`, `invoke_handler`, `.setup`, `.on_menu_event`, File menus for both platforms, `mac_accel`, `linux_combo`)
- Modify: `src-tauri/capabilities/default.json` (`"windows": ["main", "scratch-*"]`)

**Interfaces:**
- Produces (Tauri commands, camelCase args from JS):
  - `open_scratch_window(id: Option<String>, cwd: Option<String>) -> Result<String, String>` — async; returns the window id (new `uuid` v4 when `id` is `None`). Label `scratch-<id>`, `WebviewUrl::App("index.html".into())`, initialization script `window.__SHELLBOARD_WINDOW__ = <json>;` where json is `{"kind":"scratch","id":…,"cwd":…|null,"restored":bool}` built with `serde_json` (`restored` = `id.is_some()`). If a window with that label already exists, focus it and return the id.
  - `discard_scratch_window(id: String) -> Result<(), String>` — async; rejects invalid ids; deletes `scratch-<id>.session.json` and `scratch-<id>.buffers.json` resolved with `tauri_plugin_store::resolve_store_path` (ignore NotFound).
  - `window_labels() -> Vec<String>` — labels of all open webview windows.
  - `exit_app()` — `app.exit(0)`.
- Produces (Rust, used by lib.rs): `restore_scratch_windows<R: Runtime>(app: &AppHandle<R>)` (called from `.setup` after `migrate_legacy_config`; scans the AppData dir — the same dir `resolve_store_path` uses — and spawns `open_scratch_window` equivalents for every valid `scratch-<id>.session.json`), `focused_window_label<R: Runtime>(app: &AppHandle<R>) -> String` (focused webview window's label, else `"main"`).
- Pure helpers (unit-tested): `is_valid_scratch_id(id: &str) -> bool`, `scratch_session_file(id: &str) -> String`, `scratch_buffers_file(id: &str) -> String`, `parse_scratch_session_file(name: &str) -> Option<&str>`.
- Event change: `menu://action` is now emitted with `app.emit_to(EventTarget::webview_window(focused_window_label(app)), …)` instead of `app.emit`. (Frontend switch to a window-scoped listener is Task 6 — until then the global `listen` still receives it, so nothing breaks in between.)
- Geometry: `tauri-plugin-window-state` already saves/restores per label for runtime-created windows; nothing extra needed beyond stable labels.
- Menu: File → "New Window" via `shortcut_item(h, "menu.window.newScratch", "New Window", shortcuts)` on both platforms, placed right after "New Tab"; `mac_accel` `"CmdOrCtrl+Shift+N"`, `linux_combo` `"Ctrl+Shift+N"`.

- [ ] **Step 1: Write failing unit tests in `windows.rs` `#[cfg(test)] mod tests`**

```rust
#[test] fn valid_ids() {
    assert!(is_valid_scratch_id("3f2b9c1e-0000-4a4a-9b9b-123456789abc"));
    assert!(!is_valid_scratch_id(""));
    assert!(!is_valid_scratch_id("../etc"));
    assert!(!is_valid_scratch_id("a/b"));
    assert!(!is_valid_scratch_id(&"a".repeat(65)));
}
#[test] fn file_names_round_trip() {
    assert_eq!(scratch_session_file("abc-1"), "scratch-abc-1.session.json");
    assert_eq!(scratch_buffers_file("abc-1"), "scratch-abc-1.buffers.json");
    assert_eq!(parse_scratch_session_file("scratch-abc-1.session.json"), Some("abc-1"));
    assert_eq!(parse_scratch_session_file("scratch-abc-1.buffers.json"), None);
    assert_eq!(parse_scratch_session_file("scratch-../x.session.json"), None);
    assert_eq!(parse_scratch_session_file("session.json"), None);
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test windows::` — Expected: FAIL (functions not defined).
- [ ] **Step 3: Implement `windows.rs`** with the interfaces above; register commands in `generate_handler!`, call `restore_scratch_windows` in `.setup`, reroute `on_menu_event`, add the menu items and capability label.
- [ ] **Step 4: Run** `cd src-tauri && cargo test && cargo check` — Expected: all tests PASS, no warnings from `windows.rs`.
- [ ] **Step 5: Commit** — `feat(windows): Rust backend for scratch windows`

---

### Task 2: Per-window zoom

**Files:**
- Create: `src/utils/fontSize.ts`
- Modify: `src/store/appStore.ts` (state `zoomOffset`, action `setZoomOffset`, `restoreSession`, autosave subscriber), `src/utils/sessionSerialize.ts`, `src/shortcuts/actions.ts:112-123` (`zoom`), `src/components/Terminal.tsx:50,67`

**Interfaces:**
- Produces: `effectiveFontSize(base: number, offset: number): number` (clamped to `SETTINGS_LIMITS.terminalFontSize`), `clampZoomOffset(base: number, offset: number): number` in `src/utils/fontSize.ts`.
- Produces: store `zoomOffset: number` (initial `0`), `setZoomOffset(offset: number): void` (stores `clampZoomOffset(settings.terminalFontSize, offset)`).
- Produces: `PersistedSession.zoomOffset?: number` (version stays `1`); `serializeSession` input gains `zoomOffset: number` and writes it; `restoreSession` applies it via `setZoomOffset` when it is a finite number.
- `zoom(delta)`: `+1/-1` → `setZoomOffset(zoomOffset + delta)`; `0` → `setZoomOffset(0)`. Never calls `updateSettings`.
- `Terminal.tsx` reads `effectiveFontSize(s.settings.terminalFontSize, s.zoomOffset)` for both the reactive selector and the initial xterm option.
- The autosave subscriber also fires on `state.zoomOffset !== prev.zoomOffset`.

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Run** `npm run build` — Expected: tsc passes.
- [ ] **Step 3: Self-check by reading:** `grep -rn "terminalFontSize" src` shows no consumer outside settings plumbing/`fontSize.ts`/`Terminal.tsx` selector/SettingsDialog; Settings font-size field still edits the base.
- [ ] **Step 4: Commit** — `feat(zoom): make terminal zoom per window`

---

### Task 3: Window context + scoped persistence

**Files:**
- Create: `src/utils/windowContext.ts`
- Modify: `src/utils/persistence.ts`

**Interfaces:**
- Produces in `windowContext.ts`:
  - `type WindowContext = { kind: "main" } | { kind: "scratch"; id: string; cwd: string | null; restored: boolean }`
  - global `Window.__SHELLBOARD_WINDOW__?: …` declaration
  - `WINDOW_CONTEXT: WindowContext` (read once; anything malformed → `{ kind: "main" }`), `IS_SCRATCH: boolean`
  - `SCRATCH_PROJECT_ID = "scratch"`, `scratchProject(path: string): Project` (`name: "Terminal"`, `groupId: null`, fixed color from the existing palette, `createdAt: Date.now()`)
- `persistence.ts` in scratch mode: `SESSION_FILE`/`BUFFERS_FILE` become `scratch-<id>.session.json` / `scratch-<id>.buffers.json` (must match Task 1's helpers); `saveProjects`, `saveGroups`, `saveSidebarWidth`, `saveSidebarVisible` are no-ops; `loadPersisted` and `saveSettings` unchanged (shared `shellboard.json`).
- Produces: `closeWindowStores(): Promise<void>` — calls `close()` on the session and buffers stores if loaded and resets the cached promises (used by Task 5).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm run build` — Expected: PASS. Main-mode behavior unchanged (file names/branches identical when `IS_SCRATCH` is false).
- [ ] **Step 3: Commit** — `feat(windows): window context and per-window persistence scope`

---

### Task 4: Scratch boot mode and project-less UI

**Files:**
- Modify: `src/App.tsx` (startup effect, update-check effect, render), `src/store/appStore.ts` (`closeTab` last-tab branch), `src/components/TopBar.tsx`, `src/components/CommandPalette.tsx`, `src/shortcuts/actions.ts`

**Interfaces:**
- Consumes: `WINDOW_CONTEXT`, `IS_SCRATCH`, `scratchProject`, `SCRATCH_PROJECT_ID` (Task 3); `closeScratchWindowNow` (defined here as a stub that Task 5 completes — see below).
- Scratch startup (replaces the main hydration path when `IS_SCRATCH`): load `settings` only; `hydrate({ projects: [scratchProject(cwd ?? await invoke("home_dir"))], groups: [], sidebarVisible: false, settings })`; then `loadSession()`/`loadBuffers()` (scoped). If a session with `tabsByProject[SCRATCH_PROJECT_ID]` exists → `restoreSession` + deferred autosave (same 3 s rule). Else if `restored` is true (file vanished/corrupt) → `closeScratchWindowNow()`. Else → `setActiveProject(SCRATCH_PROJECT_ID)` then `addTab({ projectId: SCRATCH_PROJECT_ID, cwd: cwd ?? undefined })`, enable autosave. Any exception in a restored window → `closeScratchWindowNow()`.
- Update check effect: skipped when `IS_SCRATCH`.
- Render: no `<Sidebar>`, no `AddProjectFlow`, no empty-state text when `IS_SCRATCH`. `TopBar` hides the project name; `CommandPalette` hides the whole "Projects" group (add/rename/open-in-finder/switch/snippets).
- `actions.ts`: `project.quickAdd`, `project.add`, `sidebar.toggle` return early when `IS_SCRATCH`.
- `closeTab`: when `IS_SCRATCH` and the project lost its last tab → `void get().closeScratchWindowNow()` instead of respawning. (This is the `exit`-in-last-panel path; nothing can be running, so no confirm.)
- Store action `closeScratchWindowNow(): Promise<void>` — in this task: `await getCurrentWebviewWindow().destroy()`; Task 5 adds the discard steps.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm run build` — Expected: PASS.
- [ ] **Step 3: Commit** — `feat(windows): scratch window boot mode without projects`

---

### Task 5: Closing a scratch window (confirm if running, discard state)

**Files:**
- Create: `src/utils/runningApps.ts`
- Modify: `src/store/appStore.ts`, `src/App.tsx` (close-requested handler, new ConfirmDialog), `src/components/RunningApps.tsx` (reuse the shared type)

**Interfaces:**
- Produces in `runningApps.ts`: exported `RunningApp` type (moved from `RunningApps.tsx`), `runningAppsInThisWindow(): Promise<RunningApp[]>` — `invoke("running_apps_snapshot")`, keep entries whose key is a leaf of this window's tabs.
- Produces store state `pendingWindowClose: RunningApp[] | null` and actions:
  - `requestCloseWindow(): Promise<void>` — `runningAppsInThisWindow()`; empty → `closeScratchWindowNow()`; else set `pendingWindowClose`. On invoke failure, fall back to asking (with an empty list message "Close this window and end all its terminals?").
  - `confirmCloseWindow()`, `cancelCloseWindow()`.
  - `closeScratchWindowNow()` (completes Task 4's stub), in this order: `disableSessionAutosave()` (new export next to `enableSessionAutosave`; cancels timers and awaits any in-flight flush) → clear `tabs`/`terminals` from state → kill every PTY → `closeWindowStores()` → `invoke("discard_scratch_window", { id })` → `destroy()`. Errors in the middle steps are logged, never block `destroy()`.
- Entry points routed to `requestCloseWindow()` when `IS_SCRATCH`: window `onCloseRequested` (preventDefault first; skip entirely and allow the close if `isAppQuitting()` from Task 6 — until Task 6 lands, treat as false), `requestCloseTab` on the last remaining tab, `closeActivePanel` when it would remove the last leaf of the last tab.
- The existing Running apps dialog needs no change: `buildRows` walks this window's `projects`/`tabs`, so it already shows only this window's terminals.
- Dialog (App.tsx): title `Close window?`, message `These programs are still running: <name>, <name>. Closing the window will end them.`, confirm `Close window`, destructive; counts as a modal in `modalOpenRef`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm run build` — Expected: PASS.
- [ ] **Step 3: Self-check by reading** `closeScratchWindowNow`: stores are closed before `discard_scratch_window` (Review Focus #1); state is removed before PTYs are killed (CLAUDE.md).
- [ ] **Step 4: Commit** — `feat(windows): confirm and discard when closing a scratch window`

---

### Task 6: App-wide quit, per-window menu events, settings sync, New Window action

**Files:**
- Create: `src/utils/appLifecycle.ts`
- Modify: `src/shortcuts/actions.ts` (`performQuit`, new handler), `src/shortcuts/registry.ts`, `src/App.tsx` (menu listener, listeners install), `src/store/appStore.ts` (`updateSettings`, new `applyExternalSettings`)

**Interfaces:**
- Produces in `appLifecycle.ts`:
  - `isAppQuitting(): boolean`
  - `quitApp(): Promise<void>` — mark quitting; `others = (await invoke<string[]>("window_labels")).filter(l => l !== ownLabel)`; start collecting `app://quit-flush-ack` `{ requestId, label }` for `others`; `emit("app://quit-flush", { requestId })`; await own `flushSessionSave()` (errors swallowed) and acks-or-2000 ms; `invoke("exit_app")`.
  - `installLifecycleListeners(): () => void` — on `app://quit-flush` (from another window): mark quitting, flush, emit ack. On `settings://changed` `{ from, settings }` with `from !== ownLabel`: `applyExternalSettings(settings)`.
  - `openScratchWindow(cwd: string | null): Promise<void>` — `invoke("open_scratch_window", { id: null, cwd })`, errors → `showError`.
- `performQuit()` now just calls `quitApp()` (the confirm flow via `requestQuit` stays as is, in whichever window got the request).
- `updateSettings`: after `saveSettings`, `emit("settings://changed", { from: ownLabel, settings: next })`. `applyExternalSettings(s: Settings)`: `set({ settings: clampSettings(s) })`, no save; if `persistScrollback` went true→false, wipe this window's buffers like `updateSettings` does; re-clamp `zoomOffset`.
- Menu listener in App.tsx: `getCurrentWebviewWindow().listen("menu://action", …)` instead of global `listen` (Task 1 now targets the focused window).
- Registry: `{ id: "window.newScratch", category: "App", label: "New scratch window", defaultBinding: primary({ shift: true, key: "n" }) }`. Handler: cwd of `activeAnchor()` terminal (or `null`) → `openScratchWindow(cwd)`. Works in both window kinds.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm run build && (cd src-tauri && cargo check)` — Expected: PASS.
- [ ] **Step 3: Self-check by reading:** quit waits ≤ 2000 ms (Review Focus #2); a scratch window's `onCloseRequested` lets the close through without discarding when `isAppQuitting()`.
- [ ] **Step 4: Commit** — `feat(windows): app-wide quit, focused-window menu, settings sync, Cmd+Shift+N`

---

### Task 7: Docs and hand-off checklist

**Files:**
- Modify: `CLAUDE.md` (multi-window section: window context, scoped persistence + file names, Exit-time store resave gotcha, menu routing via `emit_to` + window-scoped listen, quit path, per-window zoom; update the Tauri command surface list), `CHANGELOG.md` (Unreleased: scratch windows, per-window zoom, quick-add return fix from commit `57a86d8`)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npm run build && (cd src-tauri && cargo test)` — Expected: PASS.
- [ ] **Step 3: Commit** — `docs: scratch windows`
- [ ] **Step 4: Hand the user the manual checklist** from the spec's Verification section (7 items) plus Review Focus #1–#5.
