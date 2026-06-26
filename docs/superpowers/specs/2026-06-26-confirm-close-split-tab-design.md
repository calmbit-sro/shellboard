# Confirm before closing a split tab

**Date:** 2026-06-26
**Status:** Approved — ready for implementation plan

## Problem

Cmd+W closes the active tab. When the user reflexively hits Cmd+W thinking
they are in another window, the tab — and every terminal in it — is gone with
no undo. The painful case is a tab holding a **split layout** (multiple
terminals doing work); a lone idle shell is cheap to recreate and not worth a
prompt.

## Behavior

- Closing a tab that contains a **split (2+ terminals / mosaic leaves)** pops a
  confirmation dialog: *"Close this tab? It contains N terminals."*
- Closing a **single-terminal** tab stays instant — no prompt, even with the
  setting on.
- Gated by a new setting **"Confirm before closing a split tab"**, default
  **on**. When off, behavior is identical to today (no prompt anywhere).
- Applies to **all four single-tab close paths**: Cmd+W, the X button on a tab,
  right-click → Close tab, and the command palette.
- **Not** affected:
  - Cmd+Shift+W (panel/split close) — closing one panel keeps the rest, so no
    prompt.
  - "Close others" / "Close to right" — deliberate bulk ops; per-tab prompts
    would mean N dialogs. Left as direct closes.

## Approach

Gate the confirmation at a **new store entry-point in front of `closeTab`**,
not inside `closeTab` and not duplicated across the 4 components.

`closeTab` stays the pure destructive operation. It is still called internally
by `closeOtherTabs`, `closeTabsToRight`, and `closeActivePanel` (last-panel
case), none of which should prompt. A new `requestCloseTab` becomes the
user-facing entry point and owns the decision. This matches the store's
existing ownership model (PTY lifecycle + nullable pending-UI fields like
`renamingTabId`) and keeps the branch in one place.

Alternatives considered and rejected:
- *Inside `closeTab`* — would prompt on internal bulk/last-panel delegations.
- *At each UI call site* — duplicates the leaf-count + setting check 4×.

## Changes

### 1. Setting (`src/store/appStore.ts`)

- Add `confirmCloseSplitTab: boolean` to the `Settings` type with a doc comment
  explaining it triggers only for multi-panel tabs.
- Add to `DEFAULT_SETTINGS`: `true`.
- Add a defensive read in `clampSettings`, mirroring `showPanelHeader`:
  `typeof s.confirmCloseSplitTab === "boolean" ? s.confirmCloseSplitTab : DEFAULT_SETTINGS.confirmCloseSplitTab`.

### 2. Store: pending-close state + actions (`src/store/appStore.ts`)

- New ephemeral state field `pendingCloseTabId: string | null` (default `null`,
  **not** persisted — lives only in the live store, excluded from session
  serialization).
- `requestCloseTab(tabId: string): void`
  - Look up the tab. If `settings.confirmCloseSplitTab` is on **and**
    `collectLeaves(tab.mosaic).length > 1` → set `pendingCloseTabId = tabId`.
  - Otherwise → `void closeTab(tabId)` immediately.
  - Re-requesting the same id while a prompt is open is idempotent.
- `confirmPendingClose(): void` — capture `pendingCloseTabId`, clear it, then
  `void closeTab(id)` (guard: if the tab no longer exists, just clear).
- `cancelPendingClose(): void` — set `pendingCloseTabId = null`.
- Import `collectLeaves` from `src/utils/mosaic.ts` if not already imported.

### 3. Repoint the 4 entry points (`closeTab` → `requestCloseTab`)

- `src/shortcuts/actions.ts` — `tab.close`.
- `src/components/TabBar.tsx` — the X close button and the context-menu
  "Close tab" item.
- `src/components/CommandPalette.tsx` — the "Close tab" command.

### 4. New `ConfirmDialog` component (`src/components/ConfirmDialog.tsx` + `.css`)

Reusable confirm built on the existing `Modal`. Props: `open`, `title`,
`message`, `confirmLabel`, `cancelLabel`, `onConfirm`, `onCancel`, and a
`destructive` flag for button styling.

**Safety default:** auto-focus the **Cancel** button. Esc / Enter / click
outside all resolve to cancel (keep the tab); closing requires an explicit
click on — or Tab-to — the "Close tab" button. This directly serves the
feature's purpose: catching the accidental keypress. (`Modal` already maps
Escape and backdrop click to `onClose`; wire `onClose = onCancel`.)

### 5. Render in `App.tsx`

Render the dialog alongside the other global dialogs, driven by
`pendingCloseTabId`:
- `open` is derived from `pendingCloseTabId` pointing at an existing tab — so it
  auto-dismisses if that tab vanishes (e.g. its PTY exits while the prompt is
  up).
- Message includes the tab's terminal count (and title if available).
- `onConfirm → confirmPendingClose()`, `onCancel → cancelPendingClose()`.

### 6. Settings toggle (`src/components/SettingsDialog.tsx`)

Add one `<Toggle>` row using the existing `set("confirmCloseSplitTab", v)`
helper, placed near the other behavior toggles (`persistScrollback`,
`showPanelHeader`, `showGroupCount`). Label: **"Confirm before closing a split
tab"**; description: *"Ask before closing a tab that has multiple terminals."*

## Edge cases

- **Setting off** → `requestCloseTab` always closes immediately; no new state
  observable. Identical to today.
- **Single-panel tab** → closes immediately even with setting on.
- **Tab removed while prompt open** → derived `open` goes false; dialog
  disappears; `confirmPendingClose` no-ops if the tab is already gone.
- **Re-trigger while open** → idempotent (same `pendingCloseTabId`).
- **Last tab in a project that is also a split** → on confirm, `closeTab`'s
  existing last-tab auto-respawn logic runs unchanged.

## Persistence

`confirmCloseSplitTab` rides the existing `shellboard.json` settings blob — the
only new persistence wiring is the type field, the default, and the
`clampSettings` read. `pendingCloseTabId` is ephemeral and is **not** added to
any session/settings serialization.

## Verification

No test runner exists; `npm run build` (tsc) is the only static gate. The GUI
cannot be runtime-verified in this environment (the Tauri window closes seconds
after launch), so verification = clean `npm run build` + focused self-review of
the four close paths and the dialog wiring.

## Files

- `src/store/appStore.ts` — setting, default, `clampSettings` read, state field,
  3 actions, `collectLeaves` import.
- `src/shortcuts/actions.ts` — `tab.close` → `requestCloseTab`.
- `src/components/TabBar.tsx` — X button + context menu → `requestCloseTab`.
- `src/components/CommandPalette.tsx` — close-tab command → `requestCloseTab`.
- `src/components/ConfirmDialog.tsx` — new.
- `src/components/ConfirmDialog.css` — new.
- `src/App.tsx` — render the confirm dialog.
- `src/components/SettingsDialog.tsx` — settings toggle.
