# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
nvm use                  # picks up .nvmrc (Node 22)
npm install
npm run tauri dev        # run the app (first launch compiles Rust ~ minutes)
npm run build            # tsc + vite build (frontend only — type-check gate)
npm run tauri build      # production bundle for the current platform
npm run release          # wraps tauri build, prints artifact paths (scripts/release.sh)
npm run release:linux    # cross-build .deb/.rpm from macOS via Docker (scripts/release-linux.sh)
```

There is no test runner and no linter configured — `tsc` (run as part of `npm run build`) is the only static check. Don't add `npm test` or eslint commands without the user asking.

Releases ship via tagged `v*` push triggering `.github/workflows/release.yml` (matrix: macOS arm64/x64 + Linux). The version lives in three files that must stay in sync: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.

## Architecture

Tauri 2 desktop app: React 19 + TypeScript frontend talking to a Rust backend that owns PTY processes via `portable-pty`. The frontend lives in `src/`, the Rust side in `src-tauri/src/`.

### State ownership — read this before changing anything

A single zustand store (`src/store/appStore.ts`) is the source of truth for projects, project groups, tabs, mosaic layouts, terminal sessions, settings, and sidebar state. **PTY lifecycle belongs to the store, not to components** — `addTab` / `splitPanel` / `closeTab` / `closeActivePanel` / `handleTerminalExit` are the only places that call `spawn_pty` / `kill_pty`. `<Terminal>` components attach xterm to an existing session, register themselves in `terminalRegistry` (a module-level map used by global search and broadcast input), and wire IPC events — they don't create or destroy sessions.

The store hydrates once at startup from `loadPersisted` + `loadSession` + `loadBuffers`. After hydration, `enableSessionAutosave()` wires a debounced (500 ms) writer that re-serializes session state on every store change. When a session is restored from disk, autosave is **deferred 3 s** so shell-startup output bursts don't immediately overwrite the freshly restored buffers. `flushSessionSave()` is called from `onCloseRequested` so Cmd+Q doesn't lose the in-flight debounced save.

### Persistence layout

Three JSON files in the platform config dir (macOS: `~/Library/Application Support/cz.petrhlozek.shellboard/`), all written via `@tauri-apps/plugin-store`:

- `shellboard.json` — projects, groups, sidebar width/visibility, settings (user-level config)
- `session.json` — `activeProjectId`, `lastActiveTabByProject`, `tabsByProject` with serialized mosaic layouts (volatile, debounced)
- `buffers.json` — xterm scrollback snapshots, isolated so a corrupted/large buffer file can't take the layout down with it

`PersistenceKeys` in `src/utils/persistence.ts` is the registry of config-store keys. Schema migrations happen inside `restoreSession` / `hydrate` in the store — be defensive about missing optional fields (e.g. `groupId`, `snippets`, `autoCwdName` on `Project`).

### Mosaic / split layout

Tabs use `react-mosaic-component`. The store stores a `MosaicNode<string>` whose leaves are PTY session IDs. Tree manipulation utilities live in `src/utils/mosaic.ts` (`replaceLeaf`, `removeLeaf`, `findNeighborLeaf`, `findSiblingLeaf`, `firstLeafOf`, `collectLeaves`). Use these — don't walk the tree inline. `src/utils/sessionSerialize.ts` converts between `MosaicNode<string>` (live) and `PersistedLayout` (cwd-tagged tree on disk); session restore rebuilds the mosaic by re-spawning PTYs with the persisted cwd per leaf.

### TerminalHost visibility model

`<TerminalHost>` mounts **every** tab simultaneously and toggles `visibility: hidden` on inactive ones. This is intentional: it preserves xterm scrollback, focus, the live PTY stream, and avoids reflow flicker when switching tabs. Don't conditionally render terminals.

### Backend (`src-tauri/src/pty.rs`)

`PtyManager` is a `Mutex<HashMap<String, PtySession>>` registered as Tauri managed state. `spawn_pty` opens a PTY via `native_pty_system()` (ConPTY on Windows, openpty on Unix), spawns the user's shell, and returns a UUID. The reader loop runs on `tokio::task::spawn_blocking` and emits `pty://{id}/data` events with `String::from_utf8_lossy`-decoded chunks; on EOF it emits `pty://{id}/exit` so the frontend tears down the panel.

OSC 7 cwd tracking (when `autoCwdTracking` is on) writes a shell-specific init file into the OS temp dir and wires it via `ZDOTDIR` (zsh) / `--rcfile` (bash) / `--init-command` (fish). It only affects newly-spawned shells; existing sessions are untouched. Other shells fall through without injection. Windows is a no-op.

`git_branch` / `git_status` shell out to the system `git` binary and parse `--porcelain=v2`. They're polled from the frontend every 5 s and on cwd change.

### Tauri command surface

`spawn_pty(cols, rows, cwd?, autoCwdTracking?) → String`, `write_to_pty(id, data)`, `resize_pty(id, cols, rows)`, `kill_pty(id)`, `home_dir() → String`, `git_branch(path) → Option<String>`, `git_status(path) → Option<GitStatus>`. Events: `pty://{id}/data` and `pty://{id}/exit`. Capabilities are declared in `src-tauri/capabilities/default.json`.

### Keyboard shortcut convention

`App.tsx` uses Cmd on macOS and Ctrl on Linux/Windows — **not both**. Plain Ctrl is left to the shell (Ctrl+W = delete word, Ctrl+T = transpose, etc.) on macOS; on Linux/Windows we accept the rare conflict because there's no other modifier. Don't bind plain Ctrl on macOS, and check `IS_MAC` / use the `mod` helper when adding shortcuts.

## Cross-platform notes

- `npm run release:linux` runs Docker with `linux/amd64` (under Rosetta on Apple Silicon). It intentionally builds **only** `.deb` / `.rpm` because `linuxdeploy` (used for AppImage) crashes under Rosetta. CI builds AppImage on native Linux.
- Docker Linux build defaults to `CARGO_BUILD_JOBS=2` to fit ~4 GB of container RAM. If `rustc` gets SIGKILL'd, raise Docker memory or accept the retry.
- macOS unsigned builds are gatekept; users either right-click → Open or run `xattr -cr /Applications/Shellboard.app`. CI uses the `APPLE_*` secrets to sign + notarize when present.
- Replacing `logo.png` requires running `npm run tauri icon logo.png` (or the `scripts/make-macos-icon.mjs` squircle wrapper for macOS). `src-tauri/build.rs` has a `cargo:rerun-if-changed=icons` directive so a fresh icon set is picked up on the next `tauri dev`.

## Things to watch out for

- `customTitle` on `Tab` and `autoCwdName` on `Project` exist to suppress automatic retitling — preserve their semantics if you touch tab/project rename code.
- Shell output is decoded with `String::from_utf8_lossy`, so non-UTF-8 byte sequences become replacement chars. Don't assume bytes round-trip.
- Update checks (`src/utils/updateCheck.ts`) fire 5 s after launch, only when the user opted in via settings. Result lands in the store; don't surface it elsewhere.
