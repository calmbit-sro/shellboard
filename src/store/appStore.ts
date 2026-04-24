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
  serializeSession,
  type PersistedSession,
} from "../utils/sessionSerialize";
import { flushAllWrites } from "../utils/terminalRegistry";
import { DEFAULT_THEME_ID, findTheme } from "../utils/themes";

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
};

export type ProjectGroup = {
  id: string;
  name: string;
  collapsed: boolean;
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
};

export const SETTINGS_LIMITS = {
  terminalFontSize: { min: 8, max: 32 },
  uiFontSize: { min: 10, max: 20 },
  scrollback: { min: 500, max: 100000 },
} as const;

export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 400;

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
  /** When non-null, the matching Terminal should show its search overlay. */
  searchingTerminalId: string | null;
  /** Scrollback snapshots keyed by the new terminal id after session
   * restore. A Terminal consumes (and removes) its entry on mount so old
   * buffer content lands in the fresh xterm before PTY data flows in. */
  restoredBuffers: Record<string, string>;

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
  setSearchingTerminal: (terminalId: string | null) => void;
  consumeRestoredBuffer: (terminalId: string) => string | null;

  addGroup: (name: string) => Promise<ProjectGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;
  toggleGroup: (id: string) => Promise<void>;
  moveProjectToGroup: (projectId: string, groupId: string | null) => Promise<void>;
  reorderGroups: (fromId: string, toId: string) => Promise<void>;

  toggleBroadcast: (tabId: string) => void;

  addTab: (opts?: AddTabOptions) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
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

  addProject: (
    p: Omit<Project, "id" | "createdAt" | "groupId"> & {
      groupId?: string | null;
    },
  ) => Promise<Project>;
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
  };
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
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

export const useAppStore = create<AppState>((set, get) => ({
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
  searchingTerminalId: null,
  restoredBuffers: {},

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
    const next = clampSettings({ ...get().settings, ...patch });
    set({ settings: next });
    await saveSettings(next);
  },

  requestTabRename: (tabId) => set({ renamingTabId: tabId }),
  requestProjectRename: (projectId) => set({ renamingProjectId: projectId }),
  requestGroupRename: (groupId) => set({ renamingGroupId: groupId }),
  setSearchingTerminal: (terminalId) =>
    set({ searchingTerminalId: terminalId }),

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
    if (!projectId) return;
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const cwd = opts?.cwd ?? project.path;
    const s = get().settings;
    const terminalId = await spawnTerminal(
      cwd,
      s.autoCwdTracking,
      s.shellPath,
      s.shellArgs,
    );
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
  },

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

    // Never leave the active project's group empty — reopen a shell in it.
    if (
      siblingsInProject.length === 0 &&
      tab.projectId === activeProjectId
    ) {
      await get().addTab({ projectId: tab.projectId });
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
    const newLeafId = await spawnTerminal(
      cwd,
      s.autoCwdTracking,
      s.shellPath,
      s.shellArgs,
    );
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
      };
    });
  },

  addProject: async (p) => {
    const project: Project = {
      groupId: null,
      ...p,
      id: uuid(),
      createdAt: Date.now(),
    };
    const projects = [...get().projects, project];
    set({ projects });
    await saveProjects(projects);
    // Switch to the new project so the user can immediately start using it.
    await get().setActiveProject(project.id);
    return project;
  },

  updateProject: async (id, patch) => {
    const projects = get().projects.map((p) =>
      p.id === id ? { ...p, ...patch } : p,
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

    set({
      projects: remainingProjects,
      tabs: remainingTabs,
      terminals: remainingTerminals,
      lastActiveTabByProject: nextLastActive,
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
    await invoke("write_to_pty", {
      id: targetLeaf,
      data: snippet.command.endsWith("\n")
        ? snippet.command
        : `${snippet.command}\r`,
    });
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

    // Collect: tabs per project + fresh terminal records keyed by new UUID.
    const newTabs: Tab[] = [];
    const newTerminals: Record<string, TerminalSession> = {};
    const restoredBuffers: Record<string, string> = {};

    for (const [projectId, persistedTabs] of Object.entries(
      session.tabsByProject,
    )) {
      if (!projectIds.has(projectId)) continue;
      const project = projects.find((p) => p.id === projectId)!;

      for (const ptab of persistedTabs) {
        const mosaic = await buildMosaicFromLayout(
          ptab.layout,
          buffers,
          async (cwd, buffer) => {
            // Fall back to project.path if the saved cwd no longer exists —
            // spawn_pty itself fails only on truly bogus paths, but we
            // can't cheaply probe so we just rely on its error. If it does
            // error, spawn again with project.path.
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
              newTerminals[terminalId] = { id: terminalId, cwd: effectiveCwd };
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
    }

    // Validate lastActiveTabByProject against the restored tabs.
    const tabIds = new Set(newTabs.map((t) => t.id));
    const lastActive: Record<string, string> = {};
    for (const [pid, tid] of Object.entries(session.lastActiveTabByProject)) {
      if (tabIds.has(tid)) lastActive[pid] = tid;
    }

    set((state) => ({
      tabs: [...state.tabs, ...newTabs],
      terminals: { ...state.terminals, ...newTerminals },
      lastActiveTabByProject: {
        ...state.lastActiveTabByProject,
        ...lastActive,
      },
      restoredBuffers: { ...state.restoredBuffers, ...restoredBuffers },
    }));

    // Restore active project + active tab within it, if still valid.
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
  // Write buffers first so a reader that sees the new session.json can
  // always find the bufferIds it references. Run in parallel for speed;
  // the order matters only if one write fails mid-flight.
  try {
    await Promise.all([saveBuffers(buffers), saveSession(session)]);
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
