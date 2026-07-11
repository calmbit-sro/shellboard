# Reopen Closed Tab + duplicateTab layout fix — Design

Date: 2026-07-11 · Status: approved by Petr

## Purpose

1. **Reopen closed tab** (default Cmd/Ctrl+Shift+T, rebindable): closing a tab
   pushes its serialized form onto a session-only stack; reopen rebuilds the
   full split layout with fresh PTYs in the saved cwds **and replays the
   saved scrollback** (approved trade-off: up to ~2 MB per terminal held for
   at most 10 stacked tabs).
2. **duplicateTab fix**: duplicating a tab replicates the whole split layout
   and per-panel cwds with fresh shells (today it opens a single shell).
   Scrollback is intentionally not copied.

## Architecture

Everything rides on the existing session-serialize infrastructure:
`tabToPersisted` / `mosaicToLayout` (serialize, dirty-cache-backed) and
`buildMosaicFromLayout` (rebuild + spawn), plus the `restoredBuffers` replay
path Terminals already consume on mount.

- **Store state**: `closedTabs: ClosedTab[]` where
  `ClosedTab = { projectId, tab: PersistedTab, buffers, closedAt }`.
  Session-only (never persisted — same as iTerm). Cap 10; oldest entries
  (and their buffers) drop off.
- **Capture**: `closeTab` serializes the tab (after `flushAllWrites()`)
  *before* killing its PTYs and pushes the entry. `removeProject` prunes the
  stack for the removed project id (its tabs never enter the stack — that
  path doesn't go through `closeTab`).
- **Reopen** (`reopenClosedTab()` store action): pop the newest entry whose
  project still exists (silently dropping stale ones), rebuild via
  `buildMosaicFromLayout`, seed `restoredBuffers`, insert the tab with a
  fresh id, switch to its project if needed, activate. Spawn failure (out of
  PTYs) mirrors the lazy-restore handling: kill what spawned, push the entry
  back, show the error toast.
- **Shortcut/menu**: `tab.reopen` in the shortcut registry (Tabs category)
  + a native-menu item, both wired like existing tab actions.
- **duplicateTab**: serialize the source tab's mosaic with `mosaicToLayout`
  (buffer sink discarded), rebuild with `buildMosaicFromLayout` and empty
  buffers → same layout/cwds, fresh shells. Title follows the addTab
  numbering convention unless the source has a custom title (then copied).

## Edge cases

- Last-tab close + auto-respawn: unchanged, and the closed tab is reopenable.
- Ephemeral quick-add projects (`autoCwdName`): closing their last tab removes
  the project, so the stack entry becomes stale and is skipped at reopen time.
- Culled idle tabs go through `closeTab` → reopenable.
- Reopen with zero valid entries: no-op.

## Testing

`npm run build` (tsc) gate; no TS test runner exists. Manual smoke: close a
split tab → Cmd+Shift+T restores layout + scrollback; duplicate a split tab →
same layout, fresh shells; delete a project → its closed tabs don't reopen.
