# 2026-07-11 — Code audit + critical/medium fixes

- **Branch:** master (commits `ab4117c..fefc8d0`, 7 total)
- **Participants:** Petr + Claude (Fable 5)

## Context

Petr asked for a whole-project code analysis (what to improve, feature
ideas). Three parallel review agents covered store/persistence, the Rust
backend, and components/features. Petr then approved implementing all
critical + medium findings; feature ideas were deferred.

## What was done

- `ab4117c` — backend owns PTY lifecycle: `PtySession::Drop` kills+waits,
  reader loop reaps its session on EOF, `running_apps_snapshot` and
  `write_to_pty` moved off the main thread / async workers. Fixes the
  zombie-leak root cause of the ptmx-exhaustion problem.
- `3840691` — PTY data events batched (reader → mpsc → async emitter,
  64 KB cap, zero added latency for interactive echo).
- `e8b4df4` — CSP enabled (was `null`); `opener:allow-open-path` narrowed
  from `**` to `$HOME/**` + `/Volumes/**`.
- `60cde7d` — store: `flushSessionSave` concurrency guard; dirty-tracked
  buffer serialization (`markTerminalBufferDirty`/`dropTerminalBuffer` in
  `sessionSerialize.ts`); `restoredBuffers` released 10 s after consume;
  projects/groups shape-validated on hydrate.
- `2380a03` — UI: keyboard dispatcher gated behind open dialogs;
  GlobalSearch debounced + capped at 10k lines/terminal, dead `⌘↵` hint
  removed; new `useFocusTrap` hook applied to all dialogs; TabBar roving
  tabindex + arrow/Enter/F2 navigation.
- `611b628` — review follow-ups: resize marks buffer dirty; EOF reap uses
  `try_state` (shutdown-safe).
- `fefc8d0` — native menu accelerators respect the modal gate too (found
  by Petr: Cmd+W in Settings still closed the tab via the macOS menu;
  only `app.quit` passes through).

An independent adversarial review of the full diff found no must-fix bugs
(locks, races, event ordering, quit path, StrictMode all verified).

## Key decisions

- Backend (not frontend) is authoritative for PTY cleanup; `kill_pty`
  stays idempotent so the frontend round-trip is harmless.
- Event batching is queue-drain based (no timer) — batches form only when
  output outpaces emission, so interactivity is untouched.
- While any dialog is open, both the JS dispatcher and native menu stand
  down; the single exception is `app.quit`.
- Opener scope intentionally breaks reveal-in-Finder for projects outside
  `$HOME`/`/Volumes` — accepted trade-off.

## Open questions

- CSP in a packaged release build needs a runtime smoke test (Vite's
  inline module-preload script should be hashed by Tauri, unverified).
- Feature backlog from the audit (not implemented): OSC 133 shell
  integration, reopen-closed-tab, per-project shell/env/startup command,
  pane zoom, richer in-terminal search, OS notifications, config
  export/import, custom themes.

## Next steps

1. Petr: runtime smoke test — dev app launches with CSP, terminals close
   without zombies (`pgrep -P <pid>`), heavy output feels smoother.
2. Pick the first feature from the backlog above (best value/effort:
   OSC 133 or reopen-closed-tab).
