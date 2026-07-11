import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { MosaicDirection, MosaicNode } from "react-mosaic-component";
import {
  collectLeaves,
  findNeighborLeaf,
  findSiblingLeaf,
  firstLeafOf,
  removeLeaf,
  replaceLeaf,
  type FocusDir,
} from "../utils/mosaic";
import {
  saveBuffers,
  saveGroups,
  saveProjects,
  saveSession,
  saveSettings,
  saveSidebarVisible,
  saveSidebarWidth,
} from "../utils/persistence";
import {
  buildMosaicFromLayout,
  collectLeafBufferIds,
  serializeSession,
  type PersistedSession,
  type PersistedTab,
} from "../utils/sessionSerialize";
import { flushAllWrites } from "../utils/terminalRegistry";
import { DEFAULT_THEME_ID, findTheme } from "../utils/themes";
import { isValidBinding, type Binding } from "../shortcuts/binding";
import { isKnownActionId } from "../shortcuts/registry";

export type TerminalSession = {
  id: string;
  cwd: string;
};

export type Tab = {
  id: string;
  title: string;
  /** True once the user has renamed this tab manually. Suppresses the
   * automatic retitling that happens when the parent project is renamed. */
  customTitle: boolean;
  mosaic: MosaicNode<string> | null;
  focusedLeafId: string | null;
  projectId: string; // Every tab belongs to a project. Invariant.
  /** Session-only flag (not persisted): PTY output arrived while tab was
   * inactive. Cleared when the tab becomes active. */
  hasUnread: boolean;
  /** When true, keystrokes typed into any panel in this tab are fanned out
   * to all panels. Useful for multi-server admin. */
  broadcastInput: boolean;
};

export type Snippet = {
  id: string;
  name: string;
  command: string;
  /**
   * When true (or undefined, for back-compat), inserting the snippet also
   * sends Enter so the command runs immediately. When false, the command text
   * is pasted at the prompt without executing, so the user can edit it first.
   */
  runAfterPaste?: boolean;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  color: string;
  createdAt: number;
  /** null = ungrouped (rendered at the top of the sidebar). */
  groupId: string | null;
  /** Optional per-project command palette; not present on older configs. */
  snippets?: Snippet[];
  /** When true, the sidebar caption tracks the active tab's focused-leaf
   * cwd as `../<basename>` instead of using `name`. Set automatically
   * for projects created via the Cmd/Ctrl+N quick-add shortcut, and
   * cleared as soon as the user renames the project manually. */
  autoCwdName?: boolean;
};

export type ProjectGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  /** Optional user-set icon (emoji or single grapheme) rendered in place
   * of the default folder glyph. Absent on older configs. */
  icon?: string;
};

export type AddTabOptions = {
  projectId?: string;
  cwd?: string;
};

export type Settings = {
  terminalFontFamily: string;
  terminalFontSize: number;
  uiFontSize: number;
  terminalTheme: string;
  autoCwdTracking: boolean;
  scrollback: number;
  /** Empty string = use $SHELL env (the system default). */
  shellPath: string;
  /** Empty string = auto (-l for known POSIX shells); otherwise space-separated. */
  shellArgs: string;
  /** Hit GitHub Releases on startup to surface a newer version in the
   * status bar. Off = no network calls. */
  checkForUpdatesOnStartup: boolean;
  /** Snapshot xterm scrollback to buffers.json so session restore can
   * replay it. Off = nothing is written and existing buffers are cleared
   * on toggle; restored sessions come back with empty terminals. */
  persistScrollback: boolean;
  /** Show the 22px panel header above each terminal split (shell · cwd ·
   * running indicator). Toggle off for absolute-minimum chrome. */
  showPanelHeader: boolean;
  /** Show the project-count badge next to each group header in the
   * sidebar. Off = the chip is hidden, name takes the freed space. */
  showGroupCount: boolean;
  /** Pop a confirmation dialog before closing a tab that contains a split
   * (2+ terminals). Single-terminal tabs always close immediately. Off =
   * never prompt. */
  confirmCloseSplitTab: boolean;
  /** Pop a confirmation dialog before the app quits (Cmd+Q or closing the
   * window). Off = quit immediately. */
  confirmBeforeQuitting: boolean;
  /** User keyboard-shortcut overrides, keyed by action id (see
   * src/shortcuts/registry.ts). Only overrides are stored; any id absent here
   * falls back to its default binding. Unknown ids are dropped on load. */
  keybindings: Record<string, Binding>;
};

export const DEFAULT_SETTINGS: Settings = {
  terminalFontFamily:
    'Menlo, Monaco, "Cascadia Code", "Fira Code", Consolas, "Liberation Mono", monospace',
  terminalFontSize: 13,
  uiFontSize: 12,
  terminalTheme: DEFAULT_THEME_ID,
  autoCwdTracking: false,
  scrollback: 5000,
  shellPath: "",
  shellArgs: "",
  checkForUpdatesOnStartup: true,
  persistScrollback: true,
  showPanelHeader: true,
  showGroupCount: true,
  confirmCloseSplitTab: true,
  confirmBeforeQuitting: true,
  keybindings: {},
};

export const SETTINGS_LIMITS = {
  terminalFontSize: { min: 8, max: 32 },
  uiFontSize: { min: 10, max: 20 },
  scrollback: { min: 500, max: 100000 },
} as const;

/** Terminals past this count use a lot of RAM (each keeps a live xterm
 * scrollback buffer) and approach the system PTY ceiling. Drives the proactive
 * spawn warning and the orange "high usage" nudge in the Running-apps modal. */
export const HIGH_TERMINAL_COUNT = 40;

export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 360;

type AppState = {
  tabs: Tab[];
  activeTabId: string | null;
  activeProjectId: string | null;
  /** Per-project memory of the most recently active tab, keyed by projectId. */
  lastActiveTabByProject: Record<string, string>;
  terminals: Record<string, TerminalSession>;
  projects: Project[];
  groups: ProjectGroup[];
  sidebarWidth: number;
  sidebarVisible: boolean;
  settings: Settings;
  /** When non-null, the TabBar should put this tab into inline-rename mode. */
  renamingTabId: string | null;
  /** When non-null, the ProjectList should put this project into inline-rename mode. */
  renamingProjectId: string | null;
  /** When non-null, the GroupHeader should put this group into inline-rename mode. */
  renamingGroupId: string | null;
  /** When non-null, the ProjectList should open the snippets dialog for this project. */
  snippetsDialogProjectId: string | null;
  /** When non-null, App renders the close-tab confirmation dialog for this
   * tab (set only for split tabs when confirmCloseSplitTab is on). */
  pendingCloseTabId: string | null;
  /** When non-null, App renders the "close idle terminals" confirmation for
   * these tabs (computed from the Running-apps snapshot). Session-only. */
  pendingCullTabIds: string[] | null;
  /** When true, App renders the "Quit Shellboard?" confirmation (set only when
   * confirmBeforeQuitting is on). Session-only. */
  pendingQuit: boolean;
  /** When non-null, the matching Terminal should show its search overlay. */
  searchingTerminalId: string | null;
  /** Scrollback snapshots keyed by the new terminal id after session
   * restore. A Terminal consumes (and removes) its entry on mount so old
   * buffer content lands in the fresh xterm before PTY data flows in. */
  restoredBuffers: Record<string, string>;
  /** Lazy-load: persisted tabs of projects that haven't been activated
   * since startup. Spawned only when the user picks the project in the
   * sidebar. Drained per project; what's still in here at session save
   * time gets merged back into session.json so unactivated projects
   * don't lose their layout across launches. */
  pendingProjectRestores: Record<string, PersistedTab[]>;
  /** bufferId → snapshot, for buffers referenced by pendingProjectRestores
   * tabs. Lookup happens during the lazy spawn; entries are dropped as
   * their owning project is drained. */
  pendingBuffers: Record<string, string>;
  /** Filled by the startup update check; null = no update available
   * (or check disabled / not yet run). Status bar reads this. */
  updateInfo: {
    current: string;
    latest: string;
    url: string;
    notes: string;
  } | null;
  /** MRU list of focused leaf (PTY session) IDs across all tabs/projects.
   * Session-only — not persisted. Used by the command palette to surface
   * recently-used terminals as quick jump targets. Most recent first. */
  recentLeafIds: string[];
  /** Transient alt-tab session for the recent-terminal switcher. Non-null only
   * while the user is holding the switcher modifier and cycling. `order` is a
   * frozen snapshot of recentLeafIds (alive leaves) so stepping doesn't reshuffle
   * the list mid-cycle; `mods` records which modifiers must be released to commit. */
  switcher: {
    order: string[];
    index: number;
    mods: Pick<Binding, "meta" | "ctrl" | "alt">;
  } | null;
  /** Transient, user-facing error message (e.g. a terminal couldn't be
   * spawned because the OS ran out of PTYs). Rendered as a dismissable toast;
   * null = nothing shown. Session-only. */
  errorToast: string | null;

  hydrate: (data: {
    projects?: Project[];
    groups?: ProjectGroup[];
    sidebarWidth?: number;
    sidebarVisible?: boolean;
    settings?: Partial<Settings>;
  }) => void;

  toggleSidebar: () => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => Promise<void>;

  requestTabRename: (tabId: string | null) => void;
  requestProjectRename: (projectId: string | null) => void;
  requestGroupRename: (groupId: string | null) => void;
  requestSnippetsDialog: (projectId: string | null) => void;
  setSearchingTerminal: (terminalId: string | null) => void;
  consumeRestoredBuffer: (terminalId: string) => string | null;
  setUpdateInfo: (info: AppState["updateInfo"]) => void;
  /** Show a transient error toast. */
  showError: (message: string) => void;
  /** Dismiss the current error toast. */
  dismissError: () => void;

  addGroup: (name: string) => Promise<ProjectGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  setGroupIcon: (id: string, icon: string | null) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;
  toggleGroup: (id: string) => Promise<void>;
  moveProjectToGroup: (projectId: string, groupId: string | null) => Promise<void>;
  reorderGroups: (fromId: string, toId: string) => Promise<void>;

  toggleBroadcast: (tabId: string) => void;

  addTab: (opts?: AddTabOptions) => Promise<boolean>;
  closeTab: (tabId: string) => Promise<void>;
  /** User-facing tab close. Confirms first when the tab is a split and the
   * confirmCloseSplitTab setting is on; otherwise closes immediately. */
  requestCloseTab: (tabId: string) => void;
  /** Resolve the pending close confirmation: actually close the tab. */
  confirmPendingClose: () => void;
  /** Dismiss the pending close confirmation without closing. */
  cancelPendingClose: () => void;
  /** Stage / dismiss the quit confirmation dialog. */
  setPendingQuit: (v: boolean) => void;
  cancelQuit: () => void;
  /** Stage a "close idle terminals" confirmation for the given tabs. No-op when
   * the list is empty (after filtering to tabs that still exist). */
  requestCull: (tabIds: string[]) => void;
  /** Resolve the cull confirmation: close every staged tab. */
  confirmCull: () => Promise<void>;
  /** Dismiss the cull confirmation without closing anything. */
  cancelCull: () => void;
  closeOtherTabs: (tabId: string) => Promise<void>;
  closeTabsToRight: (tabId: string) => Promise<void>;
  duplicateTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  nextTab: () => void;
  prevTab: () => void;
  activateTabByIndex: (index: number) => void;

  updateMosaic: (tabId: string, mosaic: MosaicNode<string> | null) => void;
  markTabActivity: (terminalId: string) => void;
  reorderTab: (fromId: string, toId: string) => void;
  splitActiveTerminal: (direction: MosaicDirection) => Promise<void>;
  splitPanel: (leafId: string, side: SplitSide) => Promise<void>;
  closeActivePanel: () => Promise<void>;
  focusPanel: (leafId: string) => void;
  moveFocus: (dir: FocusDir) => void;
  handleTerminalExit: (terminalId: string) => Promise<void>;
  /** Jump to a specific terminal regardless of which tab/project it lives
   * in. Used by the command palette's "Recent terminals" list. No-op if
   * the leaf is no longer alive. */
  revealTerminal: (leafId: string) => Promise<void>;

  /** Open the alt-tab switcher: snapshot recent terminals and select the
   * next/previous one. No-op when fewer than 2 alive terminals exist. */
  openSwitcher: (
    direction: "next" | "prev",
    mods: Pick<Binding, "meta" | "ctrl" | "alt">,
  ) => void;
  /** Advance the switcher selection while it's open (wraps). */
  stepSwitcher: (direction: "next" | "prev") => void;
  /** Commit the current switcher selection (jumps to it) and close. */
  commitSwitcher: () => void;
  /** Close the switcher without navigating. */
  cancelSwitcher: () => void;

  addProject: (
    p: Omit<Project, "id" | "createdAt" | "groupId"> & {
      groupId?: string | null;
    },
  ) => Promise<Project | null>;
  updateProject: (id: string, patch: Partial<Omit<Project, "id" | "createdAt">>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  openProject: (projectId: string) => Promise<void>;
  setActiveProject: (projectId: string) => Promise<void>;
  reorderProjects: (fromId: string, toId: string) => Promise<void>;
  setProjectSnippets: (projectId: string, snippets: Snippet[]) => Promise<void>;
  runSnippet: (projectId: string, snippetId: string) => Promise<void>;

  setSidebarWidth: (width: number) => void;
  commitSidebarWidth: (width: number) => Promise<void>;

  updateTerminalCwd: (terminalId: string, cwd: string) => void;
  restoreSession: (
    session: PersistedSession,
    buffers: Record<string, string>,
  ) => Promise<void>;
};

export type SplitSide = "left" | "right" | "up" | "down";

function sideToMosaic(side: SplitSide): {
  direction: MosaicDirection;
  newOn: "first" | "second";
} {
  switch (side) {
    case "left":
      return { direction: "row", newOn: "first" };
    case "right":
      return { direction: "row", newOn: "second" };
    case "up":
      return { direction: "column", newOn: "first" };
    case "down":
      return { direction: "column", newOn: "second" };
  }
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

let cachedHome: string | null = null;
async function resolveDefaultCwd(): Promise<string> {
  if (cachedHome) return cachedHome;
  try {
    cachedHome = await invoke<string>("home_dir");
  } catch {
    cachedHome = "/";
  }
  return cachedHome;
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampSettings(s: Partial<Settings>): Settings {
  const ff =
    typeof s.terminalFontFamily === "string" && s.terminalFontFamily.trim()
      ? s.terminalFontFamily
      : DEFAULT_SETTINGS.terminalFontFamily;
  const themeId =
    typeof s.terminalTheme === "string" && s.terminalTheme.trim()
      ? findTheme(s.terminalTheme).id
      : DEFAULT_SETTINGS.terminalTheme;
  return {
    terminalFontFamily: ff,
    terminalFontSize: clampNumber(
      s.terminalFontSize,
      SETTINGS_LIMITS.terminalFontSize.min,
      SETTINGS_LIMITS.terminalFontSize.max,
      DEFAULT_SETTINGS.terminalFontSize,
    ),
    uiFontSize: clampNumber(
      s.uiFontSize,
      SETTINGS_LIMITS.uiFontSize.min,
      SETTINGS_LIMITS.uiFontSize.max,
      DEFAULT_SETTINGS.uiFontSize,
    ),
    terminalTheme: themeId,
    autoCwdTracking:
      typeof s.autoCwdTracking === "boolean"
        ? s.autoCwdTracking
        : DEFAULT_SETTINGS.autoCwdTracking,
    scrollback: clampNumber(
      s.scrollback,
      SETTINGS_LIMITS.scrollback.min,
      SETTINGS_LIMITS.scrollback.max,
      DEFAULT_SETTINGS.scrollback,
    ),
    shellPath:
      typeof s.shellPath === "string" ? s.shellPath.trim() : "",
    shellArgs:
      typeof s.shellArgs === "string" ? s.shellArgs.trim() : "",
    checkForUpdatesOnStartup:
      typeof s.checkForUpdatesOnStartup === "boolean"
        ? s.checkForUpdatesOnStartup
        : DEFAULT_SETTINGS.checkForUpdatesOnStartup,
    persistScrollback:
      typeof s.persistScrollback === "boolean"
        ? s.persistScrollback
        : DEFAULT_SETTINGS.persistScrollback,
    showPanelHeader:
      typeof s.showPanelHeader === "boolean"
        ? s.showPanelHeader
        : DEFAULT_SETTINGS.showPanelHeader,
    showGroupCount:
      typeof s.showGroupCount === "boolean"
        ? s.showGroupCount
        : DEFAULT_SETTINGS.showGroupCount,
    confirmCloseSplitTab:
      typeof s.confirmCloseSplitTab === "boolean"
        ? s.confirmCloseSplitTab
        : DEFAULT_SETTINGS.confirmCloseSplitTab,
    confirmBeforeQuitting:
      typeof s.confirmBeforeQuitting === "boolean"
        ? s.confirmBeforeQuitting
        : DEFAULT_SETTINGS.confirmBeforeQuitting,
    keybindings: clampKeybindings(s.keybindings),
  };
}

// Keep only well-formed overrides for known action ids. A renamed/removed
// action or a malformed value must never break load — it's silently dropped.
function clampKeybindings(v: unknown): Record<string, Binding> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, Binding> = {};
  for (const [id, b] of Object.entries(v as Record<string, unknown>)) {
    if (isKnownActionId(id) && isValidBinding(b)) out[id] = b;
  }
  return out;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

const RECENT_CAP = 20;

function bumpRecent(list: string[], id: string): string[] {
  const next = [id, ...list.filter((x) => x !== id)];
  return next.length > RECENT_CAP ? next.slice(0, RECENT_CAP) : next;
}

async function spawnTerminal(
  cwd: string,
  autoCwdTracking: boolean,
  shellPath: string,
  shellArgs: string,
): Promise<string> {
  const trimmedPath = shellPath.trim();
  const trimmedArgs = shellArgs.trim();
  const args = trimmedArgs
    ? trimmedArgs.split(/\s+/).filter(Boolean)
    : null;
  return await invoke<string>("spawn_pty", {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    autoCwdTracking,
    shellPath: trimmedPath || null,
    shellArgs: args,
  });
}

async function killTerminal(id: string): Promise<void> {
  try {
    await invoke("kill_pty", { id });
  } catch {
    /* session may already be gone */
  }
}

/** Turn a `spawn_pty` rejection into a user-facing message. The backend
 * surfaces "openpty failed: …" when the OS can't allocate a new PTY — almost
 * always because too many terminals (across all apps) are open at once, which
 * hits the system PTY ceiling. */
function spawnErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (
    /openpty failed|out of pty|too many open files|os error 24|emfile|enfile|no space/i.test(
      raw,
    )
  ) {
    return "Couldn't open a new terminal — the system is out of PTYs. Close some terminals (or other apps) and try again.";
  }
  return `Couldn't start terminal: ${raw}`;
}

/** Proactive "cap" warning: fire a one-time advisory toast when the live
 * terminal count first crosses HIGH_TERMINAL_COUNT, re-arming once the user
 * drops back below it. Complements the hard out-of-PTYs failure (fix #1) and the
 * orange nudge in the Running-apps modal — this one reaches the user even with
 * the modal closed. Purely advisory; never blocks a spawn. */
let warnedHighTerminalCount = false;
function maybeWarnTerminalCount(
  count: number,
  showError: (message: string) => void,
): void {
  if (count >= HIGH_TERMINAL_COUNT) {
    if (!warnedHighTerminalCount) {
      warnedHighTerminalCount = true;
      showError(
        `You have ${count} terminals open — each keeps a live scrollback buffer, so this adds up in RAM. Open Running apps to close idle ones.`,
      );
    }
  } else {
    warnedHighTerminalCount = false;
  }
}

export const useAppStore = create<AppState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  activeProjectId: null,
  lastActiveTabByProject: {},
  terminals: {},
  projects: [],
  groups: [],
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarVisible: true,
  settings: DEFAULT_SETTINGS,
  renamingTabId: null,
  renamingProjectId: null,
  renamingGroupId: null,
  snippetsDialogProjectId: null,
  pendingCloseTabId: null,
  pendingCullTabIds: null,
  pendingQuit: false,
  searchingTerminalId: null,
  restoredBuffers: {},
  pendingProjectRestores: {},
  pendingBuffers: {},
  updateInfo: null,
  recentLeafIds: [],
  switcher: null,
  errorToast: null,

  showError: (message) => set({ errorToast: message }),
  dismissError: () => set({ errorToast: null }),

  hydrate: (data) =>
    set((state) => {
      // Older config files predate groups — normalize so every project has
      // groupId at minimum (null = ungrouped).
      const loadedProjects = (data.projects ?? state.projects).map((p) => ({
        ...p,
        groupId: p.groupId ?? null,
      }));
      const loadedGroups = (data.groups ?? state.groups).map((g) => ({
        ...g,
        collapsed: !!g.collapsed,
      }));
      // Dangling groupIds (group was removed by hand in the JSON) become null.
      const groupIds = new Set(loadedGroups.map((g) => g.id));
      const projects = loadedProjects.map((p) =>
        p.groupId && !groupIds.has(p.groupId) ? { ...p, groupId: null } : p,
      );
      return {
        projects,
        groups: loadedGroups,
        sidebarWidth:
          data.sidebarWidth !== undefined
            ? Math.max(
                SIDEBAR_MIN_WIDTH,
                Math.min(SIDEBAR_MAX_WIDTH, data.sidebarWidth),
              )
            : state.sidebarWidth,
        sidebarVisible:
          typeof data.sidebarVisible === "boolean"
            ? data.sidebarVisible
            : state.sidebarVisible,
        settings: data.settings
          ? clampSettings({ ...state.settings, ...data.settings })
          : state.settings,
      };
    }),

  toggleSidebar: async () => {
    const next = !get().sidebarVisible;
    set({ sidebarVisible: next });
    await saveSidebarVisible(next);
  },

  updateSettings: async (patch) => {
    const prev = get().settings;
    const next = clampSettings({ ...prev, ...patch });
    set({ settings: next });
    await saveSettings(next);
    // Toggling scrollback persistence off — wipe the existing buffers
    // file once so disk doesn't keep stale snapshots from before the
    // toggle. Subsequent saves are skipped by flushSessionSave.
    if (prev.persistScrollback && !next.persistScrollback) {
      try {
        await saveBuffers({});
      } catch {
        /* non-fatal */
      }
    }
  },

  requestTabRename: (tabId) => set({ renamingTabId: tabId }),
  requestProjectRename: (projectId) => set({ renamingProjectId: projectId }),
  requestSnippetsDialog: (projectId) =>
    set({ snippetsDialogProjectId: projectId }),
  requestGroupRename: (groupId) => set({ renamingGroupId: groupId }),
  setSearchingTerminal: (terminalId) =>
    set({ searchingTerminalId: terminalId }),

  setUpdateInfo: (info) => set({ updateInfo: info }),

  consumeRestoredBuffer: (terminalId) => {
    // Non-destructive: React StrictMode double-mounts Terminal components
    // in dev. The first mount would otherwise steal the buffer, leaving
    // the second (actually-visible) mount with an empty xterm. Entries
    // stay until the next restoreSession overwrites restoredBuffers.
    return get().restoredBuffers[terminalId] ?? null;
  },

  toggleBroadcast: (tabId) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, broadcastInput: !t.broadcastInput } : t,
      ),
    })),

  addTab: async (opts) => {
    const projectId = opts?.projectId ?? get().activeProjectId;
    if (!projectId) return false;
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return false;

    const cwd = opts?.cwd ?? project.path;
    const s = get().settings;
    let terminalId: string;
    try {
      terminalId = await spawnTerminal(
        cwd,
        s.autoCwdTracking,
        s.shellPath,
        s.shellArgs,
      );
    } catch (e) {
      // Surface the failure instead of swallowing it — a silent reject here
      // used to leave the New-project dialog open with no feedback.
      get().showError(spawnErrorMessage(e));
      return false;
    }
    const tabId = uuid();
    const tabsInProject = get().tabs.filter(
      (t) => t.projectId === projectId,
    ).length;
    const title = `${project.name} ${tabsInProject + 1}`;

    set((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: tabId,
          title,
          customTitle: false,
          mosaic: terminalId,
          focusedLeafId: terminalId,
          projectId,
          hasUnread: false,
          broadcastInput: false,
        },
      ],
      activeTabId: tabId,
      terminals: {
        ...state.terminals,
        [terminalId]: { id: terminalId, cwd },
      },
      lastActiveTabByProject: {
        ...state.lastActiveTabByProject,
        [projectId]: tabId,
      },
    }));
    maybeWarnTerminalCount(Object.keys(get().terminals).length, get().showError);
    return true;
  },

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

  setPendingQuit: (v) => set({ pendingQuit: v }),
  cancelQuit: () => set({ pendingQuit: false }),

  requestCull: (tabIds) => {
    const ids = tabIds.filter((id) => get().tabs.some((t) => t.id === id));
    if (ids.length === 0) return;
    set({ pendingCullTabIds: ids });
  },
  confirmCull: async () => {
    const ids = get().pendingCullTabIds ?? [];
    set({ pendingCullTabIds: null });
    // Sequential so each closeTab sees consistent state (active-tab handoff).
    for (const id of ids) {
      await get().closeTab(id);
    }
  },
  cancelCull: () => set({ pendingCullTabIds: null }),

  closeTab: async (tabId) => {
    const { tabs, activeTabId, activeProjectId, terminals } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const leaves = tab.mosaic ? collectLeaves(tab.mosaic) : [];
    await Promise.all(leaves.map((id) => killTerminal(id)));

    const remaining = tabs.filter((t) => t.id !== tabId);
    const remainingTerminals = { ...terminals };
    for (const id of leaves) delete remainingTerminals[id];

    const siblingsInProject = remaining.filter(
      (t) => t.projectId === tab.projectId,
    );

    // If the closed tab was active and within the currently viewed project,
    // pick a neighbouring tab in the same project.
    let nextActive: string | null = activeTabId;
    if (activeTabId === tabId) {
      if (siblingsInProject.length > 0) {
        const closedIndexInProject = tabs
          .filter((t) => t.projectId === tab.projectId)
          .findIndex((t) => t.id === tabId);
        const pickIndex = Math.min(
          closedIndexInProject,
          siblingsInProject.length - 1,
        );
        nextActive = siblingsInProject[pickIndex].id;
      } else {
        nextActive = null;
      }
    }

    // Clean per-project memory if the closed tab was the remembered one.
    const nextLastActive = { ...get().lastActiveTabByProject };
    if (nextLastActive[tab.projectId] === tabId) {
      if (siblingsInProject.length > 0 && nextActive) {
        nextLastActive[tab.projectId] = nextActive;
      } else {
        delete nextLastActive[tab.projectId];
      }
    }

    set({
      tabs: remaining,
      activeTabId: nextActive,
      terminals: remainingTerminals,
      lastActiveTabByProject: nextLastActive,
    });

    // Two cases when the project just lost its last tab:
    //   - autoCwdName ("quick-add") projects are ephemeral — when the
    //     user closes the last tab the whole project disappears.
    //   - Regular projects: never leave the active one with zero tabs,
    //     so we respawn a shell. Inactive ones are left empty (the user
    //     opens a new tab themselves on next switch).
    if (siblingsInProject.length === 0) {
      const project = get().projects.find((p) => p.id === tab.projectId);
      if (project?.autoCwdName) {
        await get().removeProject(tab.projectId);
      } else if (tab.projectId === activeProjectId) {
        await get().addTab({ projectId: tab.projectId });
      }
    }
  },

  closeOtherTabs: async (tabId) => {
    const { tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const siblings = tabs.filter(
      (t) => t.projectId === tab.projectId && t.id !== tabId,
    );
    for (const s of siblings) {
      await get().closeTab(s.id);
    }
  },

  closeTabsToRight: async (tabId) => {
    const { tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const group = tabs.filter((t) => t.projectId === tab.projectId);
    const idx = group.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const toClose = group.slice(idx + 1);
    for (const t of toClose) {
      await get().closeTab(t.id);
    }
  },

  duplicateTab: async (tabId) => {
    const { tabs, terminals } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Use the focused leaf's cwd so the new tab starts where the user was
    // looking; falls back to the first leaf if focus isn't tracked.
    const sourceLeaf =
      tab.focusedLeafId ?? (tab.mosaic ? firstLeafOf(tab.mosaic) : null);
    const cwd = sourceLeaf ? terminals[sourceLeaf]?.cwd : undefined;
    await get().addTab({
      projectId: tab.projectId,
      cwd,
    });
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    set((state) => ({
      activeTabId: tabId,
      lastActiveTabByProject: {
        ...state.lastActiveTabByProject,
        [tab.projectId]: tabId,
      },
      tabs: state.tabs.map((t) =>
        t.id === tabId && t.hasUnread ? { ...t, hasUnread: false } : t,
      ),
      recentLeafIds: tab.focusedLeafId
        ? bumpRecent(state.recentLeafIds, tab.focusedLeafId)
        : state.recentLeafIds,
    }));
  },

  renameTab: (tabId, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, title, customTitle: true } : t,
      ),
    })),

  nextTab: () => {
    const { tabs, activeTabId, activeProjectId } = get();
    if (!activeProjectId) return;
    const group = tabs.filter((t) => t.projectId === activeProjectId);
    if (group.length === 0) return;
    const idx = group.findIndex((t) => t.id === activeTabId);
    const nextIdx = (idx + 1) % group.length;
    get().setActiveTab(group[nextIdx].id);
  },

  prevTab: () => {
    const { tabs, activeTabId, activeProjectId } = get();
    if (!activeProjectId) return;
    const group = tabs.filter((t) => t.projectId === activeProjectId);
    if (group.length === 0) return;
    const idx = group.findIndex((t) => t.id === activeTabId);
    const prevIdx = (idx - 1 + group.length) % group.length;
    get().setActiveTab(group[prevIdx].id);
  },

  activateTabByIndex: (index) => {
    const { tabs, activeProjectId } = get();
    if (!activeProjectId) return;
    const group = tabs.filter((t) => t.projectId === activeProjectId);
    if (index < 0 || index >= group.length) return;
    get().setActiveTab(group[index].id);
  },

  reorderTab: (fromId, toId) => {
    if (fromId === toId) return;
    const { tabs } = get();
    const from = tabs.findIndex((t) => t.id === fromId);
    const to = tabs.findIndex((t) => t.id === toId);
    if (from === -1 || to === -1) return;
    // Only allow reordering within the same project — tab bar is filtered
    // per-project so cross-project drops don't make sense.
    if (tabs[from].projectId !== tabs[to].projectId) return;
    const next = tabs.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ tabs: next });
  },

  markTabActivity: (terminalId) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find(
      (t) => t.mosaic && collectLeaves(t.mosaic).includes(terminalId),
    );
    if (!tab) return;
    if (tab.id === activeTabId) return;
    if (tab.hasUnread) return;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id ? { ...t, hasUnread: true } : t,
      ),
    }));
  },

  updateMosaic: (tabId, mosaic) =>
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.id !== tabId) return t;
        // If focused leaf no longer exists in the new tree, fall back to the
        // first available leaf (drag-and-drop in mosaic can reshape IDs).
        const existing = mosaic ? collectLeaves(mosaic) : [];
        const focused =
          t.focusedLeafId && existing.includes(t.focusedLeafId)
            ? t.focusedLeafId
            : mosaic
              ? firstLeafOf(mosaic)
              : null;
        return { ...t, mosaic, focusedLeafId: focused };
      }),
    })),

  splitActiveTerminal: async (direction) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.mosaic) return;
    const anchor = tab.focusedLeafId ?? firstLeafOf(tab.mosaic);
    const side: SplitSide = direction === "row" ? "right" : "down";
    await get().splitPanel(anchor, side);
  },

  splitPanel: async (leafId, side) => {
    const { tabs, terminals } = get();
    const tab = tabs.find(
      (t) => t.mosaic && collectLeaves(t.mosaic).includes(leafId),
    );
    if (!tab || !tab.mosaic) return;

    const cwd = terminals[leafId]?.cwd ?? (await resolveDefaultCwd());
    const s = get().settings;
    let newLeafId: string;
    try {
      newLeafId = await spawnTerminal(
        cwd,
        s.autoCwdTracking,
        s.shellPath,
        s.shellArgs,
      );
    } catch (e) {
      get().showError(spawnErrorMessage(e));
      return;
    }
    const { direction, newOn } = sideToMosaic(side);

    const replacement =
      newOn === "first"
        ? {
            direction,
            first: newLeafId,
            second: leafId,
            splitPercentage: 50,
          }
        : {
            direction,
            first: leafId,
            second: newLeafId,
            splitPercentage: 50,
          };
    const newMosaic = replaceLeaf(tab.mosaic, leafId, replacement);

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id
          ? { ...t, mosaic: newMosaic, focusedLeafId: newLeafId }
          : t,
      ),
      terminals: {
        ...state.terminals,
        [newLeafId]: { id: newLeafId, cwd },
      },
    }));
    maybeWarnTerminalCount(Object.keys(get().terminals).length, get().showError);
  },

  closeActivePanel: async () => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.mosaic || !tab.focusedLeafId) return;
    const leafId = tab.focusedLeafId;

    // Prefer the direct sibling as new focus target before we mutate the tree.
    const sibling = findSiblingLeaf(tab.mosaic, leafId);
    const newMosaic = removeLeaf(tab.mosaic, leafId);

    if (newMosaic === null) {
      // Only panel in the tab — delegate to closeTab (kills the PTY + handles
      // the "last tab → open new empty" rule from M2).
      await get().closeTab(tab.id);
      return;
    }

    await killTerminal(leafId);

    set((state) => {
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[leafId];
      return {
        tabs: state.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                mosaic: newMosaic,
                focusedLeafId: sibling ?? firstLeafOf(newMosaic),
              }
            : t,
        ),
        terminals: remainingTerminals,
      };
    });
  },

  focusPanel: (leafId) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.mosaic) return;
    if (!collectLeaves(tab.mosaic).includes(leafId)) return;
    if (tab.focusedLeafId === leafId) return;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id ? { ...t, focusedLeafId: leafId } : t,
      ),
      recentLeafIds: bumpRecent(state.recentLeafIds, leafId),
    }));
  },

  moveFocus: (dir) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.mosaic || !tab.focusedLeafId) return;
    const target = findNeighborLeaf(tab.mosaic, tab.focusedLeafId, dir);
    if (!target) return;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id ? { ...t, focusedLeafId: target } : t,
      ),
      recentLeafIds: bumpRecent(state.recentLeafIds, target),
    }));
  },

  handleTerminalExit: async (terminalId) => {
    const { tabs } = get();
    const tab = tabs.find(
      (t) => t.mosaic && collectLeaves(t.mosaic).includes(terminalId),
    );
    if (!tab || !tab.mosaic) {
      // Session unknown — clean up the Rust side just in case.
      await killTerminal(terminalId);
      return;
    }

    const sibling = findSiblingLeaf(tab.mosaic, terminalId);
    const newMosaic = removeLeaf(tab.mosaic, terminalId);

    if (newMosaic === null) {
      // Last panel in tab — delegate to closeTab (handles last-tab auto-respawn).
      await get().closeTab(tab.id);
      return;
    }

    // Kill on Rust side to drop the session from the HashMap (idempotent).
    await killTerminal(terminalId);

    set((state) => {
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[terminalId];
      return {
        tabs: state.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                mosaic: newMosaic,
                focusedLeafId:
                  t.focusedLeafId === terminalId
                    ? (sibling ?? firstLeafOf(newMosaic))
                    : t.focusedLeafId,
              }
            : t,
        ),
        terminals: remainingTerminals,
        recentLeafIds: state.recentLeafIds.filter((id) => id !== terminalId),
      };
    });
  },

  revealTerminal: async (leafId) => {
    const state = get();
    if (!state.terminals[leafId]) return;
    const tab = state.tabs.find(
      (t) => t.mosaic && collectLeaves(t.mosaic).includes(leafId),
    );
    if (!tab) return;
    if (state.activeProjectId !== tab.projectId) {
      await get().setActiveProject(tab.projectId);
    }
    set((s) => ({
      activeTabId: tab.id,
      lastActiveTabByProject: {
        ...s.lastActiveTabByProject,
        [tab.projectId]: tab.id,
      },
      tabs: s.tabs.map((t) =>
        t.id === tab.id
          ? { ...t, focusedLeafId: leafId, hasUnread: false }
          : t,
      ),
      recentLeafIds: bumpRecent(s.recentLeafIds, leafId),
    }));
  },

  openSwitcher: (direction, mods) => {
    const state = get();
    // Frozen snapshot of alive recent leaves, most-recent first. recentLeafIds[0]
    // is the terminal we're currently on; the first hop should land on the next
    // one, hence index 1 for "next" and the last entry for "prev".
    const order = state.recentLeafIds.filter((id) => !!state.terminals[id]);
    if (order.length < 2) return;
    const index = direction === "next" ? 1 : order.length - 1;
    set({ switcher: { order, index, mods } });
  },

  stepSwitcher: (direction) => {
    const sw = get().switcher;
    if (!sw) return;
    const n = sw.order.length;
    const index =
      direction === "next" ? (sw.index + 1) % n : (sw.index - 1 + n) % n;
    set({ switcher: { ...sw, index } });
  },

  commitSwitcher: () => {
    const sw = get().switcher;
    set({ switcher: null });
    if (!sw) return;
    const target = sw.order[sw.index];
    // revealTerminal is the single place that bumps recentLeafIds — so the MRU
    // only reshuffles on commit, never mid-cycle.
    if (target) void get().revealTerminal(target);
  },

  cancelSwitcher: () => set({ switcher: null }),

  addProject: async (p) => {
    const project: Project = {
      groupId: null,
      ...p,
      id: uuid(),
      createdAt: Date.now(),
    };
    const prevActive = get().activeProjectId;
    // Register + switch to the project so its first tab renders in place, then
    // spawn that tab. If the spawn fails (e.g. the OS is out of PTYs), roll the
    // project back so we never persist an orphan with no tab — addTab has
    // already surfaced the error toast. Persist only on success.
    set((state) => ({
      projects: [...state.projects, project],
      activeProjectId: project.id,
    }));
    const ok = await get().addTab({ projectId: project.id });
    if (!ok) {
      set((state) => ({
        projects: state.projects.filter((x) => x.id !== project.id),
        activeProjectId: prevActive,
      }));
      return null;
    }
    await saveProjects(get().projects);
    return project;
  },

  updateProject: async (id, patch) => {
    // Manual rename pins the name: clear autoCwdName so the sidebar
    // stops tracking the active tab's cwd. Caller can still set
    // autoCwdName explicitly in patch to override.
    const effectivePatch =
      patch.name !== undefined && patch.autoCwdName === undefined
        ? { ...patch, autoCwdName: false }
        : patch;
    const projects = get().projects.map((p) =>
      p.id === id ? { ...p, ...effectivePatch } : p,
    );
    let tabs = get().tabs;
    if (patch.name !== undefined) {
      // Regenerate titles for tabs in this project so the per-project
      // index stays consistent ("newname 1", "newname 2", …).
      // Tabs the user has renamed manually keep their custom title.
      const projectTabs = tabs.filter((t) => t.projectId === id);
      tabs = tabs.map((t) => {
        if (t.projectId !== id || t.customTitle) return t;
        const idx = projectTabs.findIndex((x) => x.id === t.id) + 1;
        return { ...t, title: `${patch.name} ${idx}` };
      });
    }
    set({ projects, tabs });
    await saveProjects(projects);
  },

  removeProject: async (id) => {
    const { tabs, activeProjectId } = get();
    const doomedTabs = tabs.filter((t) => t.projectId === id);
    const doomedLeaves = doomedTabs.flatMap((t) =>
      t.mosaic ? collectLeaves(t.mosaic) : [],
    );
    await Promise.all(doomedLeaves.map((leafId) => killTerminal(leafId)));

    const remainingTabs = tabs.filter((t) => t.projectId !== id);
    const remainingProjects = get().projects.filter((p) => p.id !== id);
    const remainingTerminals = { ...get().terminals };
    for (const leafId of doomedLeaves) delete remainingTerminals[leafId];

    const nextLastActive = { ...get().lastActiveTabByProject };
    delete nextLastActive[id];

    // Drop any pending lazy-restore entries (and their buffers) for the
    // removed project so they don't haunt the next session save.
    const nextPendingProjects = { ...get().pendingProjectRestores };
    const removedPending = nextPendingProjects[id];
    delete nextPendingProjects[id];
    const nextPendingBuffers = { ...get().pendingBuffers };
    if (removedPending) {
      for (const ptab of removedPending) {
        for (const bufferId of collectLeafBufferIds(ptab.layout)) {
          delete nextPendingBuffers[bufferId];
        }
      }
    }

    set({
      projects: remainingProjects,
      tabs: remainingTabs,
      terminals: remainingTerminals,
      lastActiveTabByProject: nextLastActive,
      pendingProjectRestores: nextPendingProjects,
      pendingBuffers: nextPendingBuffers,
    });

    await saveProjects(remainingProjects);

    // If the removed project was active, move focus to another project
    // (or to the empty state if there are none left).
    if (activeProjectId === id) {
      if (remainingProjects.length > 0) {
        await get().setActiveProject(remainingProjects[0].id);
      } else {
        set({ activeProjectId: null, activeTabId: null });
      }
    }
  },

  openProject: async (projectId) => {
    await get().setActiveProject(projectId);
  },

  reorderProjects: async (fromId, toId) => {
    if (fromId === toId) return;
    const { projects } = get();
    const from = projects.findIndex((p) => p.id === fromId);
    const to = projects.findIndex((p) => p.id === toId);
    if (from === -1 || to === -1) return;
    const next = projects.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ projects: next });
    await saveProjects(next);
  },

  setProjectSnippets: async (projectId, snippets) => {
    const projects = get().projects.map((p) =>
      p.id === projectId ? { ...p, snippets } : p,
    );
    set({ projects });
    await saveProjects(projects);
  },

  runSnippet: async (projectId, snippetId) => {
    const { projects, tabs, activeTabId } = get();
    const project = projects.find((p) => p.id === projectId);
    const snippet = project?.snippets?.find((s) => s.id === snippetId);
    if (!snippet) return;

    // Prefer the focused leaf of the currently active tab when it belongs
    // to this project. Otherwise fall back to the last-active tab in the
    // project; if there's no open tab, spawn one first.
    let targetLeaf: string | null = null;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab && activeTab.projectId === projectId) {
      targetLeaf = activeTab.focusedLeafId;
    } else {
      const inProject = tabs.find((t) => t.projectId === projectId);
      targetLeaf = inProject?.focusedLeafId ?? null;
    }

    if (!targetLeaf) {
      await get().setActiveProject(projectId);
      const fresh = get();
      const tab = fresh.tabs.find((t) => t.id === fresh.activeTabId);
      targetLeaf = tab?.focusedLeafId ?? null;
    }
    if (!targetLeaf) return;
    const runAfter = snippet.runAfterPaste !== false;
    const data = runAfter
      ? snippet.command.endsWith("\n")
        ? snippet.command
        : `${snippet.command}\r`
      : snippet.command;
    await invoke("write_to_pty", { id: targetLeaf, data });
  },

  addGroup: async (name) => {
    const trimmed = name.trim();
    const group: ProjectGroup = {
      id: uuid(),
      name: trimmed || "New group",
      collapsed: false,
    };
    const groups = [...get().groups, group];
    set({ groups });
    await saveGroups(groups);
    return group;
  },

  renameGroup: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const groups = get().groups.map((g) =>
      g.id === id ? { ...g, name: trimmed } : g,
    );
    set({ groups });
    await saveGroups(groups);
  },

  setGroupIcon: async (id, icon) => {
    const trimmed = (icon ?? "").trim();
    const groups = get().groups.map((g) => {
      if (g.id !== id) return g;
      if (trimmed) return { ...g, icon: trimmed };
      // Empty / null clears the field — drop the key so the JSON doesn't
      // carry `"icon": ""` indefinitely.
      const { icon: _drop, ...rest } = g;
      return rest;
    });
    set({ groups });
    await saveGroups(groups);
  },

  removeGroup: async (id) => {
    // Projects in the removed group fall back to ungrouped — tabs/PTYs
    // are untouched.
    const groups = get().groups.filter((g) => g.id !== id);
    const projects = get().projects.map((p) =>
      p.groupId === id ? { ...p, groupId: null } : p,
    );
    set({ groups, projects });
    await Promise.all([saveGroups(groups), saveProjects(projects)]);
  },

  toggleGroup: async (id) => {
    const groups = get().groups.map((g) =>
      g.id === id ? { ...g, collapsed: !g.collapsed } : g,
    );
    set({ groups });
    await saveGroups(groups);
  },

  moveProjectToGroup: async (projectId, groupId) => {
    if (groupId !== null && !get().groups.some((g) => g.id === groupId)) {
      return;
    }
    const projects = get().projects.map((p) =>
      p.id === projectId ? { ...p, groupId } : p,
    );
    set({ projects });
    await saveProjects(projects);
  },

  reorderGroups: async (fromId, toId) => {
    if (fromId === toId) return;
    const { groups } = get();
    const from = groups.findIndex((g) => g.id === fromId);
    const to = groups.findIndex((g) => g.id === toId);
    if (from === -1 || to === -1) return;
    const next = groups.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ groups: next });
    await saveGroups(next);
  },

  setActiveProject: async (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    // Lazy restore: if this project's tabs were stashed at startup
    // instead of being spawned eagerly, spawn them now. Eagerly clear the
    // pending entry first so a concurrent activation can't double-spawn.
    const pending = get().pendingProjectRestores[projectId];
    if (pending && pending.length > 0) {
      set((state) => {
        const next = { ...state.pendingProjectRestores };
        delete next[projectId];
        return { pendingProjectRestores: next };
      });

      const buffers = get().pendingBuffers;
      const newTabs: Tab[] = [];
      const newTerminals: Record<string, TerminalSession> = {};
      const restoredBuffers: Record<string, string> = {};
      const consumedBufferIds = new Set<string>();

      try {
        for (const ptab of pending) {
          for (const id of collectLeafBufferIds(ptab.layout)) {
            consumedBufferIds.add(id);
          }
          const mosaic = await buildMosaicFromLayout(
            ptab.layout,
            buffers,
            async (cwd, buffer) => {
              const effectiveCwd = cwd || project.path;
              const s = get().settings;
              let terminalId: string;
              try {
                terminalId = await spawnTerminal(
                  effectiveCwd,
                  s.autoCwdTracking,
                  s.shellPath,
                  s.shellArgs,
                );
                newTerminals[terminalId] = {
                  id: terminalId,
                  cwd: effectiveCwd,
                };
              } catch {
                terminalId = await spawnTerminal(
                  project.path,
                  s.autoCwdTracking,
                  s.shellPath,
                  s.shellArgs,
                );
                newTerminals[terminalId] = {
                  id: terminalId,
                  cwd: project.path,
                };
              }
              if (buffer) restoredBuffers[terminalId] = buffer;
              return terminalId;
            },
          );

          newTabs.push({
            id: ptab.id,
            title: ptab.title,
            customTitle: ptab.customTitle,
            mosaic,
            focusedLeafId: firstLeafOf(mosaic),
            projectId,
            hasUnread: false,
            broadcastInput: false,
          });
        }

        set((state) => {
          const nextPendingBuffers = { ...state.pendingBuffers };
          for (const id of consumedBufferIds) delete nextPendingBuffers[id];
          return {
            tabs: [...state.tabs, ...newTabs],
            terminals: { ...state.terminals, ...newTerminals },
            restoredBuffers: { ...state.restoredBuffers, ...restoredBuffers },
            pendingBuffers: nextPendingBuffers,
          };
        });
      } catch (e) {
        // Restoring a stashed layout couldn't spawn its terminals (the OS is
        // out of PTYs). Kill whatever did spawn, put the pending entry back so
        // the layout survives for a later retry, and surface the error instead
        // of crashing the activation. Buffers weren't consumed yet (that set
        // only runs on success), so they stay intact.
        for (const id of Object.keys(newTerminals)) await killTerminal(id);
        set((state) => ({
          pendingProjectRestores: {
            ...state.pendingProjectRestores,
            [projectId]: pending,
          },
        }));
        get().showError(spawnErrorMessage(e));
        return;
      }
    }

    set({ activeProjectId: projectId });

    const groupTabs = get().tabs.filter((t) => t.projectId === projectId);
    if (groupTabs.length === 0) {
      await get().addTab({ projectId });
      return;
    }
    // Restore the last active tab in this group, or fall back to the first.
    const remembered = get().lastActiveTabByProject[projectId];
    const target =
      groupTabs.find((t) => t.id === remembered) ?? groupTabs[0];
    get().setActiveTab(target.id);
  },

  setSidebarWidth: (width) => {
    const clamped = Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(SIDEBAR_MAX_WIDTH, width),
    );
    set({ sidebarWidth: clamped });
  },

  commitSidebarWidth: async (width) => {
    const clamped = Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(SIDEBAR_MAX_WIDTH, width),
    );
    set({ sidebarWidth: clamped });
    await saveSidebarWidth(clamped);
  },

  updateTerminalCwd: (terminalId, cwd) => {
    set((state) => {
      const current = state.terminals[terminalId];
      if (!current || current.cwd === cwd) return state;
      return {
        terminals: {
          ...state.terminals,
          [terminalId]: { ...current, cwd },
        },
      };
    });
  },

  restoreSession: async (session, buffers) => {
    const { projects } = get();
    const projectIds = new Set(projects.map((p) => p.id));

    // Stash persisted layouts per project for lazy spawn. PTYs aren't
    // spawned here — only when the user activates a project (or when
    // setActiveProject is called below for the initial active project).
    // Big startup wins when the user has many projects but only opens
    // one or two per session.
    const pending: Record<string, PersistedTab[]> = {};
    const allTabIds = new Set<string>();
    for (const [pid, ptabs] of Object.entries(session.tabsByProject)) {
      if (!projectIds.has(pid)) continue;
      pending[pid] = ptabs;
      for (const t of ptabs) allTabIds.add(t.id);
    }

    const lastActive: Record<string, string> = {};
    for (const [pid, tid] of Object.entries(session.lastActiveTabByProject)) {
      if (allTabIds.has(tid)) lastActive[pid] = tid;
    }

    set((state) => ({
      pendingProjectRestores: {
        ...state.pendingProjectRestores,
        ...pending,
      },
      pendingBuffers: { ...state.pendingBuffers, ...buffers },
      lastActiveTabByProject: {
        ...state.lastActiveTabByProject,
        ...lastActive,
      },
    }));

    // Activate the saved active project — drains its pending entry
    // and spawns its PTYs. Other projects stay pending until the user
    // clicks them in the sidebar.
    if (
      session.activeProjectId &&
      projectIds.has(session.activeProjectId)
    ) {
      await get().setActiveProject(session.activeProjectId);
    }
  },
}));

// --- session autosave ---
// The subscription fires on every state change. Filter to fields that
// affect the persisted shape and debounce writes to 500 ms. The flag
// stays off during startup hydration/restore so those writes don't echo.

let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSaveMaxTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSaveEnabled = false;

const SAVE_DEBOUNCE_MS = 500;
// Under continuous activity (e.g. `tail -f`) the debounce timer would
// perpetually reset. Guarantee a flush at least this often so scrollback
// doesn't stay stale on disk.
const SAVE_MAX_WAIT_MS = 10_000;

export function enableSessionAutosave() {
  sessionSaveEnabled = true;
}

/**
 * Ask for a session save. Coalesces rapid calls via debounce, but still
 * flushes within SAVE_MAX_WAIT_MS even if triggers never stop coming.
 * Called both by the state-change subscriber and by the Terminal
 * component when new PTY data arrives (so scrollback stays in sync).
 */
export function scheduleSessionSave() {
  if (!sessionSaveEnabled) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(
    () => void flushSessionSave(),
    SAVE_DEBOUNCE_MS,
  );
  if (!sessionSaveMaxTimer) {
    sessionSaveMaxTimer = setTimeout(
      () => void flushSessionSave(),
      SAVE_MAX_WAIT_MS,
    );
  }
}

/**
 * Cancel any pending debounced save and write the current session
 * snapshot to disk immediately. Awaits disk write so callers (e.g. the
 * window-close handler) can block on completion before the process dies.
 */
export async function flushSessionSave(): Promise<void> {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  if (sessionSaveMaxTimer) clearTimeout(sessionSaveMaxTimer);
  sessionSaveTimer = null;
  sessionSaveMaxTimer = null;
  // xterm.write queues data and parses it asynchronously. Before we
  // serialize, drain every terminal's queue so the snapshot reflects
  // the latest PTY output rather than a state from 1 frame ago.
  try {
    await flushAllWrites();
  } catch {
    /* non-fatal — fall through and serialize what we have */
  }
  const s = useAppStore.getState();
  const { session, buffers } = serializeSession({
    tabs: s.tabs,
    terminals: s.terminals,
    activeProjectId: s.activeProjectId,
    lastActiveTabByProject: s.lastActiveTabByProject,
    projects: s.projects,
  });
  // Merge pending lazy-restore state so projects the user hasn't
  // activated this session don't lose their layout. Live state always
  // wins over pending; only fill in projects with no live tabs.
  for (const [pid, ptabs] of Object.entries(s.pendingProjectRestores)) {
    if (!session.tabsByProject[pid]) {
      session.tabsByProject[pid] = ptabs;
    }
  }
  // Carry over pending buffers referenced by still-pending tabs so the
  // next launch can replay them. Drop any orphans.
  for (const ptabs of Object.values(s.pendingProjectRestores)) {
    for (const ptab of ptabs) {
      for (const id of collectLeafBufferIds(ptab.layout)) {
        const buf = s.pendingBuffers[id];
        if (buf !== undefined && buffers[id] === undefined) {
          buffers[id] = buf;
        }
      }
    }
  }
  // Skip the buffers write when the user opted out of scrollback
  // persistence — buffers.json was already wiped at the toggle moment, so
  // we just stop overwriting it.
  const writes = s.settings.persistScrollback
    ? [saveBuffers(buffers), saveSession(session)]
    : [saveSession(session)];
  try {
    await Promise.all(writes);
  } catch (err) {
    console.error("session save failed:", err);
  }
}

useAppStore.subscribe((state, prev) => {
  if (
    state.tabs !== prev.tabs ||
    state.terminals !== prev.terminals ||
    state.activeProjectId !== prev.activeProjectId ||
    state.lastActiveTabByProject !== prev.lastActiveTabByProject ||
    state.projects !== prev.projects
  ) {
    scheduleSessionSave();
  }
});
