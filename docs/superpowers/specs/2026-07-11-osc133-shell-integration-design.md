# OSC 133 Shell Integration — Design

Date: 2026-07-11 · Status: approved by Petr

## Purpose

Teach Shellboard the structure of what happens inside a terminal — prompt /
command / output / exit code — via OSC 133 marks emitted by the shell. Three
user-facing features in v1:

1. **Jump between prompts** — Cmd+↑ / Cmd+↓ scrolls to the previous/next
   prompt in the focused panel.
2. **Exit-status indication** — the tab activity dot turns red when the last
   command finished with a nonzero exit code on an inactive tab.
3. **Command-finished notification** — an OS notification when a command that
   ran ≥ 5 s finishes while its tab is inactive or the window is unfocused.

Out of scope for v1: copy-last-output, the OSC 133;B (prompt-end) mark,
cursor-positioning features, per-command output folding.

## Marks used

- `OSC 133;A ST` — start of prompt. Emitted by the shell before drawing PS1.
- `OSC 133;C ST` — command execution starts.
- `OSC 133;D;<exit> ST` — command finished with exit code.

`B` is intentionally not emitted: it requires wrapping PS1, is invasive, and
none of the v1 features need it.

## Architecture

Pure-frontend processing (decision: rejected backend parsing — xterm already
has an OSC parser; a second one in Rust would add IPC events and
chunk-boundary risk for zero gain). Marks flow through the PTY stream as
ordinary data; the backend only injects the shell hooks that emit them.

### 1. Shell side — `src-tauri/src/pty.rs`

`osc7_wiring` becomes the general shell-integration wiring (same init files,
same `ZDOTDIR` / `--rcfile` / `--init-command` / `--env-config` mechanism,
same settings switch — `autoCwdTracking` key kept for config compat,
relabeled "Shell integration" in the Settings UI).

Added to the existing init files:

- **zsh** — `precmd`: emit `D;$?` (skipped before the first prompt via a
  guard variable) then `A`; `preexec`: emit `C`.
- **bash** — `PROMPT_COMMAND`: `D;$?` + `A` (same first-prompt guard);
  `C` via a `DEBUG` trap installed **only if** no user DEBUG trap exists
  (best-effort, mirrors the existing PROMPT_COMMAND append style).
- **fish** — `fish_prompt`/`fish_preexec`/`fish_postexec` event functions
  (`D` from `$status` in `fish_postexec`, `A` in `fish_prompt`, `C` in
  `fish_preexec`).
- **nushell** — `pre_prompt` (D+A) and `pre_execution` (C) hooks, appended to
  the existing hook-install block. Best-effort as today.

Windows / other shells: no injection (unchanged fall-through).

### 2. Mark handling — `src/components/Terminal.tsx` + new `src/utils/promptMarks.ts`

`xterm.parser.registerOscHandler(133, …)` next to the existing OSC 7 handler.

- `A` → `xterm.registerMarker(0)` pushed into a module-level per-terminal
  registry (`promptMarks.ts`: `terminalId → IMarker[]`, capped at 200,
  disposed markers pruned, cleared on `unregisterTerminal`/kill).
- `C` → store: `terminals[id].commandStartedAt = Date.now()`.
- `D;code` → store: `lastExitCode = code`, `commandStartedAt = null`;
  compute duration and hand off to notification logic.

Markers survive scroll/trim via xterm's marker API. They do **not** survive
session restore (serialized scrollback is plain text) — jumping works from
the first new prompt after restore. Same behavior as iTerm2.

### 3. Prompt jumping

Two new rebindable actions in `src/shortcuts/registry.ts`:
`prompt.prev` (default Cmd/Ctrl+↑) and `prompt.next` (default Cmd/Ctrl+↓).
Handler targets the focused leaf of the active tab, finds the
nearest marker above/below the current viewport line, `scrollToLine`.
Menu items added like the existing focus/split entries.

### 4. Exit-status dot

`TerminalSession` gains `lastExitCode?: number`. The existing tab activity
dot (`tab__activity`) gets a `--failed` variant: red when any terminal in an
inactive tab has a failing `lastExitCode` for its most recently finished
command. Cleared on tab activation together with `hasUnread`.

### 5. Notification

New dependency `@tauri-apps/plugin-notification` (+ capability
`notification:default`, Rust plugin registration). On `D`:

- runtime = now − `commandStartedAt`; notify iff runtime ≥ 5 000 ms **and**
  (owning tab is not active **or** window is unfocused) **and** the new
  setting is on.
- Text: `<project name> · <tab title>` / `Command finished (exit <code>)`.
- New setting `notifyLongCommands: boolean` (default true) in Settings →
  clamped in `clampSettings` like the other booleans.
- Permission requested lazily on first notify attempt.

## Error handling

- Malformed OSC 133 payloads are ignored (handler returns true, no crash).
- Shell init failures stay best-effort (existing pattern: skip injection).
- Notification permission denied → silently skip, no retry loop.

## Testing

No test runner exists (per CLAUDE.md). Verification = `npm run build` (tsc),
`cargo check`/`cargo test` for the init-file changes (add unit tests for the
new shell snippets' guard logic where string-testable), plus manual smoke:
zsh + bash: jump across prompts, `false` → red dot on background tab,
`sleep 6` on background tab → OS notification.

## Migration / compat

- Settings key `autoCwdTracking` unchanged on disk; only the UI label
  changes. No schema migration needed.
- Shells without the hooks simply never emit marks — all three features
  degrade to no-ops.
