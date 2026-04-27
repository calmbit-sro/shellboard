import type { MosaicDirection, MosaicNode } from "react-mosaic-component";
import type { Tab, TerminalSession } from "../store/appStore";
import { isLeaf } from "./mosaic";
import { getSerializer } from "./terminalRegistry";

/** Cap serialized buffer per terminal to keep buffers.json manageable.
 * Strings longer than this are truncated from the start (we keep the tail,
 * which is what the user most recently saw). */
const MAX_BUFFER_CHARS = 2_000_000;

export type PersistedLayout =
  | { type: "leaf"; cwd: string; bufferId?: string }
  | {
      type: "split";
      direction: MosaicDirection;
      splitPercentage?: number;
      first: PersistedLayout;
      second: PersistedLayout;
    };

export type PersistedTab = {
  id: string;
  title: string;
  customTitle: boolean;
  layout: PersistedLayout;
};

export type PersistedSession = {
  version: 1;
  activeProjectId: string | null;
  lastActiveTabByProject: Record<string, string>;
  tabsByProject: Record<string, PersistedTab[]>;
};

export type SessionSnapshot = {
  session: PersistedSession;
  /** bufferId → serialized xterm snapshot. Stored in a separate file so
   * a huge scrollback never bloats or corrupts session.json. */
  buffers: Record<string, string>;
};

function newBufferId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function mosaicToLayout(
  node: MosaicNode<string>,
  terminals: Record<string, TerminalSession>,
  buffers: Record<string, string>,
): PersistedLayout {
  if (isLeaf(node)) {
    const cwd = terminals[node]?.cwd ?? "";
    let bufferId: string | undefined;
    try {
      // Default serialize options = all scrollback + viewport. We cap only
      // the resulting string size so weird XL terminals don't blow up
      // buffers.json.
      let snapshot = getSerializer(node)?.serialize();
      if (snapshot) {
        if (snapshot.length > MAX_BUFFER_CHARS) {
          snapshot = snapshot.slice(snapshot.length - MAX_BUFFER_CHARS);
        }
        bufferId = newBufferId();
        buffers[bufferId] = snapshot;
      }
    } catch {
      /* serializer may not be mounted yet; skip silently */
    }
    return bufferId ? { type: "leaf", cwd, bufferId } : { type: "leaf", cwd };
  }
  return {
    type: "split",
    direction: node.direction,
    splitPercentage: node.splitPercentage,
    first: mosaicToLayout(node.first, terminals, buffers),
    second: mosaicToLayout(node.second, terminals, buffers),
  };
}

export function tabToPersisted(
  tab: Tab,
  terminals: Record<string, TerminalSession>,
  buffers: Record<string, string>,
): PersistedTab | null {
  if (!tab.mosaic) return null;
  return {
    id: tab.id,
    title: tab.title,
    customTitle: tab.customTitle,
    layout: mosaicToLayout(tab.mosaic, terminals, buffers),
  };
}

export function serializeSession(state: {
  tabs: Tab[];
  terminals: Record<string, TerminalSession>;
  activeProjectId: string | null;
  lastActiveTabByProject: Record<string, string>;
  projects: { id: string }[];
}): SessionSnapshot {
  const projectIds = new Set(state.projects.map((p) => p.id));
  const tabsByProject: Record<string, PersistedTab[]> = {};
  const buffers: Record<string, string> = {};

  for (const tab of state.tabs) {
    if (!projectIds.has(tab.projectId)) continue;
    const persisted = tabToPersisted(tab, state.terminals, buffers);
    if (!persisted) continue;
    (tabsByProject[tab.projectId] ??= []).push(persisted);
  }

  // Filter lastActive memory to tabs that actually exist in the serialized set.
  const lastActive: Record<string, string> = {};
  for (const [pid, tabId] of Object.entries(state.lastActiveTabByProject)) {
    if (tabsByProject[pid]?.some((t) => t.id === tabId)) {
      lastActive[pid] = tabId;
    }
  }

  return {
    session: {
      version: 1,
      activeProjectId: state.activeProjectId,
      lastActiveTabByProject: lastActive,
      tabsByProject,
    },
    buffers,
  };
}

/**
 * Walk a PersistedLayout, calling `spawnLeaf(cwd, buffer)` for each leaf
 * to obtain a fresh terminal id. The caller receives both the cwd (to
 * spawn the PTY) and any saved scrollback buffer (to seed the new xterm
 * on mount). Returns a MosaicNode referencing the new terminal ids.
 */
export async function buildMosaicFromLayout(
  layout: PersistedLayout,
  buffers: Record<string, string>,
  spawnLeaf: (cwd: string, buffer?: string) => Promise<string>,
): Promise<MosaicNode<string>> {
  if (layout.type === "leaf") {
    const buf = layout.bufferId ? buffers[layout.bufferId] : undefined;
    return await spawnLeaf(layout.cwd, buf);
  }
  const first = await buildMosaicFromLayout(layout.first, buffers, spawnLeaf);
  const second = await buildMosaicFromLayout(layout.second, buffers, spawnLeaf);
  return {
    direction: layout.direction,
    splitPercentage: layout.splitPercentage,
    first,
    second,
  };
}

export function collectLeafCwds(layout: PersistedLayout): string[] {
  if (layout.type === "leaf") return [layout.cwd];
  return [
    ...collectLeafCwds(layout.first),
    ...collectLeafCwds(layout.second),
  ];
}

export function collectLeafBufferIds(layout: PersistedLayout): string[] {
  if (layout.type === "leaf") return layout.bufferId ? [layout.bufferId] : [];
  return [
    ...collectLeafBufferIds(layout.first),
    ...collectLeafBufferIds(layout.second),
  ];
}
