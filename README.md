# Shellboard

Cross-platform terminal emulator built with **Tauri 2**, **React 19 + TypeScript**, **xterm.js**, and a Rust PTY backend (`portable-pty`).

A per-project tab & split workspace with session restore, themes, a command palette, global search, broadcast input, and a status bar with live git info.

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Features

- **Projects** — add folders as named, colored projects with drag-and-drop reorder. Each project owns its own tab group.
- **Tabs per project** — `Cmd/Ctrl+T` opens a new tab in the active project; switching projects restores the last tab you were on.
- **Recursive splits** — horizontal / vertical splits inside a tab via `Cmd/Ctrl+D` / `Cmd/Ctrl+Shift+D` or the panel context menu. Each split = own PTY.
- **Session restore** — tabs, splits (with sizes) and cwd per panel persist across restarts.
- **OSC 7 auto-setup** (opt-in) — tracks `cd` in zsh / bash / fish so session restore returns you to the right directory.
- **Themes** — 8 presets (Default, Dracula, Nord, Solarized Dark, Tokyo Night, GitHub Dark, iTerm2 Dark Background, Gruvbox Dark). The app chrome (sidebar, tab bar, status bar) auto-aligns to the theme's background.
- **Terminal search** (`Cmd/Ctrl+F`) — inline search bar above the focused terminal, including scrollback.
- **Global search** (`Cmd/Ctrl+Shift+F`) — fuzzy-searches the buffer of every mounted terminal; result click jumps to the tab and scrolls to the match.
- **Clickable URLs** — Cmd/Ctrl-click opens in the system browser.
- **Clipboard polish** — copy-on-select to system clipboard, instant paste (via Tauri clipboard plugin, no permission prompt).
- **Status bar** — shell · cwd (abbreviated with `~`) · live git status (branch, staged / modified / untracked / conflicts, ahead / behind upstream) · app version.
- **Activity badge** — tabs with background output show a colored dot until opened.
- **Command palette** (`Cmd/Ctrl+Shift+P`) — fuzzy-searchable: switch projects, new / close / rename tab, split, change theme, toggle sidebar, open settings, about, global search.
- **Broadcast input** — type once, every panel in the tab receives it (per-tab toggle).
- **Hide / show sidebar** (`Cmd/Ctrl+B`) — reclaim space when you need it.
- **Settings** dialog (`Cmd/Ctrl+,`) — font family + size (terminal), UI font size, theme, cwd tracking toggle.
- **About dialog** — logo, version, credits.
- **Error boundary** — a React crash shows a reload screen instead of a blank window.

## Prerequisites

- **Node.js** 20.19+ or 22+ (project ships `.nvmrc` pinning 22 — `nvm use` picks it up)
- **Rust** stable toolchain — install via [rustup](https://rustup.rs/)
- **git** on `PATH` — only needed for status bar git indicators; terminal itself works without
- Platform build prerequisites per [Tauri 2 docs](https://tauri.app/start/prerequisites/)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: GTK/WebKit dev packages **plus** `xdg-desktop-portal` for native file dialogs
  - Windows: WebView2 + MSVC build tools

## Install & run

```bash
nvm use          # picks up .nvmrc
npm install
npm run tauri dev
```

First launch compiles the Rust backend — expect a few minutes. Subsequent runs are incremental.

Production build: `npm run tauri build`.

## Release

### Local (current platform only)

```bash
npm run release
```

Wraps `tauri build` and prints where the installable bundle landed. On macOS produces `.app` and `.dmg`; on Linux produces `.AppImage`, `.deb`, and (if `rpmbuild` is present) `.rpm`.

For multi-arch on macOS:

```bash
npm run release -- --target aarch64-apple-darwin   # Apple Silicon
npm run release -- --target x86_64-apple-darwin    # Intel
```

### Cross-building Linux bundles from macOS (via Docker)

Run the Linux build inside a Docker container — no Linux VM required:

```bash
npm run release:linux
```

First invocation builds the image `shellboard-linux-build:latest` from `scripts/docker/Dockerfile.linux` (Ubuntu 24.04 + Rust stable + Node 22 + webkit2gtk dev libs). That takes ~3–5 minutes. Subsequent runs reuse the image.

Cargo and npm caches are persisted across runs in a Docker volume (`shellboard-build-cache`), so incremental rebuilds are fast. Linux artifacts land in a separate `src-tauri/target-linux/` tree so they don't collide with local macOS builds.

**What it builds**: `.deb` and `.rpm` by default. `.AppImage` is intentionally skipped because `linuxdeploy` (which Tauri uses to package AppImages) fails under Rosetta emulation on Apple Silicon in ways that are impractical to debug — it aborts with `std::logic_error: subprocess failed (exit code 2)` and Tauri swallows the subprocess stderr. The GitHub Actions release workflow produces `.AppImage` correctly on its native Linux runner.

To still attempt AppImage locally (e.g. if you've moved to a native Linux host):

```bash
SHELLBOARD_BUNDLES=deb,rpm,appimage npm run release:linux
```

Requirements: Docker (Docker Desktop on macOS works). On Apple Silicon the container runs under `linux/amd64` via Rosetta — slower than native but fully functional for `.deb` / `.rpm` packaging.

**Docker memory**: the image runs with `CARGO_BUILD_JOBS=2` by default so the build fits inside ~4 GB of container RAM. If `rustc` dies with `signal: 9, SIGKILL` on heavy crates (`gtk`, `webkit2gtk-sys`), Docker ran out of memory — either:

- raise Docker Desktop's memory in *Settings → Resources* (6–8 GB recommended), then:
  ```bash
  CARGO_BUILD_JOBS=4 npm run release:linux
  ```
- or keep the defaults and retry; incremental rebuilds only recompile what changed, so OOM-prone crates usually don't have to be recompiled next run.

### Multi-platform via GitHub Actions (recommended for sharing)

Push a `v*` tag and the release workflow builds bundles for macOS (Apple Silicon + Intel) and Linux, then creates a **draft** GitHub Release with those bundles attached.

```bash
# Bump version in package.json, tauri.conf.json, and Cargo.toml
git commit -am "release: v0.1.0"
git tag v0.1.0
git push origin main --tags
```

Wait for the workflow to finish (~10 minutes), go to **Releases** on GitHub, review the draft, write release notes, and click **Publish**.

### Code signing (optional)

Without signing, macOS Gatekeeper refuses to open the app on first launch. Users can either right-click → **Open**, or strip the quarantine:

```sh
xattr -cr /Applications/Shellboard.app
```

If you have an Apple Developer ID, set these repository secrets to sign + notarize automatically in CI: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

### Regenerating the app icon

If you replace `logo.png` in the repo root:

```bash
npm run tauri icon logo.png
```

…requires a square source. For the macOS-style squircle wrap we ship a one-off script:

```bash
node scripts/make-macos-icon.mjs   # writes logo-macos.png
npm run tauri icon logo-macos.png
cp logo-macos.png public/logo.png  # About dialog uses this
```

A `cargo:rerun-if-changed=icons` directive in `src-tauri/build.rs` ensures the bundled binary picks up fresh icons on next `tauri dev`.

## Keyboard shortcuts

`Cmd` on macOS, `Ctrl` elsewhere.

| Shortcut                      | Action                            |
|-------------------------------|-----------------------------------|
| `Cmd/Ctrl+T`                  | New tab in active project         |
| `Cmd/Ctrl+W`                  | Close active tab                  |
| `Cmd/Ctrl+Shift+W`            | Close active split panel          |
| `Cmd/Ctrl+D`                  | Split vertical (new panel right)  |
| `Cmd/Ctrl+Shift+D`            | Split horizontal (new panel down) |
| `Cmd/Ctrl+Tab` / `Shift+Tab`  | Next / previous tab in project    |
| `Cmd+Shift+]` / `Cmd+Shift+[` | Next / previous tab (macOS alias) |
| `Cmd/Ctrl+1..9`               | Jump to tab N (within project)    |
| `Cmd/Ctrl+Alt+Arrows`         | Move focus between split panels   |
| `Cmd/Ctrl+B`                  | Hide / show sidebar               |
| `Cmd/Ctrl+F`                  | Find in focused terminal          |
| `Cmd/Ctrl+Shift+F`            | Global search across terminals    |
| `Cmd/Ctrl+,`                  | Open settings                     |
| `Cmd/Ctrl+Shift+P`            | Open command palette              |

**In terminal:**

| Shortcut                    | Action                           |
|-----------------------------|----------------------------------|
| Drag / double-click text    | Select (auto-copies to clipboard)|
| `Cmd+C` (macOS)             | Copy selection (manual)          |
| `Cmd+V` (macOS)             | Paste                            |
| `Ctrl+Shift+C` (Linux/Win)  | Copy                             |
| `Ctrl+Shift+V` (Linux/Win)  | Paste                            |
| `Cmd/Ctrl+click` on URL     | Open link in browser             |

**Context menus:**

- Right-click **tab split panel** → Split Left / Right / Up / Down
- Right-click **project row** → Rename / Change color / Open in file explorer / Remove
- Double-click **tab title** → Inline rename

## Status bar

Bottom row of the app, always visible. When a terminal is active:

```
zsh · ~/Projects/shellboard · ⎇ main +3 ●2 ?1 ↑4              v0.1.0
```

Git indicators (each hidden when 0, coloured for quick scanning):

| Symbol | Meaning              | Color  |
|--------|----------------------|--------|
| `⎇`    | Branch name          | blue   |
| `+N`   | Staged changes       | green  |
| `●N`   | Modified (unstaged)  | orange |
| `?N`   | Untracked files      | grey   |
| `⚠N`   | Merge conflicts      | red    |
| `↑N`   | Commits ahead upstream | green |
| `↓N`   | Commits behind upstream | red  |

Hover any segment for a detailed tooltip. Git status polls every 5 seconds so commits / stages reflect without manual refresh, plus immediately on cwd change.

The app version (from `tauri.conf.json`) appears on the right, auto-pulled via `@tauri-apps/api/app`.

## Architecture

### Frontend (React 19 + Vite)

Single zustand store (`src/store/appStore.ts`). Per-terminal xterm instances live in `<Terminal>` components which stay mounted for the lifetime of their PTY — switching tabs toggles `visibility: hidden`, so xterm scrollback, focus and PTY stream survive. Layout changes (tabs, splits) are compositor-only: no flicker.

```
<App>
├── <Sidebar>                  project list, resizable, DnD reorder
│   └── <ProjectList>
│       └── <ProjectRow>        inline rename / color picker / context menu
├── <main>
│   ├── <TabBar>                per-project tabs, activity badge, broadcast icon
│   ├── <TerminalHost>          all tabs mounted; only active is visible
│   │   └── <MosaicTab>         react-mosaic-component split layout
│   │       └── <Terminal>      xterm + search, web-links, OSC 7, broadcast
│   └── <StatusBar>             shell · cwd · git status · version
├── <SettingsDialog>            font + theme + cwd tracking
├── <CommandPalette>            cmdk fuzzy searchable actions
├── <GlobalSearch>              cross-terminal buffer search
├── <AboutDialog>               logo, version
└── <AddProjectFlow>            native folder picker → modal
```

PTY lifecycle is owned by the store, not by components:

- `addTab` / `splitPanel` → Rust `spawn_pty` → new session
- `closeTab` / `closeActivePanel` / `handleTerminalExit` → Rust `kill_pty`
- `<Terminal>` attaches xterm, registers it in `terminalRegistry` (for global search), wires events/invokes.

### Backend (`src-tauri/src/pty.rs`)

- `PtyManager` — `Mutex<HashMap<String, PtySession>>` as Tauri managed state.
- `PtySession` — master PTY (for `resize`), writer (`Box<dyn Write + Send>`), child (`Box<dyn Child + Send + Sync>`).
- `spawn_pty` opens a PTY via `native_pty_system()`, spawns the default shell with optional OSC 7 rc injection, returns a UUID session id.
- Reader loop runs on `tokio::task::spawn_blocking`; emits `pty://{id}/data` events with UTF-8 chunks. On EOF it emits `pty://{id}/exit` so the frontend tears down the panel.
- Git helpers (`git_branch`, `git_status`) shell out to the system `git` binary and parse `--porcelain=v2` output.

### Default shell

- **Unix**: `$SHELL` (fallback `/bin/sh`). cwd defaults to project path or `$HOME` when unknown.
- **Windows**: `pwsh.exe` → `powershell.exe` → `cmd.exe` (first on `PATH`). `native_pty_system()` picks ConPTY automatically.

### OSC 7 auto-setup (opt-in)

When `Track current directory` is enabled in Settings, Shellboard writes a temporary shell init file in the OS temp dir and wires it into the spawned shell:

- **zsh** — custom `ZDOTDIR` with a `.zshrc` that sources the user's, then hooks `chpwd_functions`.
- **bash** — `--rcfile` pointing at a generated rc that sources `~/.bashrc`, then prepends an OSC 7 emitter into `PROMPT_COMMAND`.
- **fish** — `--init-command` with a `--on-variable PWD` function.

Only affects newly-spawned terminals after the toggle is on. Other shells (`dash`, `tcsh`, etc.) fall through without injection.

### Tauri commands

| Command         | Args                                                                    | Returns                        |
|-----------------|-------------------------------------------------------------------------|--------------------------------|
| `spawn_pty`     | `cols: u16, rows: u16, cwd?: String, autoCwdTracking?: bool`            | `String` (session id)          |
| `write_to_pty`  | `id: String, data: String`                                              | `()`                           |
| `resize_pty`    | `id: String, cols: u16, rows: u16`                                      | `()`                           |
| `kill_pty`      | `id: String`                                                            | `()`                           |
| `home_dir`      | —                                                                       | `String`                       |
| `git_branch`    | `path: String`                                                          | `Option<String>`               |
| `git_status`    | `path: String`                                                          | `Option<GitStatus>` (see below)|

`GitStatus` shape:

```ts
{
  branch: string | null;
  ahead: number; behind: number;
  staged: number; modified: number; untracked: number; conflicts: number;
}
```

Events:

- `pty://{id}/data` — `{ data: string }` (UTF-8 lossy-decoded chunks)
- `pty://{id}/exit` — empty payload when the shell ends

### Persistence

Two JSON files in the app config dir (macOS: `~/Library/Application Support/cz.petrhlozek.shellboard/`).

`shellboard.json` — user-level config:

```json
{
  "projects": [{ "id": "...", "name": "...", "path": "...", "color": "#...", "createdAt": 0 }],
  "sidebarWidth": 240,
  "sidebarVisible": true,
  "settings": {
    "terminalFontFamily": "...",
    "terminalFontSize": 13,
    "uiFontSize": 12,
    "terminalTheme": "default",
    "autoCwdTracking": false
  }
}
```

`session.json` — per-run volatile state (saved debounced 500 ms after any change):

```json
{
  "version": 1,
  "activeProjectId": "...",
  "lastActiveTabByProject": { "projectId": "tabId" },
  "tabsByProject": {
    "projectId": [
      {
        "id": "tab-uuid",
        "title": "project 1",
        "customTitle": false,
        "layout": {
          "type": "split",
          "direction": "row",
          "splitPercentage": 50,
          "first": { "type": "leaf", "cwd": "/path" },
          "second": { "type": "leaf", "cwd": "/other" }
        }
      }
    ]
  }
}
```

## Project layout

```
shellboard/
├── .nvmrc
├── .github/workflows/build.yml     # matrix build macOS / Linux / Windows
├── scripts/
│   └── make-macos-icon.mjs         # wrap any logo in a macOS squircle
├── logo.png                        # source artwork
├── public/logo.png                 # served by Vite for the About dialog
├── src/                            # React frontend
│   ├── App.tsx                     # layout, shortcuts, startup hydrate, theme vars
│   ├── main.tsx                    # ErrorBoundary
│   ├── store/appStore.ts           # zustand: tabs, projects, settings, session
│   ├── utils/
│   │   ├── mosaic.ts               # tree helpers for splits
│   │   ├── persistence.ts          # typed wrappers over plugin-store
│   │   ├── sessionSerialize.ts     # mosaic ↔ PersistedLayout
│   │   ├── themes.ts               # theme presets (8)
│   │   └── terminalRegistry.ts     # module-level xterm registry (for global search)
│   └── components/
│       ├── Terminal.tsx            # xterm + search/web-links/OSC 7/broadcast/clipboard
│       ├── MosaicTab.tsx           # split layout per tab
│       ├── TerminalHost.tsx        # hosts all tabs, visibility-toggled
│       ├── TabBar.tsx              # tabs, inline rename, activity/broadcast icons
│       ├── Sidebar.tsx             # resizable project panel
│       ├── ProjectList.tsx         # DnD, context menu, inline rename
│       ├── ProjectRow.tsx
│       ├── AddProjectFlow.tsx      # folder picker + metadata modal
│       ├── ColorPicker.tsx         # preset palette + custom hex
│       ├── SettingsDialog.tsx      # font + theme + cwd tracking
│       ├── CommandPalette.tsx      # cmdk + fuzzy search
│       ├── GlobalSearch.tsx        # cross-terminal search modal
│       ├── StatusBar.tsx           # shell · cwd · git · version
│       ├── AboutDialog.tsx         # logo + version
│       ├── Modal.tsx               # generic backdrop
│       ├── ContextMenu.tsx         # floating menu (tabs, panels, projects)
│       └── ErrorBoundary.tsx
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs                    # cargo:rerun-if-changed=icons + tauri_build::build()
    ├── tauri.conf.json
    ├── capabilities/default.json   # core/event/store/dialog/opener/clipboard-manager
    ├── icons/                      # generated per-platform bundle icons
    └── src/
        ├── main.rs
        ├── lib.rs                  # plugins + manage(PtyManager) + commands
        └── pty.rs                  # PtyManager + PTY commands + OSC 7 wiring + git helpers
```

## Known limitations

- Shell output is decoded with `String::from_utf8_lossy`; non-UTF-8 byte sequences become replacement chars. A future phase may switch to a binary-safe transport.
- On Windows the OSC 7 auto-setup is a no-op; ConPTY exposes cwd through a different channel that isn't wired up yet.
- A restored tab lands with focus on the first panel regardless of which panel was focused at save time.
- Git status polls every 5 s; a commit made between polls appears with a slight delay.
- No in-app updater yet; install a new release manually.
