# 2026-07-11/12 — OSC 133 shell integration + reopen closed tab (+ restore-replay debugging)

- **Branch:** master (commits `f0a6df1..cf04157`)
- **Participants:** Petr + Claude (Fable 5)

## Context

Continuation of the same-day audit session (see `2026-07-11-code-audit-critical-fixes.md`).
Implemented the two top feature-backlog items, then a debugging saga around
restored-buffer replay, driven by Petr's live testing.

## What was done

- **OSC 133 shell integration** (`f0a6df1`–`4d2d5f2`): shell hooks emit
  A/C/D marks (zsh/bash/fish/nushell); prompt jumping Cmd+↑/↓; red
  failed-command tab dot; OS notification for ≥5 s background commands
  (`@tauri-apps/plugin-notification`, setting `notifyLongCommands`);
  settings toggle relabeled "Shell integration". Spec + plan in
  `docs/superpowers/`.
- **Reopen closed tab** (`61ffd22`–`2263834`): session-only `closedTabs`
  stack (cap 10) captured in `closeTab` with scrollback; Cmd+Shift+T
  rebuilds layout+cwds+content; `duplicateTab` now replicates split
  layouts.
- **Restore-replay fixes** (found via Petr's testing + console diagnostics):
  - `163dc6c`/`3d53e4a`: viewport pinned to bottom across fits + grace
    window.
  - `28d54db`: `POWERLEVEL9K_INSTANT_PROMPT=off` in the injected zshrc.
  - `e6032fa`: **root causes** — unpaired DECRC homed cursor to (0,0) and
    `\e[J` wiped the restored screen (replay now appends `\e7`);
    `scrollToBottom()` throwing inside write callbacks corrupted xterm's
    write queue (→ `safeScrollToBottom`).
  - `b651f3d`: `closeTab` removes state before killing PTYs (exit-event
    race pushed a degraded duplicate onto the reopen stack).
  - `cf04157`: `\r\n` after replay so zsh doesn't print the `%`
    partial-line marker.
- All three pitfalls documented in CLAUDE.md "Things to watch out for".

## Key decisions

- OSC 133 marks A/C/D only (no B); pure frontend parsing; one shared
  "Shell integration" switch (persisted key `autoCwdTracking` unchanged).
- p10k instant prompt disabled in Shellboard-spawned shells — two-phase
  repaint is fundamentally hostile to buffer replay.
- Reopen stack is session-only, like iTerm2.

## Open questions

- Early PTY output (before the frontend data listener attaches) is lost —
  root of the DECRC issue; worked around, not fixed. A backend-side buffer
  until first subscriber would fix it properly.
- CSP smoke test of a packaged build still pending (from the audit session).

## Next steps

1. Remaining feature backlog: per-project shell/env/startup command, pane
   zoom, richer in-terminal search, config export/import, custom themes.
2. Consider backend buffering of pre-subscribe PTY output (see above).
