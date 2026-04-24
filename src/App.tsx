import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalHost } from "./components/TerminalHost";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { AddProjectFlow } from "./components/AddProjectFlow";
import { AboutDialog } from "./components/AboutDialog";
import { StatusBar } from "./components/StatusBar";
import { GlobalSearch } from "./components/GlobalSearch";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
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
import { getTerminal } from "./utils/terminalRegistry";
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
            await useAppStore.getState().restoreSession(session, buffers);
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // `?` opens the shortcut cheat sheet — skip when the user is typing
      // into an input / editable element.
      if (e.key === "?" && !isEditable(e.target)) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // App shortcuts use Cmd on macOS and Ctrl on Linux/Windows — NOT both.
      // Leaving plain Ctrl to the shell (Ctrl+W = delete word, Ctrl+T =
      // transpose chars, etc.) is the convention used by iTerm2, Alacritty,
      // Warp. On Linux/Windows the Cmd key doesn't exist, so we rely on
      // Ctrl and accept the (rare) conflict with terminal bindings.
      const mod = IS_MAC
        ? e.metaKey && !e.ctrlKey
        : e.ctrlKey && !e.metaKey;
      if (!mod) return;
      const store = useAppStore.getState();

      if ((e.key === "w" || e.key === "W") && e.shiftKey && !e.altKey) {
        e.preventDefault();
        void store.closeActivePanel();
        return;
      }
      if ((e.key === "w" || e.key === "W") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (store.activeTabId) void store.closeTab(store.activeTabId);
        return;
      }

      if ((e.key === "d" || e.key === "D") && e.shiftKey && !e.altKey) {
        e.preventDefault();
        void store.splitActiveTerminal("column");
        return;
      }
      if ((e.key === "d" || e.key === "D") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void store.splitActiveTerminal("row");
        return;
      }

      if ((e.key === "t" || e.key === "T") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void store.addTab();
        return;
      }

      // Cmd/Ctrl+, — open settings
      if (e.key === "," && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      // Cmd/Ctrl+Shift+P — open command palette
      if ((e.key === "p" || e.key === "P") && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Cmd/Ctrl+B — toggle sidebar
      if ((e.key === "b" || e.key === "B") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void store.toggleSidebar();
        return;
      }

      // Cmd/Ctrl+K — clear focused terminal (scrollback preserved).
      if ((e.key === "k" || e.key === "K") && !e.shiftKey && !e.altKey) {
        const tab = store.tabs.find((t) => t.id === store.activeTabId);
        const leafId = tab?.focusedLeafId;
        if (leafId) {
          e.preventDefault();
          getTerminal(leafId)?.clear();
        }
        return;
      }

      // Cmd/Ctrl+= / Cmd/Ctrl+- — zoom terminal font size up/down.
      // Cmd/Ctrl+0 — reset.
      if (!e.shiftKey && !e.altKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          const current = store.settings.terminalFontSize;
          const next = Math.min(
            SETTINGS_LIMITS.terminalFontSize.max,
            current + 1,
          );
          if (next !== current) void store.updateSettings({ terminalFontSize: next });
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          const current = store.settings.terminalFontSize;
          const next = Math.max(
            SETTINGS_LIMITS.terminalFontSize.min,
            current - 1,
          );
          if (next !== current) void store.updateSettings({ terminalFontSize: next });
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          void store.updateSettings({
            terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
          });
          return;
        }
      }

      // Cmd/Ctrl+Shift+F — global search across all terminals
      if ((e.key === "f" || e.key === "F") && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setGlobalSearchOpen(true);
        return;
      }

      // Cmd/Ctrl+F — open terminal search on the focused panel
      if ((e.key === "f" || e.key === "F") && !e.shiftKey && !e.altKey) {
        const tab = store.tabs.find((t) => t.id === store.activeTabId);
        const leafId = tab?.focusedLeafId;
        if (leafId) {
          e.preventDefault();
          store.setSearchingTerminal(leafId);
        }
        return;
      }

      if (e.altKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          store.moveFocus("left");
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          store.moveFocus("right");
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          store.moveFocus("up");
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          store.moveFocus("down");
          return;
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) store.prevTab();
        else store.nextTab();
        return;
      }

      if (e.shiftKey && (e.key === "]" || e.code === "BracketRight")) {
        e.preventDefault();
        store.nextTab();
        return;
      }
      if (e.shiftKey && (e.key === "[" || e.code === "BracketLeft")) {
        e.preventDefault();
        store.prevTab();
        return;
      }

      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        store.activateTabByIndex(parseInt(e.key, 10) - 1);
        return;
      }
    }

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <div className="app">
      {sidebarVisible && (
        <Sidebar
          onOpenSettings={() => setSettingsOpen(true)}
          onAddProject={() => setAddProjectOpen(true)}
        />
      )}
      <main className="app__main">
        <TabBar />
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
        onClose={() => setAddProjectOpen(false)}
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
    </div>
  );
}

export default App;
