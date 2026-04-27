# Changelog

All notable changes to Shellboard will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-04-27

### Added

- **Lazy project restore.** Startup no longer spawns PTYs for every
  project up front — only the last-active project boots immediately;
  others stash their persisted layout and spawn the moment you click
  them in the sidebar. Big startup win when you have many projects but
  typically work in one or two per session. Pending projects are merged
  back into `session.json` at save time so they survive launches even
  if you never open them.
- **Persist scrollback toggle.** New *Settings → Persist scrollback
  across restarts* lets you turn off `buffers.json` writes — restored
  sessions then come back with empty terminals. Existing snapshots are
  wiped when you flip the toggle off. Default is on (current behavior
  preserved).
- **Close panel from the panel context menu.** Right-click inside a
  panel and pick *Close Panel* — same effect as `Cmd/Ctrl+W` on the
  focused panel.

### Fixed

- **TUI app rendering after window resize.** Ink-based CLIs (Claude
  Code et al.) left frame fragments behind when the window grew, only
  cleaning up after a subsequent shrink. The 100 ms debounce on
  `resize_pty` was leaving xterm and the PTY out of sync inside the
  resize window — xterm rendered at the new size, but the TUI was
  still drawing for the old PTY size. Resize now goes to the PTY per
  frame; the upstream `ResizeObserver → RAF` chain already coalesces
  drag callbacks to ~60 Hz, so a second debounce layer is unnecessary.
- **PTY size drift after font change / tab activation.** Setting
  `xterm.options = { fontFamily, fontSize }` recomputes cell metrics
  but doesn't always fire `onResize` if cols/rows happen to land on
  the same numbers. A new `fitAndSync` helper consolidates "fit + push
  to PTY" into a single call, used after font changes, on tab
  activation, and at mount, so the PTY can't drift out of sync with
  what xterm displays.

## [1.2.1] — 2026-04-26

### Added

- **Middle-click paste.** Clicking the middle mouse button inside a
  terminal pastes the clipboard contents, matching the X11 convention.
  Combined with copy-on-select, this gives the classic "select to copy,
  middle-click to paste" workflow on every platform.

## [1.2.0] — 2026-04-26

### Added

- **Quick-add projects (`Cmd/Ctrl+N`).** Spawn an ephemeral project
  pinned to the focused terminal's cwd — random color, no group,
  caption tracks the active panel's directory live. Closing the last
  tab removes the project. Quick-add projects render in their own
  bottom section of the sidebar, separated from your curated layout
  by a thin divider; you can reorder them but not file them under a
  regular group.
- **"Add project here" in group context menu.** Right-click a group
  header to open the add-project flow with that group preselected.
- **cwd-aware captions.** Both the sidebar caption (for quick-add
  projects) and tab captions now show `parent/basename` of the focused
  panel's working directory and update live via OSC 7. Manual rename
  pins the name. Long paths truncate from the *left* (`…ents/prod-iofcz`)
  so the basename — the part you actually need — stays visible.
- **Update check on startup.** Pings GitHub Releases at most once per
  day; when a newer version exists, a clickable badge appears in the
  status bar that opens the release page in your system browser.
  Toggle in *Settings → Check for updates on startup* (default on).

### Changed

- Tab title and project caption rendering switched to a shared
  `cwdLabel()` helper, replacing the earlier mix of `../<basename>`
  and bare `<basename>`. Stored project names from older sessions are
  honored as-is until you rename them.

## [1.1.0] — 2026-04-24

### Added

- **Scrollback persistence.** Each panel's terminal buffer is serialized
  on close and replayed on next launch, so you re-enter your previous
  session with history already in place. Buffers live in their own
  `buffers.json` store (separate from `session.json`) — a corrupted or
  oversized buffer file can't take the layout down with it. Each buffer
  is capped at 2 000 000 characters; older scrollback is trimmed from
  the head.
- `Cmd+Q` (and any other window close) now flushes the pending session
  save before the process exits, via `onCloseRequested` +
  `preventDefault`. Nothing is lost to the debounce timer.

### Fixed

- Shell startup no longer wipes the restored scrollback. zsh +
  powerlevel10k's *instant_prompt* emits `\e[2J\e[3J\e[H` about a second
  into boot; during a 3 s grace window right after restore those clear-
  and-home sequences are swallowed, so the shell's first prompt lands
  below the restored history instead of painting over it.
- Session save now drains the xterm write queue before serializing.
  Previously, Cmd+Q immediately after a burst of output could miss the
  last frame of PTY data because `xterm.write` parses asynchronously.
- Restored-buffer injection is no longer destructive — survives React
  StrictMode's double-mount so the xterm the user actually sees is the
  one that receives the saved scrollback.

## [1.0.0] — 2026-04-24

First public release.

### Highlights

- Cross-platform terminal (macOS, Linux, Windows) built with **Tauri 2**,
  **React 19 + TypeScript**, **xterm.js** and a Rust PTY backend.
- Per-project tabs, recursive splits, session restore, themes, command
  palette, global search, broadcast input, drag-and-drop everywhere.

### Projects & groups

- Add folders as named, colored projects. Each project owns its own tab
  group — switching projects restores the last tab you were on.
- Collapsible groups (e.g. *Personal*, *Work*, *CNC*) with drag-and-drop:
  reorder groups, move projects between groups, drop an empty/collapsed
  group header to nest into it (auto-expands after 500 ms).
- Drop a folder from Finder/Nautilus onto the sidebar to add it instantly.
- Per-project snippets: one-click quick commands into the active terminal,
  also searchable from the command palette.
- Project activity dot: sidebar indicates when a background project has
  new terminal output.

### Tabs & splits

- Tabs per active project, activity badge on background tabs, inline
  rename (double-click the title), drag-to-reorder.
- Tab context menu: Rename / Duplicate / Close / Close others / Close to
  the right.
- Recursive splits inside any tab (horizontal + vertical), via
  `Cmd/Ctrl+D` / `Cmd/Ctrl+Shift+D` or per-panel context menu.
- Broadcast input (per-tab toggle): typing fans out to every panel in
  the tab. Useful for multi-server admin.
- Directional focus between panels with `Cmd/Ctrl+Alt+Arrow`.
- A visible `⚡` icon marks tabs with broadcast mode on.

### Terminal

- Copy-on-select + instant paste (via Tauri clipboard plugin — no
  permission prompt).
- `Cmd/Ctrl+F` in-terminal search over scrollback, `Cmd/Ctrl+Shift+F`
  global search across all mounted terminal buffers with jump-to-match.
- `Cmd/Ctrl+K` clear focused terminal, `Cmd/Ctrl+=` / `Cmd/Ctrl+-` /
  `Cmd/Ctrl+0` zoom in / out / reset.
- Clickable URLs — `Cmd/Ctrl+click` opens in the system browser.
- Visual bell: a shell bell lights the tab activity dot on inactive tabs.
- Scrollback size configurable from Settings (default 5000 lines).

### Appearance & theming

- 8 built-in terminal themes: Default, Dracula, Nord, Solarized Dark,
  Tokyo Night, GitHub Dark, iTerm2 Dark Background, Gruvbox Dark.
- App chrome (sidebar, tab bar, status bar) re-tints automatically with
  the active theme's background.
- Configurable terminal font family + size and UI font size.
- Status bar: shell · cwd (with `~` abbreviation) · live git status
  (branch, separate `+` staged / `●` modified / `?` untracked / `⚠`
  conflicts / `↑` ahead / `↓` behind) · `?` for shortcuts · version.

### Session restore

- Tabs, splits (with exact split percentages), per-panel `cwd` and
  custom tab titles are persisted to `session.json` and restored on
  next launch.
- Settings, projects, groups, sidebar width and visibility persist in
  `shellboard.json`.
- Window size / position / maximized state persists via
  `tauri-plugin-window-state` (multi-monitor safe).

### OSC 7 (directory tracking)

- Opt-in toggle in Settings. When on, Shellboard injects a shell-specific
  hook so the app always knows the real working directory:
  - **zsh** — `ZDOTDIR` override with a fake `.zshrc` that sources the
    user's `.zshenv`, `.zprofile` and `.zshrc`, then adds the hook.
  - **bash** — `--rcfile` override that sources `/etc/profile` and the
    user's `.bash_profile` / `.bashrc`, then adds a `PROMPT_COMMAND`.
  - **fish** — `--init-command` with an `--on-variable PWD` function.
  - **nushell** — `--env-config` script installing a PWD `env_change`
    hook (best effort; targets nushell 0.90+).

### Keyboard, command palette, help

- **Command palette** (`Cmd/Ctrl+Shift+P`) — fuzzy-searchable: switch
  project, tab actions, splits, theme switch, toggle sidebar, toggle
  cwd tracking, run snippets, open about / settings / keyboard shortcuts.
- **Shortcut cheat sheet** accessible via the `?` key, the `?` button
  in the status bar, or the command palette.
- `Cmd/Ctrl+B` toggles the sidebar visibility.
- OS-aware modifiers: app shortcuts use `Cmd` on macOS and `Ctrl` on
  Linux/Windows — **never both** — so standard shell bindings
  (`Ctrl+W`, `Ctrl+T`, etc.) still reach the shell on macOS.
- Copy/paste convention matches platform: macOS `Cmd+C/V`, Linux/Windows
  `Ctrl+Shift+C/V`.

### Shell support

- `$SHELL` autodetected; falls back to `/bin/sh` if unset.
- Automatic login-shell mode (`-l`) for known POSIX shells so
  `.bash_profile` / `.zprofile` / `fish` config load with full user PATH
  — even when the app is launched from Finder or a desktop menu.
- `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Shellboard`
  are set explicitly so GUI-launched shells get proper terminfo
  (backspace, arrow keys, colors all behave correctly).
- **Settings → Shell** lets you override the shell binary and its
  arguments for advanced setups (nushell, xonsh, custom flags, …).

### Platform & release

- macOS-style squircle app icon generated from a single source PNG via
  `scripts/make-macos-icon.mjs`.
- `npm run release` one-shot local build script (macOS → `.dmg` + `.app`,
  Linux → `.AppImage` + `.deb` + optional `.rpm`).
- GitHub Actions release workflow (`.github/workflows/release.yml`) that
  on tag push builds for macOS (Apple Silicon + Intel) and Linux and
  creates a draft GitHub Release with the bundles attached.
- Optional Apple code-signing via repository secrets.
- A per-tag CI build workflow (`.github/workflows/build.yml`) verifies
  every platform compiles.

### Developer

- Node version pinned via `.nvmrc` (currently `22`).
- TypeScript strict, React 19 + Vite 7, zustand store, cmdk command
  palette, `@dnd-kit` for drag-and-drop, `react-mosaic-component` for
  splits, xterm.js addons: `fit`, `web-links`, `search`.
- Rust backend uses `portable-pty`, `tokio`, `tauri-plugin-store`,
  `-dialog`, `-opener`, `-clipboard-manager`, `-window-state`.
- Error boundary around the React tree so a crash shows a reload screen
  instead of a blank window.
