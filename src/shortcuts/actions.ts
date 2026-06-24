// Shared action dispatch table. Two consumers build it: the App-level keydown
// dispatcher (App.tsx wires it per keyboard shortcut) and the native-menu event
// listener (App.tsx, on `menu://action`). Registry action ids (tab.new, split.*,
// …) match shortcuts/registry.ts so the keyboard path looks them up directly; the
// extra menu-only ids (tab.duplicate, app.quit, …) are invoked only from the menu
// and are simply ignored by the keyboard loop.
//
// Handlers read fresh store state via getState(); modal-open side effects go
// through the ActionContext setters owned by App. Every handler guards on the
// relevant active id, so menu items can stay enabled and become no-ops when not
// applicable (no dynamic menu enable/disable needed).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  flushSessionSave,
  useAppStore,
} from "../store/appStore";
import { firstLeafOf } from "../utils/mosaic";
import { cwdLabel } from "../utils/path";
import { randomProjectColor } from "../components/ColorPicker";
import { bindingToAccelerator, formatBinding } from "./binding";
import { resolveBindings, SHORTCUT_ACTIONS } from "./registry";

// Last shortcuts payload sent to the native menu — skip redundant rebuilds.
let lastPushedShortcuts = "";

/** Push the user's current shortcut combos to the native menu so each item shows
 *  its key combo (right-aligned native accelerator on macOS, plain text on
 *  Linux/Windows). Sent as { menuItemId: { accel, text } } reflecting any
 *  rebindings, so the menu stays in sync after the user remaps a shortcut in
 *  Settings. Call on startup and on every keybindings change. No-op off Tauri. */
export function pushMenuShortcuts(): void {
  const resolved = resolveBindings(useAppStore.getState().settings.keybindings);
  const shortcuts: Record<string, { accel: string; text: string }> = {};
  for (const action of SHORTCUT_ACTIONS) {
    // The recent-terminal switcher (Ctrl+Tab) has no menu item.
    if (action.id === "switcher.next" || action.id === "switcher.prev") continue;
    const b = resolved[action.id];
    if (b) {
      shortcuts[`menu.${action.id}`] = {
        accel: bindingToAccelerator(b),
        text: formatBinding(b),
      };
    }
  }
  const json = JSON.stringify(shortcuts);
  if (json === lastPushedShortcuts) return;
  lastPushedShortcuts = json;
  void invoke("set_menu_shortcuts", { shortcuts }).catch(() => {
    /* off-Tauri or menu unavailable — ignore */
  });
}

/** The modal-open callbacks App owns (React state setters). */
export type ActionContext = {
  openSettings: () => void;
  openPalette: () => void;
  openAddProject: (groupId?: string | null) => void;
  openAbout: () => void;
  openGlobalSearch: () => void;
  openShortcuts: () => void;
};

// The focused panel's leaf, falling back to the first leaf in the active tab.
function activeAnchor(): string | null {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  return tab?.focusedLeafId ?? (tab?.mosaic ? firstLeafOf(tab.mosaic) : null);
}

function zoom(delta: 1 | -1 | 0): void {
  const store = useAppStore.getState();
  const current = store.settings.terminalFontSize;
  const next =
    delta === 0
      ? DEFAULT_SETTINGS.terminalFontSize
      : Math.max(
          SETTINGS_LIMITS.terminalFontSize.min,
          Math.min(SETTINGS_LIMITS.terminalFontSize.max, current + delta),
        );
  if (next !== current) void store.updateSettings({ terminalFontSize: next });
}

export function createActionHandlers(
  ctx: ActionContext,
): Record<string, () => void> {
  return {
    // ── Tabs ──
    "tab.new": () => void useAppStore.getState().addTab(),
    "tab.duplicate": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) void store.duplicateTab(store.activeTabId);
    },
    "tab.close": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) void store.closeTab(store.activeTabId);
    },
    "tab.closeOthers": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) void store.closeOtherTabs(store.activeTabId);
    },
    "tab.closeRight": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) void store.closeTabsToRight(store.activeTabId);
    },
    "tab.rename": () => {
      const store = useAppStore.getState();
      store.requestTabRename(store.activeTabId);
    },
    "tab.next": () => useAppStore.getState().nextTab(),
    "tab.prev": () => useAppStore.getState().prevTab(),

    // ── Panels / splits / focus ──
    "panel.close": () => void useAppStore.getState().closeActivePanel(),
    "split.vertical": () =>
      void useAppStore.getState().splitActiveTerminal("row"),
    "split.horizontal": () =>
      void useAppStore.getState().splitActiveTerminal("column"),
    "split.left": () => {
      const a = activeAnchor();
      if (a) void useAppStore.getState().splitPanel(a, "left");
    },
    "split.right": () => {
      const a = activeAnchor();
      if (a) void useAppStore.getState().splitPanel(a, "right");
    },
    "split.up": () => {
      const a = activeAnchor();
      if (a) void useAppStore.getState().splitPanel(a, "up");
    },
    "split.down": () => {
      const a = activeAnchor();
      if (a) void useAppStore.getState().splitPanel(a, "down");
    },
    "focus.left": () => useAppStore.getState().moveFocus("left"),
    "focus.right": () => useAppStore.getState().moveFocus("right"),
    "focus.up": () => useAppStore.getState().moveFocus("up"),
    "focus.down": () => useAppStore.getState().moveFocus("down"),

    // ── Terminal ──
    "search.terminal": () => {
      const store = useAppStore.getState();
      const tab = store.tabs.find((t) => t.id === store.activeTabId);
      if (tab?.focusedLeafId) store.setSearchingTerminal(tab.focusedLeafId);
    },
    "search.global": () => ctx.openGlobalSearch(),
    "zoom.in": () => zoom(1),
    "zoom.out": () => zoom(-1),
    "zoom.reset": () => zoom(0),
    "broadcast.toggle": () => {
      const store = useAppStore.getState();
      if (store.activeTabId) store.toggleBroadcast(store.activeTabId);
    },

    // ── Projects ──
    "project.add": () => ctx.openAddProject(null),
    // Quick-add the focused terminal's cwd as an ungrouped project. Caption
    // shows `parent/basename` and tracks cwd via OSC 7.
    "project.quickAdd": () => {
      const store = useAppStore.getState();
      const leafId = activeAnchor();
      const cwd = leafId ? store.terminals[leafId]?.cwd : undefined;
      if (!cwd) return;
      void (async () => {
        const project = await store.addProject({
          path: cwd,
          name: cwdLabel(cwd),
          color: randomProjectColor(),
          autoCwdName: true,
        });
        await store.openProject(project.id);
      })();
    },

    // ── App / chrome ──
    "sidebar.toggle": () => void useAppStore.getState().toggleSidebar(),
    "settings.open": () => ctx.openSettings(),
    "palette.open": () => ctx.openPalette(),
    "app.about": () => ctx.openAbout(),
    "help.shortcuts": () => ctx.openShortcuts(),
    // Bridge to TopBar's chrome light/dark toggle without lifting its localStorage
    // / per-mode logic out of the component (TopBar listens for this event).
    "theme.toggle": () =>
      window.dispatchEvent(new CustomEvent("shellboard:toggle-chrome-theme")),
    // Flush the debounced session save before tearing the window down, mirroring
    // the onCloseRequested path so a menu Quit can't lose in-flight state.
    "app.quit": () => {
      void (async () => {
        try {
          await flushSessionSave();
        } catch {
          /* don't block quit on save failure */
        }
        await getCurrentWebviewWindow().destroy();
      })();
    },
  };
}
