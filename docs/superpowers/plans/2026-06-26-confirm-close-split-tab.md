# Confirm Before Closing a Split Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pop a confirmation dialog before closing a tab that contains a split (2+ terminals); single-terminal tabs still close instantly. Gated by a new setting, default on.

**Architecture:** A new store entry-point `requestCloseTab` sits in front of the existing destructive `closeTab`. It decides — based on the `confirmCloseSplitTab` setting and the tab's leaf count — whether to set an ephemeral `pendingCloseTabId` (which drives a new `ConfirmDialog` rendered in `App.tsx`) or close immediately. The four user-facing close paths (Cmd+W, X button, context menu, command palette) are repointed from `closeTab` to `requestCloseTab`. `closeTab` itself is unchanged, so internal callers (close-others / close-to-right / last-panel-close) never prompt.

**Tech Stack:** React 19 + TypeScript, zustand store, `react-mosaic-component` (leaf = PTY id), existing `Modal` component.

## Global Constraints

- **No test runner exists.** Per `CLAUDE.md`, `tsc` (run via `npm run build`) is the only static check. Do **not** add `npm test`, vitest, or eslint. Each task's verification gate is `npm run build` producing no type errors, plus the stated behavioral reasoning. The GUI cannot be runtime-verified in this environment (the Tauri window closes seconds after launch).
- **Commit author:** every commit must use `--author="Petr Hlozek <petr@petrhlozek.cz>"` (local git config has the wrong email).
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **macOS shortcut convention:** Cmd on macOS, Ctrl on Linux/Windows — do not change existing bindings; this feature touches none.
- **Setting field name:** `confirmCloseSplitTab` (boolean), default `true`.
- **Branch:** work on `feat/confirm-close-split-tab` (already created; the spec commit is its first commit).

---

### Task 1: Store — setting + pending-close state + actions

**Files:**
- Modify: `src/store/appStore.ts`

**Interfaces:**
- Consumes: existing `collectLeaves` (already imported at the top of the file), existing `closeTab` action, existing `DEFAULT_SETTINGS`, `clampSettings`, zustand `get`/`set`.
- Produces (later tasks rely on these exact names):
  - `Settings.confirmCloseSplitTab: boolean`
  - store state `pendingCloseTabId: string | null`
  - `requestCloseTab: (tabId: string) => void`
  - `confirmPendingClose: () => void`
  - `cancelPendingClose: () => void`

- [ ] **Step 1: Add the setting to the `Settings` type**

In `src/store/appStore.ts`, the `Settings` type currently ends `showGroupCount` like this (around line 114-120):

```ts
  /** Show the project-count badge next to each group header in the
   * sidebar. Off = the chip is hidden, name takes the freed space. */
  showGroupCount: boolean;
  /** User keyboard-shortcut overrides, keyed by action id (see
```

Insert the new field between `showGroupCount` and the `keybindings` comment:

```ts
  /** Show the project-count badge next to each group header in the
   * sidebar. Off = the chip is hidden, name takes the freed space. */
  showGroupCount: boolean;
  /** Pop a confirmation dialog before closing a tab that contains a split
   * (2+ terminals). Single-terminal tabs always close immediately. Off =
   * never prompt. */
  confirmCloseSplitTab: boolean;
  /** User keyboard-shortcut overrides, keyed by action id (see
```

- [ ] **Step 2: Add the default**

In `DEFAULT_SETTINGS`, after `showGroupCount: true,`:

```ts
  showGroupCount: true,
  confirmCloseSplitTab: true,
  keybindings: {},
```

- [ ] **Step 3: Add the defensive hydrate read in `clampSettings`**

In `clampSettings`, after the `showGroupCount` block and before `keybindings: clampKeybindings(s.keybindings),`:

```ts
    showGroupCount:
      typeof s.showGroupCount === "boolean"
        ? s.showGroupCount
        : DEFAULT_SETTINGS.showGroupCount,
    confirmCloseSplitTab:
      typeof s.confirmCloseSplitTab === "boolean"
        ? s.confirmCloseSplitTab
        : DEFAULT_SETTINGS.confirmCloseSplitTab,
    keybindings: clampKeybindings(s.keybindings),
```

- [ ] **Step 4: Add the `pendingCloseTabId` state field to the `AppState` type**

The `AppState` type has the renaming fields (around line 162-167):

```ts
  /** When non-null, the GroupHeader should put this group into inline-rename mode. */
  renamingGroupId: string | null;
```

Insert after it:

```ts
  /** When non-null, the GroupHeader should put this group into inline-rename mode. */
  renamingGroupId: string | null;
  /** When non-null, App renders the close-tab confirmation dialog for this
   * tab (set only for split tabs when confirmCloseSplitTab is on). */
  pendingCloseTabId: string | null;
```

- [ ] **Step 5: Add the three action signatures to the `AppState` type**

After `closeTab: (tabId: string) => Promise<void>;` (around line 244):

```ts
  closeTab: (tabId: string) => Promise<void>;
  /** User-facing tab close. Confirms first when the tab is a split and the
   * confirmCloseSplitTab setting is on; otherwise closes immediately. */
  requestCloseTab: (tabId: string) => void;
  /** Resolve the pending close confirmation: actually close the tab. */
  confirmPendingClose: () => void;
  /** Dismiss the pending close confirmation without closing. */
  cancelPendingClose: () => void;
```

- [ ] **Step 6: Initialize the new state field**

In the store's initial state object, the renaming defaults look like (around line 486-489):

```ts
  renamingTabId: null,
  renamingProjectId: null,
  renamingGroupId: null,
```

Insert after `renamingGroupId: null,`:

```ts
  renamingGroupId: null,
  pendingCloseTabId: null,
```

- [ ] **Step 7: Implement the three actions**

Find the `closeTab` implementation (around line 639): `  closeTab: async (tabId) => {`. Insert the three new actions immediately **before** it:

```ts
  requestCloseTab: (tabId) => {
    const { tabs, settings } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const isSplit = tab.mosaic ? collectLeaves(tab.mosaic).length > 1 : false;
    if (settings.confirmCloseSplitTab && isSplit) {
      set({ pendingCloseTabId: tabId });
    } else {
      void get().closeTab(tabId);
    }
  },
  confirmPendingClose: () => {
    const id = get().pendingCloseTabId;
    set({ pendingCloseTabId: null });
    if (id) void get().closeTab(id);
  },
  cancelPendingClose: () => set({ pendingCloseTabId: null }),

  closeTab: async (tabId) => {
```

- [ ] **Step 8: Type-check gate**

Run: `npm run build`
Expected: completes with no type errors (tsc + vite build succeed). The new field, state, and actions all compile; `collectLeaves` is already imported so no new import is needed.

Behavioral reasoning to confirm: `requestCloseTab` closes immediately when the setting is off OR the tab has ≤1 leaf; sets `pendingCloseTabId` only for a split with the setting on. `confirmPendingClose` clears state then closes. `cancelPendingClose` only clears. `closeTab` is untouched, so close-others / close-to-right / last-panel-close still bypass the prompt.

- [ ] **Step 9: Commit**

```bash
git add src/store/appStore.ts
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(store): confirmCloseSplitTab setting + requestCloseTab gate

Adds the confirmCloseSplitTab setting (default on) and a requestCloseTab
entry-point in front of closeTab that sets an ephemeral pendingCloseTabId
when closing a split tab. closeTab is unchanged so internal callers never
prompt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `ConfirmDialog` component

**Files:**
- Create: `src/components/ConfirmDialog.tsx`
- Create: `src/components/ConfirmDialog.css`

**Interfaces:**
- Consumes: existing `Modal` from `./Modal` (props: `open`, `onClose`, `title`, `children`, `maxWidth`).
- Produces (Task 3 relies on this exact prop shape):
  ```ts
  ConfirmDialog(props: {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;   // default "Confirm"
    cancelLabel?: string;    // default "Cancel"
    destructive?: boolean;   // default false
    onConfirm: () => void;
    onCancel: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Create the component**

Create `src/components/ConfirmDialog.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Modal } from "./Modal";
import "./ConfirmDialog.css";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe (Cancel) button when the dialog opens, so a reflexive
  // Enter or Space keeps the tab. Escape and click-outside also cancel
  // (handled by Modal via onClose).
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth={400}>
      <div className="confirm-dialog">
        <p className="confirm-dialog__message">{message}</p>
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              "confirm-dialog__btn confirm-dialog__btn--confirm" +
              (destructive ? " is-destructive" : "")
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Create the styles**

Create `src/components/ConfirmDialog.css` (uses tokens already defined in `src/styles/tokens.css`: `--fg`, `--muted`, `--bg-3`, `--line`, `--line-strong`, `--accent-ring`, `--red`, `--font-ui`):

```css
.confirm-dialog__message {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
}

.confirm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.confirm-dialog__btn {
  font-family: var(--font-ui);
  font-size: 13px;
  padding: 7px 14px;
  border-radius: 7px;
  border: 1px solid var(--line);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.confirm-dialog__btn:focus-visible {
  outline: none;
  border-color: var(--line-strong);
  box-shadow: 0 0 0 2px var(--accent-ring);
}

.confirm-dialog__btn--cancel {
  background: var(--bg-3);
  color: var(--fg);
}

.confirm-dialog__btn--cancel:hover {
  border-color: var(--line-strong);
}

.confirm-dialog__btn--confirm {
  background: transparent;
  color: var(--fg);
}

.confirm-dialog__btn--confirm:hover {
  border-color: var(--line-strong);
}

.confirm-dialog__btn--confirm.is-destructive {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}

.confirm-dialog__btn--confirm.is-destructive:hover {
  filter: brightness(1.08);
}
```

- [ ] **Step 3: Type-check gate**

Run: `npm run build`
Expected: no type errors. The component is exported but not yet imported anywhere — that is fine (tsc does not flag unused exports). The `.css` import resolves.

- [ ] **Step 4: Commit**

```bash
git add src/components/ConfirmDialog.tsx src/components/ConfirmDialog.css
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(ui): reusable ConfirmDialog component

Cancel-focused confirm built on Modal: Escape / Enter / click-outside
all cancel; the destructive action requires an explicit click. Used next
by the close-split-tab confirmation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire it up — repoint close paths + render the dialog

This task makes the feature functional end-to-end. The four entry points stop calling `closeTab` directly and call `requestCloseTab`; `App.tsx` renders the `ConfirmDialog` driven by `pendingCloseTabId`.

**Files:**
- Modify: `src/shortcuts/actions.ts` (the `tab.close` action)
- Modify: `src/components/TabBar.tsx` (selector + X button + context menu)
- Modify: `src/components/CommandPalette.tsx` (the "close tab" command)
- Modify: `src/App.tsx` (import + selectors + render)

**Interfaces:**
- Consumes from Task 1: `requestCloseTab`, `pendingCloseTabId`, `confirmPendingClose`, `cancelPendingClose`.
- Consumes from Task 2: `ConfirmDialog` and its prop shape.

- [ ] **Step 1: Repoint the keyboard action (`actions.ts`)**

In `src/shortcuts/actions.ts`, the `tab.close` action currently reads:

```ts
    "tab.close": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) void store.closeTab(store.activeTabId);
    },
```

Replace with (note: `requestCloseTab` is synchronous, so no `void`):

```ts
    "tab.close": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) store.requestCloseTab(store.activeTabId);
    },
```

Leave `tab.closeOthers` and `tab.closeRight` unchanged.

- [ ] **Step 2: Add the selector in `TabBar.tsx`**

In `src/components/TabBar.tsx`, after `const closeTab = useAppStore((s) => s.closeTab);` (around line 35) add:

```ts
  const closeTab = useAppStore((s) => s.closeTab);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
```

(Keep the `closeTab` selector — it is still referenced by the other context-menu items in this file? No: only "Close", X, others, right use it. After this task `closeTab` is no longer referenced directly in TabBar. If `tsc` flags `closeTab` as unused after Steps 3-4, remove the `const closeTab` line. Resolve based on the build output in Step 6.)

- [ ] **Step 3: Repoint the context-menu "Close" item (`TabBar.tsx`)**

In the context-menu array, the "Close" entry reads:

```ts
      {
        label: "Close",
        onClick: () => void closeTab(tabId),
      },
```

Replace with:

```ts
      {
        label: "Close",
        onClick: () => requestCloseTab(tabId),
      },
```

- [ ] **Step 4: Repoint the X button (`TabBar.tsx`)**

The `SortableTab` render passes `onClose`:

```ts
              onClose={() => void closeTab(tab.id)}
```

Replace with:

```ts
              onClose={() => requestCloseTab(tab.id)}
```

(After Steps 3-4, if `closeTab` is now unused in this file, delete the `const closeTab = useAppStore((s) => s.closeTab);` line added/kept in Step 2.)

- [ ] **Step 5: Repoint the command palette (`CommandPalette.tsx`)**

In `src/components/CommandPalette.tsx`, the "close tab" command reads:

```tsx
                  <Command.Item
                    value="close tab"
                    onSelect={run(() => store.closeTab(activeTabId))}
                    className="palette__item"
                  >
```

Replace the `onSelect` with:

```tsx
                    onSelect={run(() => store.requestCloseTab(activeTabId))}
```

Leave the "close panel" command (`store.closeActivePanel()`) unchanged.

- [ ] **Step 6: Render the dialog in `App.tsx`**

First add imports near the other component imports at the top of `src/App.tsx`:

```tsx
import { ConfirmDialog } from "./components/ConfirmDialog";
import { collectLeaves } from "./utils/mosaic";
```

Then add selectors alongside the other top-level `useAppStore` selectors (near line 84-89):

```tsx
  const tabs = useAppStore((s) => s.tabs);
  const pendingCloseTabId = useAppStore((s) => s.pendingCloseTabId);
  const confirmPendingClose = useAppStore((s) => s.confirmPendingClose);
  const cancelPendingClose = useAppStore((s) => s.cancelPendingClose);
```

Then, just before `return (` (line 417), compute the pending tab + count:

```tsx
  const pendingCloseTab = pendingCloseTabId
    ? tabs.find((t) => t.id === pendingCloseTabId) ?? null
    : null;
  const pendingCloseCount = pendingCloseTab?.mosaic
    ? collectLeaves(pendingCloseTab.mosaic).length
    : 0;
```

Finally, render the dialog among the other dialogs (e.g. right after `<ShortcutsDialog ... />`, before `<RecentSwitcher />`):

```tsx
      <ConfirmDialog
        open={!!pendingCloseTab}
        title="Close tab?"
        message={`This tab contains ${pendingCloseCount} terminals. Closing it will end all of them.`}
        confirmLabel="Close tab"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmPendingClose}
        onCancel={cancelPendingClose}
      />
```

`open` is derived from `pendingCloseTab` existing, so the dialog auto-dismisses if that tab disappears (e.g. its PTY exits while the prompt is up). `pendingCloseCount` is always ≥ 2 here (only splits set `pendingCloseTabId`), so "terminals" is always grammatically plural.

- [ ] **Step 7: Type-check gate**

Run: `npm run build`
Expected: no type errors. If `tsc` reports `closeTab` is declared but never read in `TabBar.tsx`, remove the now-unused `const closeTab = useAppStore((s) => s.closeTab);` line and re-run until clean.

Behavioral reasoning: Cmd+W / X / context-menu / palette → `requestCloseTab` → split + setting-on shows the dialog; otherwise closes instantly. Confirm → `confirmPendingClose` → `closeTab` (kills PTYs). Cancel / Esc / click-outside → `cancelPendingClose` (tab kept). Panel close and bulk close untouched.

- [ ] **Step 8: Commit**

```bash
git add src/shortcuts/actions.ts src/components/TabBar.tsx src/components/CommandPalette.tsx src/App.tsx
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat: confirm before closing a split tab

Repoints the four user-facing tab-close paths (Cmd+W, X button, context
menu, command palette) to requestCloseTab and renders the confirmation
dialog in App, driven by pendingCloseTabId. Splits prompt; single-terminal
tabs and bulk/panel closes do not.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Settings toggle

**Files:**
- Modify: `src/components/SettingsDialog.tsx` (new field component + section placement + search index entry)

**Interfaces:**
- Consumes: `useSettings`, `set`, `FieldRow`, `Toggle2` (all already defined in this file); `Settings.confirmCloseSplitTab` from Task 1.

- [ ] **Step 1: Define the field component**

In `src/components/SettingsDialog.tsx`, add a new field component next to the other toggle fields (e.g. right after `ShowGroupCountField`, around line 752):

```tsx
function ConfirmCloseSplitTabField({ section }: { section?: string } = {}) {
  const { settings } = useSettings();
  return (
    <FieldRow
      label="Confirm before closing a split tab"
      align="top"
      hint="Ask before closing a tab that contains multiple terminals (a split). Single-terminal tabs always close immediately."
      section={section}
    >
      <Toggle2
        on={settings.confirmCloseSplitTab}
        onChange={(v) => set("confirmCloseSplitTab", v)}
      />
    </FieldRow>
  );
}
```

- [ ] **Step 2: Place it in the General section pane**

In `SectionPane`, the `general` case renders:

```tsx
          <UiFontSizeField />
          <ShowGroupCountField />
          <CheckForUpdatesField />
```

Add the new field:

```tsx
          <UiFontSizeField />
          <ShowGroupCountField />
          <ConfirmCloseSplitTabField />
          <CheckForUpdatesField />
```

- [ ] **Step 3: Add the search-index entry**

In `SEARCH_INDEX`, after the `group-count` entry (the one whose `render` is `<ShowGroupCountField section={s} />`), add:

```tsx
  {
    id: "confirm-close-split",
    section: "general",
    sectionLabel: "General",
    label: "Confirm before closing a split tab",
    keywords: "confirm close tab split panels warn prompt accidental cmd w",
    render: (s) => <ConfirmCloseSplitTabField section={s} />,
  },
```

- [ ] **Step 4: Type-check gate**

Run: `npm run build`
Expected: no type errors. The toggle is reachable both in the General pane and via settings search.

Behavioral reasoning: toggling writes `confirmCloseSplitTab` through `updateSettings`, which persists to `shellboard.json` and is read back defensively by `clampSettings` (Task 1). With it off, `requestCloseTab` always closes immediately.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsDialog.tsx
git commit --author="Petr Hlozek <petr@petrhlozek.cz>" -m "feat(settings): toggle for confirm-before-closing-split-tab

Adds the 'Confirm before closing a split tab' toggle to the General
section and the settings search index.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Setting `confirmCloseSplitTab` (type + default + hydrate) → Task 1 steps 1-3. ✓
- Split-only trigger (`collectLeaves > 1`) → Task 1 step 7. ✓
- All four close paths repointed → Task 3 steps 1-5. ✓
- Panel close + bulk close unaffected → Task 1 leaves `closeTab` / `closeActivePanel` / `closeOtherTabs` / `closeTabsToRight` untouched; Task 3 explicitly leaves `panel.close` / `tab.closeOthers` / `tab.closeRight` alone. ✓
- Cancel-focused dialog, Esc/Enter/outside cancel → Task 2 (autofocus Cancel + Modal onClose). ✓
- Auto-dismiss if tab vanishes → Task 3 step 6 (`open` derived from `pendingCloseTab`). ✓
- Settings UI toggle (pane + search) → Task 4. ✓
- Not persisting `pendingCloseTabId` → it lives only in the live store; it is not added to any session/settings serializer. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `requestCloseTab` / `confirmPendingClose` / `cancelPendingClose` / `pendingCloseTabId` / `confirmCloseSplitTab` used identically across Tasks 1, 3, 4. `ConfirmDialog` prop shape defined in Task 2 matches its use in Task 3. `Toggle2` (not `Toggle`) and `FieldRow` match existing usage. ✓

**Known follow-up flagged in-plan:** Task 3 may leave `closeTab` unused in `TabBar.tsx`; steps 2/4/7 instruct removing the dead selector if `tsc` flags it.
