# 2026-10-09 — Dependency updates

- **Branch:** master (commits `6ff17f7`..`d6983ab`, all pushed)
- **Participants:** Petr + Claude (Opus 5.5)

## Context

Routine check whether any libraries needed updating. Started from a clean
`master` with a few npm/Cargo deps several minors behind and an `npm audit`
finding (2× moderate, `uuid` under `react-mosaic-component`).

## What was done

- In-range updates of npm + Cargo deps: Tauri 2.11 → 2.12 on both JS and Rust
  sides (kept in sync), React 19.3, Vite 8.3, zustand 5.0.15, tokio 1.53,
  wry 0.57. Lockfiles only.
- Cleared GHSA-w5hq-g745-h8pq with an npm `overrides` entry forcing
  `uuid ^11.1.1` under `react-mosaic-component` → `npm audit` is clean.
- `sysinfo` 0.33 → 0.39.6 — no code changes needed in `pty.rs`.
- Installed `cargo-audit` and ran it: 0 vulnerabilities. 2 warnings
  (`proc-macro-error` unmaintained, `glib` 0.18 unsound) both come from Tauri's
  Linux GTK3 stack, so there's nothing to fix on our side.
- Verified each step with `npm run build` + `cargo check`. Petr also ran it
  in `tauri dev` (tabs/splits/session restore, Running-apps modal).

## Key decisions

- **Stayed on react-mosaic-component 6.** v7 switches to an n-ary tree
  (`{type:'split', children[], splitPercentages[]}` plus `tabs` nodes). That
  would mean rewriting `src/utils/mosaic.ts`, `sessionSerialize.ts`, the
  split/close logic in the store, and migrating persisted `session.json`.
  The audit finding didn't justify that, because mosaic 6 only calls
  `uuid.v4()` (no buffer arg), so the override is safe.
- **TypeScript 7 deferred.** It's the new native compiler and still too fresh,
  and nothing in the project needs it.
- sysinfo note: since 0.34, Linux threads (tasks) are no longer listed as
  processes unless requested. That makes the Running-apps subtree RSS more
  accurate there, not less.

## Open questions

- None blocking.

## Next steps

- When migrating to mosaic 7 (only if n-ary splits / in-panel tabs are
  wanted), **remove the `uuid` override** from `package.json`. v7 depends on
  uuid 11 itself.
- Re-run `npm outdated`, `npm audit`, `cargo update --dry-run` and
  `cargo audit` (in `src-tauri/`) on the next dependency pass.

## References

- Commits: `6ff17f7` (in-range dep updates), `f629a2b` (uuid override),
  `d6983ab` (sysinfo 0.39)
- mosaic v6 → v7 migration guide:
  https://nomcopter.github.io/react-mosaic/docs/migration/from-v6
