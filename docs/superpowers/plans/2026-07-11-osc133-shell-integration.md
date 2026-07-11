# OSC 133 Shell Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shell-integration marks (OSC 133 A/C/D) power prompt jumping (Cmd+↑/↓), a red failed-command tab dot, and OS notifications when long commands finish on background tabs.

**Architecture:** The Rust side only injects shell hooks (same init files and settings switch as the existing OSC 7 cwd tracking). Marks flow through the PTY stream; the frontend parses them with `xterm.parser.registerOscHandler(133)`, stores prompt positions as xterm markers in a module registry, and routes C/D through two new store actions.

**Tech Stack:** Rust (tauri 2, portable-pty), React 19 + TS, xterm 6 marker API, `@tauri-apps/plugin-notification` 2.

Spec: `docs/superpowers/specs/2026-07-11-osc133-shell-integration-design.md`

## Global Constraints

- No `B` mark — only `A`, `C`, `D;<exit>`.
- Settings key `autoCwdTracking` keeps its name on disk; only UI copy changes.
- Notification threshold: `runtime >= 5000 ms`, and (owning tab inactive OR `!document.hasFocus()`), and setting `notifyLongCommands` on (default `true`).
- Prompt-mark cap per terminal: 200.
- Shell hook injection is best-effort — a failure must never break shell startup (existing pattern).
- Verification gates: `npm run build` (tsc) and `cargo check` + `cargo test` in `src-tauri/`. No test runner exists for TS — do not add one.
- Commits authored `--author="Petr Hlozek <petr@petrhlozek.cz>"`, message ends with the Claude Co-Authored-By trailer.

---

### Task 1: Shell hooks emit OSC 133 (Rust)

**Files:**
- Modify: `src-tauri/src/pty.rs` — the `osc7_wiring` function (~line 131-235) and its call site comment

**Interfaces:**
- Produces: shells spawned with the existing "Track current directory" setting ON now emit `ESC ] 133;A ESC \` before each prompt, `…;C…` when a command starts, `…;D;<code>…` when it ends. No Rust API changes.

- [ ] **Step 1: Extend the zsh init body.** In the `"zsh"` match arm, replace the `body` literal with:

```rust
            let body = r#"# Shellboard shell integration (OSC 7 cwd + OSC 133 marks)
# ZDOTDIR redirects zsh away from $HOME for .z*-style config files, so
# source user's files manually. /etc/zprofile + /etc/zshrc still run
# automatically in login mode (PATH on macOS comes from there).
[ -f "$HOME/.zshenv" ] && ZDOTDIR="$HOME" source "$HOME/.zshenv"
[ -f "$HOME/.zprofile" ] && ZDOTDIR="$HOME" source "$HOME/.zprofile"
[ -f "$HOME/.zshrc" ] && ZDOTDIR="$HOME" source "$HOME/.zshrc"
_shellboard_osc7() { printf '\e]7;file://%s%s\e\\' "${HOST:-$HOSTNAME}" "$PWD" }
typeset -ga chpwd_functions
chpwd_functions+=(_shellboard_osc7)
_shellboard_osc7
# OSC 133: D;<exit> after a command (guarded so the first prompt gets no D),
# A before each prompt, C when a command starts.
_shellboard_osc133_precmd() {
  local code=$?
  if [ -n "${_shellboard_cmd_ran:-}" ]; then
    printf '\e]133;D;%s\e\\' "$code"
  fi
  _shellboard_cmd_ran=""
  printf '\e]133;A\e\\'
}
_shellboard_osc133_preexec() {
  _shellboard_cmd_ran=1
  printf '\e]133;C\e\\'
}
typeset -ga precmd_functions preexec_functions
precmd_functions+=(_shellboard_osc133_precmd)
preexec_functions+=(_shellboard_osc133_preexec)
"#;
```

- [ ] **Step 2: Extend the bash init body.** In the `"bash"` match arm, replace the `body` literal with:

```rust
            let body = r#"# Shellboard shell integration (OSC 7 cwd + OSC 133 marks)
# --rcfile forces bash into non-login mode, so source the profile files
# manually so PATH additions from ~/.bash_profile still apply.
[ -f "/etc/profile" ] && source "/etc/profile"
if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then source "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then source "$HOME/.profile"
fi
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
_shellboard_osc7() { printf '\e]7;file://%s%s\e\\' "${HOSTNAME}" "$PWD"; }
case "$PROMPT_COMMAND" in
    *_shellboard_osc7*) ;;
    *) PROMPT_COMMAND="_shellboard_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
_shellboard_osc7
# OSC 133 prompt marks. The prompt handler must run FIRST in PROMPT_COMMAND
# so `$?` is still the user command's exit code — prepending it after the
# OSC 7 prepend above puts it at the front.
_shellboard_osc133_prompt() {
  local code=$?
  if [ -n "${_shellboard_cmd_ran:-}" ]; then
    printf '\e]133;D;%s\e\\' "$code"
  fi
  _shellboard_cmd_ran=""
  printf '\e]133;A\e\\'
}
case "$PROMPT_COMMAND" in
    *_shellboard_osc133_prompt*) ;;
    *) PROMPT_COMMAND="_shellboard_osc133_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
# C (command start) via DEBUG trap — best-effort: installed only when the
# user has no DEBUG trap of their own. Skips commands that are part of
# PROMPT_COMMAND itself.
_shellboard_osc133_preexec() {
  [ -n "${_shellboard_cmd_ran:-}" ] && return 0
  case ";$PROMPT_COMMAND;" in
    *";$BASH_COMMAND;"*) return 0 ;;
  esac
  _shellboard_cmd_ran=1
  printf '\e]133;C\e\\'
}
if [ -z "$(trap -p DEBUG)" ]; then
  trap '_shellboard_osc133_preexec' DEBUG
fi
"#;
```

- [ ] **Step 3: Extend fish.** In the `"fish"` match arm, replace the single `--init-command` pair with two (fish accepts repeated `--init-command`):

```rust
        "fish" => {
            // Fish: OSC 7 + OSC 133 via --init-command (repeatable flag).
            // fish_postexec fires only after a real command, so D needs no
            // first-prompt guard.
            let osc7 = "function _shellboard_osc7 --on-variable PWD; printf '\\e]7;file://%s%s\\e\\\\' $hostname $PWD; end; _shellboard_osc7";
            let osc133 = "function _shellboard_osc133_prompt --on-event fish_prompt; printf '\\e]133;A\\e\\\\'; end; function _shellboard_osc133_preexec --on-event fish_preexec; printf '\\e]133;C\\e\\\\'; end; function _shellboard_osc133_postexec --on-event fish_postexec; printf '\\e]133;D;%s\\e\\\\' $status; end";
            (
                vec![
                    "--init-command".into(),
                    osc7.into(),
                    "--init-command".into(),
                    osc133.into(),
                ],
                Vec::new(),
            )
        }
```

- [ ] **Step 4: Extend nushell.** In the `"nu" | "nushell"` match arm, append to the `body` literal (after the existing PWD hook block, before the closing `"#;`):

```rust
# OSC 133 marks — same best-effort caveat as above (syntax targets 0.90+).
$env.config.hooks.pre_prompt = ($env.config.hooks.pre_prompt? | default []) ++ [{||
    if ($env.SHELLBOARD_CMD_RAN? | default "") == "1" {
        print -n $"(char esc)]133;D;($env.LAST_EXIT_CODE)(char esc)\\"
    }
    $env.SHELLBOARD_CMD_RAN = "0"
    print -n $"(char esc)]133;A(char esc)\\"
}]
$env.config.hooks.pre_execution = ($env.config.hooks.pre_execution? | default []) ++ [{||
    $env.SHELLBOARD_CMD_RAN = "1"
    print -n $"(char esc)]133;C(char esc)\\"
}]
```

- [ ] **Step 5: Update the function doc comment.** `osc7_wiring`'s doc comment starts "When auto cwd tracking is on…" — reword the first line to: `/// When shell integration is on, write a shell-specific init file into the` and mention it wires both OSC 7 (cwd) and OSC 133 (prompt marks). Do NOT rename the function (callers unchanged, keeps the diff small).

- [ ] **Step 6: Add string-level unit tests** next to the existing `tests` module in `pty.rs`:

```rust
    #[cfg(not(windows))]
    #[test]
    fn shell_integration_bodies_emit_osc133() {
        // The init files are opaque strings — assert the load-bearing marks
        // and guards are present so a refactor can't silently drop them.
        let (_, envs) = super::osc7_wiring("/bin/zsh");
        assert!(!envs.is_empty(), "zsh should wire ZDOTDIR");
        let zshrc = std::env::temp_dir()
            .join("shellboard-shell-init")
            .join(".zshrc");
        let body = std::fs::read_to_string(zshrc).unwrap();
        assert!(body.contains("133;A"));
        assert!(body.contains("133;C"));
        assert!(body.contains("133;D"));
        assert!(body.contains("_shellboard_cmd_ran"));

        let (args, _) = super::osc7_wiring("/usr/bin/fish");
        let joined = args.join(" ");
        assert!(joined.contains("133;A") && joined.contains("133;D"));
    }
```

- [ ] **Step 7: Verify.** Run: `cd src-tauri && cargo check && cargo test`. Expected: all tests pass including the new one.

- [ ] **Step 8: Commit.**

```bash
git add src-tauri/src/pty.rs
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(shell): emit OSC 133 prompt marks from injected shell hooks"
```

---

### Task 2: Prompt-mark registry + OSC 133 handler (frontend)

**Files:**
- Create: `src/utils/promptMarks.ts`
- Modify: `src/components/Terminal.tsx` (next to the OSC 7 handler, ~line 210; cleanup ~where `unregisterTerminal` is called)
- Modify: `src/store/appStore.ts` (TerminalSession type + two actions)

**Interfaces:**
- Produces: `addPromptMark(terminalId, marker)`, `clearPromptMarks(terminalId)`, `nearestPromptLine(terminalId, fromLine, dir): number | null` in `src/utils/promptMarks.ts`; store actions `handleCommandStart(terminalId: string): void` and `handleCommandEnd(terminalId: string, exitCode: number): void`; `TerminalSession` fields `lastExitCode?: number`, `commandStartedAt?: number`.
- Consumes: Task 1's marks arriving in the PTY stream.

- [ ] **Step 1: Create `src/utils/promptMarks.ts`:**

```ts
import type { IMarker } from "@xterm/xterm";

/** Prompt positions (OSC 133;A) per terminal, as xterm markers — they track
 * their line across scrollback trimming and reflow. Session-only; marks are
 * not persisted, so jumping works from the first prompt after a restore. */
const MAX_MARKS = 200;

const marks = new Map<string, IMarker[]>();

export function addPromptMark(terminalId: string, marker: IMarker): void {
  let list = marks.get(terminalId);
  if (!list) {
    list = [];
    marks.set(terminalId, list);
  }
  list.push(marker);
  while (list.length > MAX_MARKS) list.shift()?.dispose();
}

export function clearPromptMarks(terminalId: string): void {
  const list = marks.get(terminalId);
  if (list) for (const m of list) m.dispose();
  marks.delete(terminalId);
}

/** Buffer line of the nearest prompt strictly above (dir -1) or below
 * (dir 1) `fromLine`, or null when there is none. */
export function nearestPromptLine(
  terminalId: string,
  fromLine: number,
  dir: -1 | 1,
): number | null {
  const list = marks.get(terminalId);
  if (!list) return null;
  const lines = list.filter((m) => !m.isDisposed).map((m) => m.line);
  if (dir === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] < fromLine) return lines[i];
    }
  } else {
    for (const line of lines) {
      if (line > fromLine) return line;
    }
  }
  return null;
}
```

- [ ] **Step 2: Store fields + actions.** In `src/store/appStore.ts`:

`TerminalSession` becomes:

```ts
export type TerminalSession = {
  id: string;
  cwd: string;
  /** Exit code of the most recently finished command (OSC 133;D). */
  lastExitCode?: number;
  /** Set while a command is running (OSC 133;C → D). Drives the
   * long-command notification threshold. */
  commandStartedAt?: number;
};
```

Add to the `AppState` type (near `updateTerminalCwd`):

```ts
  handleCommandStart: (terminalId: string) => void;
  handleCommandEnd: (terminalId: string, exitCode: number) => void;
```

Add implementations next to `updateTerminalCwd` (notification wiring comes in Task 5 — for now only state):

```ts
  handleCommandStart: (terminalId) =>
    set((state) => {
      const current = state.terminals[terminalId];
      if (!current) return state;
      return {
        terminals: {
          ...state.terminals,
          [terminalId]: { ...current, commandStartedAt: Date.now() },
        },
      };
    }),

  handleCommandEnd: (terminalId, exitCode) => {
    const current = get().terminals[terminalId];
    if (!current) return;
    set((state) => ({
      terminals: {
        ...state.terminals,
        [terminalId]: {
          ...state.terminals[terminalId],
          lastExitCode: exitCode,
          commandStartedAt: undefined,
        },
      },
    }));
  },
```

- [ ] **Step 3: OSC 133 handler in `Terminal.tsx`.** Directly below the existing OSC 7 `disposables.push(...)` block add:

```ts
    // OSC 133 shell-integration marks: A = prompt start (jump anchor),
    // C = command started, D;<code> = command finished. Emitted by the
    // hooks pty.rs injects when shell integration is on.
    disposables.push(
      xterm.parser.registerOscHandler(133, (data) => {
        const kind = data[0];
        if (kind === "A") {
          const marker = xterm.registerMarker(0);
          if (marker) addPromptMark(terminalId, marker);
        } else if (kind === "C") {
          useAppStore.getState().handleCommandStart(terminalId);
        } else if (kind === "D") {
          const code = parseInt(data.slice(2), 10);
          useAppStore
            .getState()
            .handleCommandEnd(terminalId, Number.isFinite(code) ? code : 0);
        }
        return true;
      }),
    );
```

Imports: add `addPromptMark, clearPromptMarks` from `"../utils/promptMarks"`.

- [ ] **Step 4: Cleanup.** In the same effect's cleanup (where `unregisterTerminal(terminalId)` runs), add `clearPromptMarks(terminalId);` on the adjacent line.

- [ ] **Step 5: Verify.** Run: `npm run build`. Expected: clean tsc + vite build.

- [ ] **Step 6: Commit.**

```bash
git add src/utils/promptMarks.ts src/components/Terminal.tsx src/store/appStore.ts
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(terminal): parse OSC 133 marks into prompt markers and command state"
```

---

### Task 3: Prompt jumping (Cmd+↑ / Cmd+↓)

**Files:**
- Modify: `src/shortcuts/registry.ts` (Terminal category, after `search.global`)
- Modify: `src/shortcuts/actions.ts` (handlers + helper)
- Modify: `src-tauri/src/lib.rs` (menu accelerator maps ~lines 42-96 + Terminal submenu ~line 180)

**Interfaces:**
- Consumes: `nearestPromptLine` (Task 2), `getTerminal` from `src/utils/terminalRegistry.ts`.
- Produces: rebindable actions `prompt.prev` / `prompt.next`; menu ids `menu.prompt.prev` / `menu.prompt.next`.

- [ ] **Step 1: Registry entries.** In `SHORTCUT_ACTIONS` (Terminal section, after `search.global`):

```ts
  {
    id: "prompt.prev",
    category: "Terminal",
    label: "Previous prompt",
    defaultBinding: primary({ key: "ArrowUp" }),
  },
  {
    id: "prompt.next",
    category: "Terminal",
    label: "Next prompt",
    defaultBinding: primary({ key: "ArrowDown" }),
  },
```

- [ ] **Step 2: Handlers.** In `src/shortcuts/actions.ts` add imports `import { getTerminal } from "../utils/terminalRegistry";` and `import { nearestPromptLine } from "../utils/promptMarks";`, a helper below `activeAnchor()`:

```ts
// Scroll the focused panel to the nearest OSC 133 prompt mark above/below
// the current viewport top. No-op when shell integration is off or the
// shell hasn't emitted marks yet.
function jumpPrompt(dir: -1 | 1): void {
  const leafId = activeAnchor();
  if (!leafId) return;
  const xterm = getTerminal(leafId);
  if (!xterm) return;
  const line = nearestPromptLine(leafId, xterm.buffer.active.viewportY, dir);
  if (line !== null) xterm.scrollToLine(line);
}
```

and in `createActionHandlers` (Terminal section):

```ts
    "prompt.prev": () => jumpPrompt(-1),
    "prompt.next": () => jumpPrompt(1),
```

- [ ] **Step 3: Menu.** In `src-tauri/src/lib.rs`: add to the macOS accelerator map `"menu.prompt.prev" => "CmdOrCtrl+Up", "menu.prompt.next" => "CmdOrCtrl+Down",` and to the Linux/Windows text map `"menu.prompt.prev" => "Ctrl+↑", "menu.prompt.next" => "Ctrl+↓",`. In the Terminal submenu, after the `menu.apps.running` item block, add:

```rust
        .separator()
        .item(&shortcut_item(h, "menu.prompt.prev", "Previous Prompt", shortcuts)?)
        .item(&shortcut_item(h, "menu.prompt.next", "Next Prompt", shortcuts)?)
```

(Match the exact builder-chain style of the surrounding items; place before `.build()`.)

- [ ] **Step 4: Verify.** Run: `npm run build` and `cd src-tauri && cargo check`. Expected: both clean. The new actions appear automatically in Settings → Shortcuts and the `?` cheat sheet (both render from `SHORTCUT_ACTIONS`).

- [ ] **Step 5: Commit.**

```bash
git add src/shortcuts/registry.ts src/shortcuts/actions.ts src-tauri/src/lib.rs
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(shortcuts): jump between prompts with Cmd+Up/Down"
```

---

### Task 4: Failed-command tab dot

**Files:**
- Modify: `src/store/appStore.ts` (`Tab` type, tab constructors, `setActiveTab`, `handleCommandEnd`)
- Modify: `src/components/TabBar.tsx` (dot markup ~line 298)
- Modify: `src/components/TabBar.css` (`.tab__activity` block ~line 52)

**Interfaces:**
- Consumes: `handleCommandEnd` (Task 2).
- Produces: `Tab.hasFailed: boolean` (session-only, like `hasUnread`).

- [ ] **Step 1: `Tab` type.** Add below `hasUnread`:

```ts
  /** Session-only: the most recent command in this tab finished with a
   * nonzero exit code while the tab was inactive. Cleared on activation. */
  hasFailed: boolean;
```

- [ ] **Step 2: Constructors.** Add `hasFailed: false,` to every Tab literal that already sets `hasUnread: false` — there are three: `addTab`, `duplicateTab`, and the lazy-restore `newTabs.push({...})` in `setActiveProject`. Find them with `grep -n "hasUnread: false" src/store/appStore.ts`.

- [ ] **Step 3: Clear on activation.** In `setActiveTab`, the existing map that clears `hasUnread` for the activated tab also sets `hasFailed: false` (same object spread).

- [ ] **Step 4: Set on failure.** Extend `handleCommandEnd` (after the terminals `set` from Task 2):

```ts
    // Reflect the result on the owning tab's activity dot: red for a
    // failure that happened out of sight, cleared again by a subsequent
    // success. Active-tab failures are visible on screen — no dot.
    const state = get();
    const tab = state.tabs.find(
      (t) => t.mosaic && collectLeaves(t.mosaic).includes(terminalId),
    );
    if (tab && tab.id !== state.activeTabId) {
      const failed = exitCode !== 0;
      if (tab.hasFailed !== failed) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tab.id ? { ...t, hasFailed: failed } : t,
          ),
        }));
      }
    }
```

- [ ] **Step 5: Dot markup.** In `TabBar.tsx` replace the activity span with:

```tsx
          {tab.hasUnread && !isActive && (
            <span
              className={`tab__activity${tab.hasFailed ? " tab__activity--failed" : ""}`}
              aria-label={tab.hasFailed ? "Command failed" : "Activity"}
            />
          )}
```

- [ ] **Step 6: CSS.** After the `.tab__activity` block in `TabBar.css`:

```css
.tab__activity--failed {
  background: #e5484d;
}
```

- [ ] **Step 7: Verify.** Run: `npm run build`. Expected: clean.

- [ ] **Step 8: Commit.**

```bash
git add src/store/appStore.ts src/components/TabBar.tsx src/components/TabBar.css
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(tabs): red activity dot when a background command fails"
```

---

### Task 5: Long-command OS notification

**Files:**
- Modify: `package.json` (dependency), `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (plugin init ~line 423), `src-tauri/capabilities/default.json`
- Create: `src/utils/notify.ts`
- Modify: `src/store/appStore.ts` (`Settings` + `DEFAULT_SETTINGS` + `clampSettings` + `handleCommandEnd`)
- Modify: `src/components/SettingsDialog.tsx` (new field next to `TrackCwdField`, ~line 790)

**Interfaces:**
- Consumes: `handleCommandEnd` runtime computation (Task 2), `Settings` clamp pattern.
- Produces: `notifyCommandFinished(title: string, body: string): void` in `src/utils/notify.ts`; setting `notifyLongCommands: boolean`.

- [ ] **Step 1: Dependencies.**

```bash
npm install @tauri-apps/plugin-notification
```

In `src-tauri/Cargo.toml` add under `[dependencies]`: `tauri-plugin-notification = "2"`.
In `src-tauri/src/lib.rs`, next to the other `.plugin(...)` lines: `.plugin(tauri_plugin_notification::init())`.
In `src-tauri/capabilities/default.json` permissions array add: `"notification:default"`.

- [ ] **Step 2: Create `src/utils/notify.ts`:**

```ts
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// Permission is requested lazily on the first notification attempt and the
// answer cached for the session. Everything is best-effort — notification
// failure must never surface as an app error.
let permitted: boolean | null = null;

export function notifyCommandFinished(title: string, body: string): void {
  void (async () => {
    try {
      if (permitted === null) {
        permitted = await isPermissionGranted();
        if (!permitted) {
          permitted = (await requestPermission()) === "granted";
        }
      }
      if (permitted) sendNotification({ title, body });
    } catch {
      permitted = permitted ?? false;
    }
  })();
}
```

- [ ] **Step 3: Setting.** In `appStore.ts`:

`Settings` type, after `checkForUpdatesOnStartup`:

```ts
  /** OS notification when a command that ran ≥ 5 s finishes while its tab
   * is inactive or the window is unfocused. Needs shell integration. */
  notifyLongCommands: boolean;
```

`DEFAULT_SETTINGS`: `notifyLongCommands: true,`.

`clampSettings`, next to the other boolean clamps:

```ts
    notifyLongCommands:
      typeof s.notifyLongCommands === "boolean"
        ? s.notifyLongCommands
        : DEFAULT_SETTINGS.notifyLongCommands,
```

- [ ] **Step 4: Trigger.** In `handleCommandEnd`, before the `set` that clears `commandStartedAt`, capture `const startedAt = current.commandStartedAt;` — then append at the end of the action:

```ts
    // Long-command notification: only when we saw the C mark (so we know
    // the runtime), the command ran long enough to be worth interrupting
    // for, and the user wasn't watching (inactive tab or unfocused window).
    const LONG_COMMAND_MS = 5_000;
    const runtime = startedAt ? Date.now() - startedAt : 0;
    const unwatched =
      !tab || tab.id !== state.activeTabId || !document.hasFocus();
    if (
      runtime >= LONG_COMMAND_MS &&
      unwatched &&
      state.settings.notifyLongCommands
    ) {
      const project = tab
        ? state.projects.find((p) => p.id === tab.projectId)
        : undefined;
      const where = [project?.name, tab?.title].filter(Boolean).join(" · ");
      notifyCommandFinished(
        exitCode === 0 ? "Command finished" : `Command failed (exit ${exitCode})`,
        where || "Terminal",
      );
    }
```

(`tab` and `state` already exist from Task 4's step 4; import `notifyCommandFinished` from `"../utils/notify"`.)

- [ ] **Step 5: Settings UI.** In `SettingsDialog.tsx`, add a sibling component below `TrackCwdField` and render it directly after `<TrackCwdField …/>` (find the render site with `grep -n "TrackCwdField" src/components/SettingsDialog.tsx`):

```tsx
function NotifyLongCommandsField({ section }: { section?: string } = {}) {
  const { settings } = useSettings();
  return (
    <FieldRow
      label="Notify when long commands finish"
      align="top"
      hint="OS notification when a command that ran ≥ 5 s finishes on an inactive tab or while the window is unfocused. Requires shell integration."
      section={section}
    >
      <Toggle2
        on={settings.notifyLongCommands}
        onChange={(v) => set("notifyLongCommands", v)}
      />
    </FieldRow>
  );
}
```

(Mirror `TrackCwdField`'s exact `set` accessor — if it uses a hook-scoped `set`, use the same.)

- [ ] **Step 6: Verify.** Run: `npm run build` and `cd src-tauri && cargo check`. Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src/utils/notify.ts src/store/appStore.ts src/components/SettingsDialog.tsx
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(notify): OS notification when long background commands finish"
```

---

### Task 6: Settings copy — "Shell integration"

**Files:**
- Modify: `src/components/SettingsDialog.tsx` (`TrackCwdField`, ~line 790)

**Interfaces:** none (copy only; the `autoCwdTracking` key is unchanged).

- [ ] **Step 1: Relabel.** In `TrackCwdField` change `label` to `"Shell integration"` and `hint` to:

```
Injects shell hooks (zsh, bash, fish, nushell): OSC 7 keeps the current directory in sync for session restore, OSC 133 marks prompts and command exits — powering prompt jumping (⌘↑/⌘↓), the failed-command tab dot, and long-command notifications. Affects newly-spawned terminals only.
```

- [ ] **Step 2: Verify + commit.**

```bash
npm run build
git add src/components/SettingsDialog.tsx
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(settings): relabel cwd tracking as shell integration"
```

---

### Task 7: Final verification

- [ ] **Step 1:** `npm run build` and `cd src-tauri && cargo check && cargo test` — all green.
- [ ] **Step 2:** Confirm no stray diff: `git status --short` shows nothing unstaged from this work.
- [ ] **Step 3:** Manual smoke (user — GUI can't be runtime-verified in the agent environment): enable "Shell integration" in Settings, open a new zsh terminal, run a few commands; Cmd+↑/↓ jumps across prompts; `false` on a background tab → red dot; `sleep 6` on a background tab → OS notification (grant permission on first prompt).

## Self-review notes

- Spec coverage: shell hooks (T1), mark parsing + state (T2), jumping (T3), dot (T4), notification + setting (T5), relabel (T6). D-without-C (bash trap missed) degrades to `runtime = 0` → no notification, exit code still recorded — matches spec's error-handling section.
- Type consistency: `handleCommandEnd(terminalId, exitCode)` defined in T2, extended in T4/T5 (same signature); `nearestPromptLine` consumed in T3 as declared in T2; `hasFailed` declared T4-step-1, used T4-step-5.
- `collectLeaves` is already imported in `appStore.ts` (used by `closeTab`); no new import needed in T4.
