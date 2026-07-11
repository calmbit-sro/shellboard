# Reopen Closed Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd/Ctrl+Shift+T reopens the most recently closed tab (layout + cwds + scrollback); duplicateTab replicates the full split layout.

**Architecture:** Session-only `closedTabs` stack in the zustand store, captured in `closeTab` via `tabToPersisted` and replayed via `buildMosaicFromLayout` + `restoredBuffers` — the exact machinery lazy project restore already uses.

**Tech Stack:** React 19 + TS (zustand), Rust menu items.

Spec: `docs/superpowers/specs/2026-07-11-reopen-closed-tab-design.md`

## Global Constraints

- Stack cap: 10 entries, session-only, never persisted.
- Reopened tab gets a **fresh** tab id.
- Spawn-failure handling mirrors lazy restore: kill spawned PTYs, restore the stack entry, `showError(spawnErrorMessage(e))`.
- Verification gate: `npm run build`; `cargo check` for lib.rs.
- Commits authored `--author="Petr Hlozek <petr@petrhlozek.cz>"` + Claude trailer.

---

### Task 1: closedTabs stack + reopen action + duplicateTab fix (store)

**Files:**
- Modify: `src/store/appStore.ts`

**Interfaces:**
- Produces: `ClosedTab` type; state `closedTabs: ClosedTab[]`; actions `reopenClosedTab(): Promise<void>` (consumed by Task 2), capture in `closeTab`, prune in `removeProject`, rewritten `duplicateTab`.
- Consumes: `tabToPersisted`, `mosaicToLayout`, `buildMosaicFromLayout` from `../utils/sessionSerialize` (add `tabToPersisted`, `mosaicToLayout` to the existing import), `flushAllWrites`, `spawnTerminal`, `killTerminal`, `spawnErrorMessage`, `uuid`, `firstLeafOf`.

- [ ] **Step 1: Type + state.** Next to the `Tab` type:

```ts
/** A tab captured at close time for Cmd/Ctrl+Shift+T reopen. Session-only —
 * the stack is never persisted. Buffers hold the serialized scrollback of
 * each leaf (up to MAX_BUFFER_CHARS each), so the cap keeps memory bounded. */
export type ClosedTab = {
  projectId: string;
  tab: PersistedTab;
  buffers: Record<string, string>;
  closedAt: number;
};
```

`AppState`: add `closedTabs: ClosedTab[];` and `reopenClosedTab: () => Promise<void>;`. Initial state: `closedTabs: [],`. Near `RECENT_CAP` add `const CLOSED_TABS_CAP = 10;`.

- [ ] **Step 2: Capture in `closeTab`.** Immediately after the `if (!tab) return;` guard (before PTYs are killed):

```ts
    // Capture the tab for reopen-closed-tab before its PTYs die. Serialized
    // through the same dirty-cache-backed path session save uses; flush
    // xterm write queues first so the snapshot has the final output.
    if (tab.mosaic) {
      try {
        await flushAllWrites();
      } catch {
        /* non-fatal — serialize what we have */
      }
      const buffers: Record<string, string> = {};
      const persisted = tabToPersisted(tab, terminals, buffers);
      if (persisted) {
        set((state) => ({
          closedTabs: [
            ...state.closedTabs,
            {
              projectId: tab.projectId,
              tab: persisted,
              buffers,
              closedAt: Date.now(),
            },
          ].slice(-CLOSED_TABS_CAP),
        }));
      }
    }
```

- [ ] **Step 3: `reopenClosedTab` action** (place after `duplicateTab`):

```ts
  reopenClosedTab: async () => {
    // Newest entry whose project still exists; stale entries (project was
    // deleted meanwhile, e.g. an ephemeral quick-add project) drop out.
    const projects = get().projects;
    const rest = [...get().closedTabs];
    let entry: ClosedTab | undefined;
    while (rest.length > 0) {
      const candidate = rest.pop()!;
      if (projects.some((p) => p.id === candidate.projectId)) {
        entry = candidate;
        break;
      }
    }
    set({ closedTabs: rest });
    if (!entry) return;
    const picked = entry;
    const project = projects.find((p) => p.id === picked.projectId)!;

    const newTerminals: Record<string, TerminalSession> = {};
    const restoredBuffers: Record<string, string> = {};
    let mosaic: MosaicNode<string>;
    try {
      mosaic = await buildMosaicFromLayout(
        picked.tab.layout,
        picked.buffers,
        async (cwd, buffer) => {
          const s = get().settings;
          const effectiveCwd = cwd || project.path;
          const terminalId = await spawnTerminal(
            effectiveCwd,
            s.autoCwdTracking,
            s.shellPath,
            s.shellArgs,
          );
          newTerminals[terminalId] = { id: terminalId, cwd: effectiveCwd };
          if (buffer) restoredBuffers[terminalId] = buffer;
          return terminalId;
        },
      );
    } catch (e) {
      // Out of PTYs — kill what did spawn, put the entry back for a retry.
      for (const id of Object.keys(newTerminals)) await killTerminal(id);
      set((state) => ({ closedTabs: [...state.closedTabs, picked] }));
      get().showError(spawnErrorMessage(e));
      return;
    }

    const newTab: Tab = {
      id: uuid(),
      title: picked.tab.title,
      customTitle: picked.tab.customTitle,
      mosaic,
      focusedLeafId: firstLeafOf(mosaic),
      projectId: picked.projectId,
      hasUnread: false,
      hasFailed: false,
      broadcastInput: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      terminals: { ...state.terminals, ...newTerminals },
      restoredBuffers: { ...state.restoredBuffers, ...restoredBuffers },
    }));
    if (get().activeProjectId !== picked.projectId) {
      await get().setActiveProject(picked.projectId);
    }
    get().setActiveTab(newTab.id);
  },
```

- [ ] **Step 4: Prune in `removeProject`.** In the big `set({...})` inside `removeProject`, add `closedTabs: get().closedTabs.filter((c) => c.projectId !== id),` (match the surrounding style — if the set uses computed locals, compute a `remainingClosedTabs` local).

- [ ] **Step 5: Rewrite `duplicateTab`:**

```ts
  duplicateTab: async (tabId) => {
    const { tabs, terminals } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !tab.mosaic) return;
    const project = get().projects.find((p) => p.id === tab.projectId);
    if (!project) return;

    // Replicate the full split layout with fresh shells in the same cwds.
    // Scrollback is intentionally not copied — the buffer sink is discarded
    // and buildMosaicFromLayout finds no buffer for any leaf.
    const layout = mosaicToLayout(tab.mosaic, terminals, {});
    const newTerminals: Record<string, TerminalSession> = {};
    let mosaic: MosaicNode<string>;
    try {
      mosaic = await buildMosaicFromLayout(layout, {}, async (cwd) => {
        const s = get().settings;
        const effectiveCwd = cwd || project.path;
        const terminalId = await spawnTerminal(
          effectiveCwd,
          s.autoCwdTracking,
          s.shellPath,
          s.shellArgs,
        );
        newTerminals[terminalId] = { id: terminalId, cwd: effectiveCwd };
        return terminalId;
      });
    } catch (e) {
      for (const id of Object.keys(newTerminals)) await killTerminal(id);
      get().showError(spawnErrorMessage(e));
      return;
    }

    const tabsInProject = get().tabs.filter(
      (t) => t.projectId === tab.projectId,
    ).length;
    const newTab: Tab = {
      id: uuid(),
      title: tab.customTitle
        ? tab.title
        : `${project.name} ${tabsInProject + 1}`,
      customTitle: tab.customTitle,
      mosaic,
      focusedLeafId: firstLeafOf(mosaic),
      projectId: tab.projectId,
      hasUnread: false,
      hasFailed: false,
      broadcastInput: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      terminals: { ...state.terminals, ...newTerminals },
    }));
    get().setActiveTab(newTab.id);
  },
```

- [ ] **Step 6: Imports.** Extend the sessionSerialize import with `mosaicToLayout, tabToPersisted`. `MosaicNode` type is already imported.

- [ ] **Step 7: Verify + commit.**

```bash
npm run build
git add src/store/appStore.ts
git commit -m "feat(tabs): closed-tab stack with scrollback capture; duplicate replicates splits"
```

---

### Task 2: Shortcut + menu

**Files:**
- Modify: `src/shortcuts/registry.ts` (Tabs, after `panel.close`)
- Modify: `src/shortcuts/actions.ts`
- Modify: `src-tauri/src/lib.rs` (both accel maps + tab menu item next to `menu.tab.close`)

**Interfaces:** consumes `reopenClosedTab` from Task 1; produces action id `tab.reopen`, menu id `menu.tab.reopen`.

- [ ] **Step 1: Registry** (after the `panel.close` entry):

```ts
  {
    id: "tab.reopen",
    category: "Tabs",
    label: "Reopen closed tab",
    defaultBinding: primary({ shift: true, key: "t" }),
  },
```

- [ ] **Step 2: Handler** in `createActionHandlers` (after `"tab.close"`):

```ts
    "tab.reopen": () => void useAppStore.getState().reopenClosedTab(),
```

- [ ] **Step 3: Menu.** lib.rs accel maps: `"menu.tab.reopen" => "CmdOrCtrl+Shift+T",` (macOS) and `"menu.tab.reopen" => "Ctrl+Shift+T",` (linux map). Add a menu item `.item(&shortcut_item(h, "menu.tab.reopen", "Reopen Closed Tab", shortcuts)?)` directly after the `menu.tab.close` item (find with `grep -n "menu.tab.close" src-tauri/src/lib.rs`).

- [ ] **Step 4: Verify + commit.**

```bash
npm run build && cd src-tauri && cargo check && cd ..
git add src/shortcuts/registry.ts src/shortcuts/actions.ts src-tauri/src/lib.rs
git commit -m "feat(shortcuts): reopen closed tab with Cmd+Shift+T"
```

## Self-review notes

- Spec coverage: capture+stack+reopen (T1 steps 1-4), duplicateTab (T1 step 5), shortcut/menu (T2). Stale-project skip is in `reopenClosedTab`'s pop loop; quick-add ephemeral projects covered by the same check.
- `picked` local avoids TS narrowing loss of `entry` inside closures.
- `closeTab` destructures `terminals` already — capture uses it before kill; `tabToPersisted` copies snapshots into the entry's own `buffers` object, so `dropTerminalBuffer` in `killTerminal` can't invalidate them.
