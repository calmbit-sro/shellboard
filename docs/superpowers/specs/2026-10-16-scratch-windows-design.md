# Scratch windows (Cmd/Ctrl+Shift+N) — design

Date: 2026-10-16
Status: awaiting user approval

## Intent

The user currently launches iTerm whenever they need a throwaway terminal —
"quickly sort something out, then close it". They'd rather stay in Shellboard.
A **scratch window** is a second (third, …) Shellboard window that is the
normal terminal experience — tabs, splits, search, themes — **without the
project sidebar**. Closing it throws it away. Quitting the whole app, however,
must not lose it: on the next launch every scratch window that was open comes
back with the same tabs, split layout, per-panel cwd and scrollback.

(The companion fix — Cmd+N quick-add returning to the origin tab on `exit` —
is a separate, already-implemented small change, not part of this design.)

## Goals

- `Cmd+Shift+N` (macOS) / `Ctrl+Shift+N` (Linux/Windows) opens a new scratch
  window. Any number can be open at once; each has its own independent tabs.
- Also reachable from the native menu (File → New Window) and the command
  palette (it's a registry action, so it's rebindable like every other).
- Works from the main window and from a scratch window.
- First terminal starts in the cwd of the focused terminal of the window the
  shortcut was pressed in; home dir if there is none.
- Inside a scratch window: tabs, splits, reopen-closed-tab, find, global
  search, broadcast, zoom, running apps, settings all work as in the main
  window, scoped to that window's terminals.
- **Closing a scratch window** (window close button, Cmd+W on the last tab,
  `exit` in the last panel): if any of its terminals has a running foreground
  program (same detection as Running apps — `running_apps_snapshot`), ask
  first, listing what's running; otherwise close immediately. Closing kills
  its PTYs and **deletes** its persisted state. It never comes back.
- **Quitting the app** (Cmd+Q from any window, menu Quit, closing the main
  window) keeps every open scratch window's state on disk; next launch
  re-opens them with tabs, mosaic layout, cwd per leaf, scrollback (honoring
  `persistScrollback`), and window position/size.

## Non-goals

- No projects inside scratch windows: no sidebar, no project switching, no
  snippets, no git badge tied to a project. Project-only actions (quick-add
  Cmd+N, add project, project switch, sidebar toggle) are no-ops there.
- No moving tabs between windows (drag a tab to another window).
- No multiple *main* windows.
- No "convert scratch window into a project".

## Anti-goals (would make this a failure even if it technically works)

- A scratch window's tabs leaking into the main window's sidebar, its
  `session.json`, or `shellboard.json` — or vice versa.
- Main window's session restore or autosave getting slower/riskier for users
  who never open a scratch window.
- A closed scratch window reappearing after restart; or an open one vanishing
  after Cmd+Q.
- Cmd+Q losing the in-flight debounced save of *any* window (main already
  solved this with `flushSessionSave`; scratch windows need the same guarantee).
- Menu shortcuts / menu actions firing in every window at once.

## Constraints and facts from the codebase

- Each Tauri webview window is its own JS realm → its own zustand store,
  `terminalRegistry`, autosave timer. Nothing is shared implicitly.
- PTYs live in the single Rust `PtyManager`; events `pty://{id}/data|exit`
  are app-wide (`app.emit`). A window only listens to its own ids, so this
  works as-is, but `running_apps_snapshot` returns *all* sessions — callers
  must filter to their own leaves (Running apps dialog in a scratch window
  shows only that window's terminals; the main one only its own).
- Menu events are broadcast: `on_menu_event` does `app.emit("menu://action")`
  (`src-tauri/src/lib.rs`). With several windows this must go to the
  **focused** window only (`emit_to` the focused webview label).
- `performQuit()` today = `flushSessionSave()` + `destroy()` of the current
  window, which ends the app because it's the only window. With more windows
  that no longer quits the app; quitting needs an explicit app exit after all
  windows have flushed.
- Capabilities (`src-tauri/capabilities/default.json`) are scoped to
  `"windows": ["main"]`. Scratch windows need the same permissions (label
  pattern, e.g. `"scratch-*"`), plus window-creation permission wherever
  windows get created.
- `tauri-plugin-window-state` keys saved geometry by window label → scratch
  labels must be **stable across restarts** (persisted id → label).
- `@tauri-apps/plugin-store` files are shared per path across windows on the
  Rust side, but each window keeps its own copy of settings in zustand.
- Keyboard convention: Cmd on macOS, Ctrl elsewhere, via the `primary()`
  helper in `src/shortcuts/registry.ts`. `Cmd+Shift+N` is currently unbound.
- CLAUDE.md invariants still apply in every window: store owns PTY lifecycle,
  remove state before killing PTYs, buffer-replay escape handling, never throw
  from `xterm.write` callbacks, `acceptFirstMouse` + activating-click
  suppression (scratch window config needs `acceptFirstMouse: true` too).

## Decided by the user

- Several scratch windows may be open simultaneously.
- Closing a scratch window asks for confirmation **only** when something is
  running in it.
- Scratch windows survive an app quit/restart with tabs, layout, cwd and
  history; a deliberately closed one is gone for good.
- Closing the **main** window quits the whole app (today's behavior, on every
  platform); scratch windows close with it and are restored next launch. The
  main window therefore stays the single owner of startup restore and of the
  quit path.
- **Zoom is per window.** Cmd+= / Cmd+- / Cmd+0 in one window must not change
  font size in any other window.

## Calls made by Claude (check these)

- Zoom model: `settings.terminalFontSize` becomes the shared **base** size
  (still edited in Settings, still applies to all windows). Each window keeps
  its own zoom **offset** (integer, clamped so base+offset stays within
  `SETTINGS_LIMITS.terminalFontSize`). Zoom actions change only the offset;
  Cmd+0 resets it to 0. The main window's offset is saved in `session.json`,
  a scratch window's with its own persisted state, so zoom survives restart
  in both. Existing users: their current `terminalFontSize` becomes the base
  with offset 0, so nothing visibly changes on upgrade. Today `zoom()` in
  `src/shortcuts/actions.ts` writes `terminalFontSize` directly — that changes.
- Cmd+Q from a scratch window quits the whole app (same as from main), going
  through the existing `confirmBeforeQuitting` dialog once — shown in the
  window where Cmd+Q was pressed.
- Scratch windows restore their screen position and size.
- Settings are shared: one `settings` object in `shellboard.json`. Changing
  settings in any window applies to all open windows live (zoom is not a
  setting any more — see above).
- Window title: "Shellboard" plus the active tab title, like the main window
  (no special "scratch" marker) — revisit if it's confusing in Mission Control.
- The quit-confirmation and the close-with-running-programs confirmation are
  separate dialogs; quitting does not additionally ask per scratch window.

## Suggested shape (builder may deviate with reason)

- **One frontend, a window mode.** Scratch windows load the same `index.html`
  with a query param (e.g. `?scratch=<id>`). `App` reads it once and runs in
  scratch mode: no sidebar, no project hydration, its own persistence keys.
- **Tabs still need a `projectId`.** Simplest is a synthetic per-window
  project id held in memory only (never written to `projects`). Builder's
  choice — the requirement is the anti-goal above, not the mechanism.
- **Persistence.** Keep the main window's files untouched. Scratch state goes
  to separate store file(s), e.g. `scratch-windows.json` holding
  `{ [id]: { layout per tab, activeTab, … } }` and per-window buffer storage,
  so one window's big scrollback can't corrupt another's or the main
  session. Each scratch window runs its own debounced autosave (reuse
  `sessionSerialize`) and deletes its entry on deliberate close.
- **Startup restore.** The main window (or Rust `setup`) reads the list of
  saved scratch ids after its own hydration and re-creates those windows
  with their stable labels. A window whose entry is missing/corrupt simply
  isn't opened (and the entry is dropped).
- **Quit coordination.** A single "quit app" path: confirm (if enabled) →
  ask every window to flush its pending save → wait for acks (bounded
  timeout, e.g. 2 s, so a hung window can't block quit) → exit the app.
  A scratch window's close handler must distinguish "app is quitting" (keep
  state) from "user closed this window" (confirm-if-running, delete state).
- **Last tab closed in a scratch window** closes the window (instead of the
  main window's respawn-a-shell behavior).

## Left to the builder

- Exact store/key/file names, the query-param name, window label scheme.
- Whether scratch windows are created from JS (`WebviewWindow`) or by a Rust
  command.
- How settings changes are propagated (event broadcast + re-read is fine).
- Default size of a new scratch window (main's 1024×720 is fine) and whether
  it cascades from the source window's position.
- Docs: update CLAUDE.md (multi-window section, menu routing, quit path) and
  CHANGELOG.

## Verification

No test runner exists; `npm run build` (tsc) and `cargo check` are the
gates. The GUI can't be launched in Claude's environment, so the user tests
manually:

1. Cmd+Shift+N from main and from a scratch window; cwd inherited.
2. Split, several tabs, `exit` in the last panel → window closes, not
   restored after restart.
3. Run `sleep 100`, close the window → confirmation listing `sleep`.
4. Two scratch windows with splits + output, Cmd+Q → relaunch → both back
   with layout, cwd, scrollback, position.
5. Zoom in a scratch window leaves main's font size alone; survives restart.
6. Menu shortcuts (e.g. New Tab) act only on the focused window.
7. Main window session restore unaffected when no scratch windows exist.
