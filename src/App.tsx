import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { TabBar } from "./components/TabBar";
import { TerminalHost } from "./components/TerminalHost";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { AddProjectFlow } from "./components/AddProjectFlow";
import { AboutDialog } from "./components/AboutDialog";
import { StatusBar } from "./components/StatusBar";
import { GlobalSearch } from "./components/GlobalSearch";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { RecentSwitcher } from "./components/RecentSwitcher";
import {
  bindingMods,
  matchBinding,
  shortcutCapture,
} from "./shortcuts/binding";
import { resolveBindings, SHORTCUT_ACTIONS } from "./shortcuts/registry";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  enableSessionAutosave,
  flushSessionSave,
  useAppStore,
  type Project,
  type ProjectGroup,
  type Settings,
} from "./store/appStore";
import {
  loadBuffers,
  loadPersisted,
  loadSession,
  PersistenceKeys,
} from "./utils/persistence";
import { findTheme } from "./utils/themes";
import { firstLeafOf } from "./utils/mosaic";
import { randomProjectColor } from "./components/ColorPicker";
import { cwdLabel } from "./utils/path";
import { checkForUpdate } from "./utils/updateCheck";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "./store/appStore";
import "./App.css";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);


function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // xterm.js renders a hidden <textarea> inside its container for input;
  // typing in the terminal triggers keydown with that textarea as target.
  if (target.closest(".xterm")) return true;
  return false;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function mixHex(a: string, b: string, tWeight: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const t = Math.max(0, Math.min(1, tWeight));
  const r = Math.round(ar * (1 - t) + br * t);
  const g = Math.round(ag * (1 - t) + bg * t);
  const bl = Math.round(ab * (1 - t) + bb * t);
  return `#${[r, g, bl]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")}`;
}

function App() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projectCount = useAppStore((s) => s.projects.length);
  const uiFontSize = useAppStore((s) => s.settings.uiFontSize);
  const themeId = useAppStore((s) => s.settings.terminalTheme);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const initRan = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // When the add-project flow is launched from a group's context menu we
  // pre-select that group in the form. null means "No group" / fall-back.
  const [addProjectGroupId, setAddProjectGroupId] = useState<string | null>(
    null,
  );
  const [aboutOpen, setAboutOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Mirror modal-open state into a ref so the stable (empty-deps) keydown
  // handler can tell whether a dialog is up without re-subscribing. Used to
  // suppress the recent-terminal switcher overlay while a modal is focused.
  const modalOpenRef = useRef(false);
  modalOpenRef.current =
    settingsOpen ||
    paletteOpen ||
    addProjectOpen ||
    aboutOpen ||
    globalSearchOpen ||
    shortcutsOpen;

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ui-font-size",
      `${uiFontSize}px`,
    );
  }, [uiFontSize]);

  // Force-flush the session save when the user closes the window, so a
  // debounced save doesn't get lost when the process terminates (e.g.
  // on Cmd+Q). preventDefault first, await the flush, then destroy.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlistenPromise = win.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await flushSessionSave();
      } catch {
        /* don't block close on save failure */
      }
      await win.destroy();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Align the chrome (sidebar, tab bar, main background) with the terminal
  // theme colors so the whole window looks cohesive when the theme changes.
  // We compute the lifted / darkened variants in JS and push them as plain
  // hex values — mixing inside var() is unreliable across webview versions.
  useEffect(() => {
    const t = findTheme(themeId).theme;
    const bg = t.background ?? "#1e1e1e";
    const fg = t.foreground ?? "#d4d4d4";
    const root = document.documentElement.style;
    root.setProperty("--theme-bg", bg);
    root.setProperty("--theme-fg", fg);
    root.setProperty("--theme-chrome", mixHex(bg, "#ffffff", 0.12));
    root.setProperty("--theme-border", mixHex(bg, "#000000", 0.3));
  }, [themeId]);

  useEffect(() => {
    if (initRan.current) return;
    initRan.current = true;
    (async () => {
      try {
        const [
          projects,
          groups,
          sidebarWidth,
          sidebarVisibleSaved,
          settings,
          session,
          buffers,
        ] = await Promise.all([
          loadPersisted<Project[]>(PersistenceKeys.projects).catch(() => null),
          loadPersisted<ProjectGroup[]>(PersistenceKeys.groups).catch(
            () => null,
          ),
          loadPersisted<number>(PersistenceKeys.sidebarWidth).catch(() => null),
          loadPersisted<boolean>(PersistenceKeys.sidebarVisible).catch(
            () => null,
          ),
          loadPersisted<Partial<Settings>>(PersistenceKeys.settings).catch(
            () => null,
          ),
          loadSession().catch(() => null),
          loadBuffers().catch(() => ({}) as Record<string, string>),
        ]);
        const store = useAppStore.getState();
        store.hydrate({
          projects: projects ?? [],
          groups: groups ?? [],
          sidebarWidth: sidebarWidth ?? undefined,
          sidebarVisible: sidebarVisibleSaved ?? undefined,
          settings: settings ?? undefined,
        });

        let didRestore = false;
        if (session && Object.keys(session.tabsByProject).length > 0) {
          try {
            // Honor the user's scrollback persistence preference: when off,
            // ignore any buffers that may still exist on disk so restored
            // terminals come back empty.
            const effectiveBuffers = useAppStore.getState().settings
              .persistScrollback
              ? buffers
              : ({} as Record<string, string>);
            await useAppStore
              .getState()
              .restoreSession(session, effectiveBuffers);
            didRestore = true;
          } catch (err) {
            // A malformed session.json shouldn't leave the user with a blank
            // window — log and continue with a fresh state.
            console.error("restoreSession failed:", err);
          }
        }

        const fresh = useAppStore.getState();
        if (fresh.projects.length > 0 && !fresh.activeProjectId) {
          await fresh.setActiveProject(fresh.projects[0].id);
        }

        // Defer autosave when we've restored a session. Shell startup emits
        // a burst of data (and sometimes a scrollback-clear) that, if saved
        // immediately, would overwrite the good session.json with a nearly
        // empty buffer. Cmd+Q still flushes via onCloseRequested; this only
        // blocks the debounced autosave.
        if (didRestore) {
          setTimeout(() => enableSessionAutosave(), 3000);
        } else {
          enableSessionAutosave();
        }
      } catch (err) {
        console.error("startup failed:", err);
        enableSessionAutosave();
      }
    })();
  }, []);

  // Update check — fires once per launch, ~5s after boot, only when the
  // user opted in. Result lands in the store; StatusBar reads it.
  useEffect(() => {
    const handle = setTimeout(() => {
      const s = useAppStore.getState();
      if (!s.settings.checkForUpdatesOnStartup) return;
      void checkForUpdate()
        .then((info) => {
          if (info) useAppStore.getState().setUpdateInfo(info);
        })
        .catch(() => {
          /* network or parse failure — silent */
        });
    }, 5000);
    return () => clearTimeout(handle);
  }, []);

  useEffect(() => {
    // The active panel's leaf, falling back to the first leaf in the tab.
    function activeAnchor(): string | null {
      const store = useAppStore.getState();
      const tab = store.tabs.find((t) => t.id === store.activeTabId);
      return (
        tab?.focusedLeafId ?? (tab?.mosaic ? firstLeafOf(tab.mosaic) : null)
      );
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

    // One handler per registry action id. The registry owns ids / labels /
    // default bindings; behavior lives here. Handlers read fresh store state
    // via getState() and may use the (stable) dialog-open setters. The two
    // switcher ids are handled specially in onKey, not via this map.
    const handlers: Record<string, () => void> = {
      "tab.new": () => void useAppStore.getState().addTab(),
      "tab.close": () => {
        const store = useAppStore.getState();
        if (store.activeTabId) void store.closeTab(store.activeTabId);
      },
      "panel.close": () => void useAppStore.getState().closeActivePanel(),
      "tab.next": () => useAppStore.getState().nextTab(),
      "tab.prev": () => useAppStore.getState().prevTab(),
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
      "search.terminal": () => {
        const store = useAppStore.getState();
        const tab = store.tabs.find((t) => t.id === store.activeTabId);
        if (tab?.focusedLeafId) store.setSearchingTerminal(tab.focusedLeafId);
      },
      "search.global": () => setGlobalSearchOpen(true),
      "zoom.in": () => zoom(1),
      "zoom.out": () => zoom(-1),
      "zoom.reset": () => zoom(0),
      // Cmd/Ctrl+N — quick-add the focused terminal's cwd as an ungrouped
      // project. Caption shows `parent/basename` and tracks cwd via OSC 7.
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
      "sidebar.toggle": () => void useAppStore.getState().toggleSidebar(),
      "settings.open": () => setSettingsOpen(true),
      "palette.open": () => setPaletteOpen(true),
    };

    function onKey(e: KeyboardEvent) {
      // A ShortcutInput is recording a combo — stand down entirely so the
      // captured keys don't also trigger their action.
      if (shortcutCapture.isActive()) return;

      // `?` opens the shortcut cheat sheet — non-modifier, skip when typing.
      if (e.key === "?" && !isEditable(e.target)) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      const resolved = resolveBindings(
        useAppStore.getState().settings.keybindings,
      );

      // Recent-terminal switcher (alt-tab). Open on first press, step on
      // repeats while held. Suppressed while a modal is up so the overlay
      // never stacks over a dialog.
      if (!modalOpenRef.current) {
        for (const dir of ["next", "prev"] as const) {
          const b = resolved[`switcher.${dir}`];
          if (b && matchBinding(e, b)) {
            e.preventDefault();
            const store = useAppStore.getState();
            if (store.switcher) store.stepSwitcher(dir);
            else store.openSwitcher(dir, bindingMods(b));
            return;
          }
        }
      }

      // While cycling, Escape cancels and every other key is swallowed so a
      // stray combo can't fire mid-cycle. The actual commit is on key release.
      if (useAppStore.getState().switcher) {
        if (e.key === "Escape") {
          e.preventDefault();
          useAppStore.getState().cancelSwitcher();
        }
        return;
      }

      // Generic registry dispatch — first action whose binding matches wins.
      for (const action of SHORTCUT_ACTIONS) {
        if (action.id === "switcher.next" || action.id === "switcher.prev") {
          continue;
        }
        const b = resolved[action.id];
        if (b && matchBinding(e, b)) {
          const handler = handlers[action.id];
          if (handler) {
            e.preventDefault();
            handler();
          }
          return;
        }
      }

      // Fixed (non-rebindable) accelerators. Cmd on macOS / Ctrl elsewhere.
      const mod = IS_MAC
        ? e.metaKey && !e.ctrlKey
        : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey) return;
      // Cmd/Ctrl+Shift+P — command palette alias (Cmd/Ctrl+K is editable).
      if (e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Cmd/Ctrl+1..9 — jump to tab N within the active project.
      if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        useAppStore
          .getState()
          .activateTabByIndex(parseInt(e.code.slice(5), 10) - 1);
        return;
      }
    }

    // Commit the switcher when the user releases its modifier(s).
    function onKeyUp(e: KeyboardEvent) {
      const store = useAppStore.getState();
      const sw = store.switcher;
      if (!sw) return;
      const stillHeld =
        (sw.mods.meta && e.metaKey) ||
        (sw.mods.ctrl && e.ctrlKey) ||
        (sw.mods.alt && e.altKey);
      if (!stillHeld) store.commitSwitcher();
    }

    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, []);

  return (
    <div className="app">
      <TopBar onOpenPalette={() => setPaletteOpen(true)} />
      <div className="app__body">
        {sidebarVisible && (
          <Sidebar
            onOpenSettings={() => setSettingsOpen(true)}
            onAddProject={(groupId) => {
              setAddProjectGroupId(groupId ?? null);
              setAddProjectOpen(true);
            }}
          />
        )}
        <main className="app__main">
          <TabBar onOpenGlobalSearch={() => setGlobalSearchOpen(true)} />
          <TerminalHost />
          {!activeProjectId && (
            <div className="app__empty">
              {projectCount === 0
                ? "No projects yet. Click + in the sidebar to add one."
                : "Select a project from the sidebar."}
            </div>
          )}
          <StatusBar onOpenShortcuts={() => setShortcutsOpen(true)} />
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenAbout={() => {
          setSettingsOpen(false);
          setAboutOpen(true);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => {
          setPaletteOpen(false);
          setSettingsOpen(true);
        }}
        onAddProject={() => {
          setPaletteOpen(false);
          setAddProjectGroupId(null);
          setAddProjectOpen(true);
        }}
        onOpenAbout={() => {
          setPaletteOpen(false);
          setAboutOpen(true);
        }}
        onOpenGlobalSearch={() => {
          setPaletteOpen(false);
          setGlobalSearchOpen(true);
        }}
        onOpenShortcuts={() => {
          setPaletteOpen(false);
          setShortcutsOpen(true);
        }}
      />
      <AddProjectFlow
        open={addProjectOpen}
        onClose={() => {
          setAddProjectOpen(false);
          setAddProjectGroupId(null);
        }}
        initialGroupId={addProjectGroupId}
      />
      <AboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
      />
      <GlobalSearch
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <RecentSwitcher />
    </div>
  );
}

export default App;
