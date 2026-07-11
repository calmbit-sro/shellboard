import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HIGH_TERMINAL_COUNT, useAppStore } from "../store/appStore";
import { collectLeaves } from "../utils/mosaic";
import { getTerminal } from "../utils/terminalRegistry";
import { cwdLabel } from "../utils/path";
import { formatBytes } from "../utils/format";
import { Terminal } from "./icons";
import "./RunningApps.css";

// Mirrors the Rust `RunningApp` (serde camelCase).
type RunningApp = {
  pid: number;
  name: string;
  command: string;
  memoryBytes: number;
};

// Mirrors the Rust `SelfMemory` (serde camelCase).
type SelfMemory = { appRssBytes: number; terminalCount: number };

// Mirrors the Rust `RunningAppsSnapshot` (serde camelCase).
type Snapshot = { apps: Record<string, RunningApp>; selfMemory: SelfMemory };

// Shellboard's own RSS past this looks heavy; turns the footer gauge orange.
const HIGH_APP_RSS = 1_500_000_000; // 1.5 GB

type Row = {
  sessionId: string; // == mosaic leaf id == PTY session id
  projectName: string;
  projectColor: string;
  tabTitle: string;
  cwd: string;
  app: RunningApp;
};

type RunningAppsProps = {
  open: boolean;
  onClose: () => void;
};

// How often to re-poll the backend while the modal is open.
const POLL_MS = 2000;

/**
 * Join the backend's sessionId -> RunningApp map with the store's project/tab/
 * cwd context. Walks every project's tabs/leaves and keeps only the leaves the
 * backend flagged as running a real app. Sorted by project then tab so live
 * updates don't reshuffle rows under the cursor.
 */
function buildRows(apps: Record<string, RunningApp>): Row[] {
  const state = useAppStore.getState();
  const rows: Row[] = [];
  for (const project of state.projects) {
    for (const tab of state.tabs) {
      if (tab.projectId !== project.id || !tab.mosaic) continue;
      for (const leafId of collectLeaves(tab.mosaic)) {
        const app = apps[leafId];
        if (!app) continue;
        rows.push({
          sessionId: leafId,
          projectName: project.name,
          projectColor: project.color ?? "#0a84ff",
          tabTitle: tab.title,
          cwd: state.terminals[leafId]?.cwd ?? "",
          app,
        });
      }
    }
  }
  // Heaviest first so the RAM hog is at the top; stable tiebreak keeps rows of
  // equal memory from reshuffling under the cursor between polls.
  rows.sort(
    (a, b) =>
      b.app.memoryBytes - a.app.memoryBytes ||
      a.projectName.localeCompare(b.projectName) ||
      a.tabTitle.localeCompare(b.tabTitle) ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return rows;
}

/**
 * Tabs whose every terminal is idle (a bare shell — none flagged as running an
 * app by the backend). The currently active tab is spared so the cull never
 * yanks the view out from under the user. These are the safe candidates for the
 * "Close idle" button: closing them reclaims their live scrollback buffers.
 */
function computeIdleTabIds(apps: Record<string, RunningApp>): string[] {
  const state = useAppStore.getState();
  return state.tabs
    .filter((t) => t.id !== state.activeTabId)
    .filter((t) => {
      const leaves = t.mosaic ? collectLeaves(t.mosaic) : [];
      return leaves.length > 0 && leaves.every((leaf) => !apps[leaf]);
    })
    .map((t) => t.id);
}

export function RunningApps({ open, onClose }: RunningAppsProps) {
  const [apps, setApps] = useState<Record<string, RunningApp>>({});
  const [self, setSelf] = useState<SelfMemory | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Re-subscribe so tab renames / cwd updates reflect live in the rows.
  const tabs = useAppStore((s) => s.tabs);
  const projects = useAppStore((s) => s.projects);
  // Footer gauge context: the configured scrollback (RAM driver per terminal).
  const scrollback = useAppStore((s) => s.settings.scrollback);

  const rows = useMemo(
    () => (open ? buildRows(apps) : []),
    // tabs/projects participate so the join refreshes on store changes too.
    [open, apps, tabs, projects],
  );

  const idleTabIds = useMemo(
    () => (open ? computeIdleTabIds(apps) : []),
    [open, apps, tabs],
  );

  // Heavy usage → orange gauge + a stronger nudge to close idle terminals.
  const selfWarn =
    !!self &&
    (self.terminalCount >= HIGH_TERMINAL_COUNT ||
      self.appRssBytes >= HIGH_APP_RSS);

  // Hand the idle tabs to the global confirm dialog, then dismiss this modal so
  // the two overlays don't stack.
  function cullIdle() {
    const ids = computeIdleTabIds(apps);
    if (ids.length === 0) return;
    onClose();
    useAppStore.getState().requestCull(ids);
  }

  // Live poll: fire immediately on open, then every POLL_MS until closed.
  // Pulls both the per-terminal apps and Shellboard's own memory gauge on the
  // same timer so they stay in sync and stop together when the modal closes.
  useEffect(() => {
    if (!open) {
      setApps({});
      setSelf(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const snap = await invoke<Snapshot>("running_apps_snapshot");
        if (!cancelled) {
          setApps(snap.apps);
          setSelf(snap.selfMemory);
        }
      } catch {
        if (!cancelled) {
          setApps({});
          setSelf(null);
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelectedIdx(0);
    // Focus the container so arrow/enter/esc reach its onKeyDown — the window
    // key handler intentionally ignores those, so without focus Esc wouldn't
    // close the modal. rAF waits for the element to mount + lay out.
    requestAnimationFrame(() => listRef.current?.focus());
  }, [open]);

  // Keep the selection in range as the live list grows/shrinks.
  useEffect(() => {
    setSelectedIdx((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    itemRefs.current[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (listRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    window.addEventListener("mousedown", onDown, { capture: true });
    return () =>
      window.removeEventListener("mousedown", onDown, { capture: true });
  }, [open, onClose]);

  function jumpTo(row: Row) {
    const sessionId = row.sessionId;
    // revealTerminal owns the project/tab switch + focusedLeafId; we add an
    // explicit xterm.focus() once the tab is visible, mirroring GlobalSearch.
    void useAppStore
      .getState()
      .revealTerminal(sessionId)
      .then(() => {
        requestAnimationFrame(() => {
          try {
            getTerminal(sessionId)?.focus();
          } catch {
            /* terminal gone between poll and click — harmless */
          }
        });
      });
    onClose();
  }

  if (!open) return null;

  return (
    <div className="rapps-backdrop">
      <div
        ref={listRef}
        className="rapps"
        role="dialog"
        aria-modal="true"
        aria-label="Running apps"
        tabIndex={-1}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const row = rows[selectedIdx];
            if (row) jumpTo(row);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="rapps__header">
          <Terminal size={15} className="rapps__icon" />
          <span className="rapps__title">Running apps</span>
          <span className="rapps__spacer" />
          <span className="rapps__esc">esc</span>
        </div>
        <div className="rapps__list">
          {rows.length === 0 && (
            <div className="rapps__hint">Nothing running.</div>
          )}
          {rows.map((row, i) => (
            <button
              key={row.sessionId}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              className={`rapps__item ${i === selectedIdx ? "rapps__item--selected" : ""}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => jumpTo(row)}
            >
              <span
                className="rapps__dot"
                style={{ background: row.projectColor }}
              />
              <span className="rapps__label">
                <span className="rapps__meta">
                  {row.projectName} · {row.tabTitle}
                  {row.cwd && (
                    <span className="rapps__cwd"> · {cwdLabel(row.cwd)}</span>
                  )}
                </span>
                <span className="rapps__cmd">
                  <span className="rapps__app">{row.app.name}</span>
                  {row.app.command && row.app.command !== row.app.name && (
                    <span className="rapps__args"> {row.app.command}</span>
                  )}
                </span>
              </span>
              <span className="rapps__mem">
                {row.app.memoryBytes > 0 ? formatBytes(row.app.memoryBytes) : "—"}
              </span>
            </button>
          ))}
        </div>
        <div className="rapps__footer">
          <span>↵ jump to terminal</span>
          <span className="rapps__footer-spacer" />
          {idleTabIds.length > 0 && (
            <button
              type="button"
              className="rapps__cull"
              onClick={cullIdle}
              title="Close terminals running only an idle shell (the active tab is kept). Frees their scrollback buffers."
            >
              Close {idleTabIds.length} idle
            </button>
          )}
          {self && (
            <span
              className={`rapps__self ${selfWarn ? "rapps__self--warn" : ""}`}
              title="Shellboard's own memory (excludes the apps running in terminals). Approximate on macOS — the WebView renders out-of-process."
            >
              Shellboard ~{formatBytes(self.appRssBytes)} ·{" "}
              {self.terminalCount} {self.terminalCount === 1 ? "terminal" : "terminals"} ·{" "}
              {scrollback.toLocaleString()}-line scrollback
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
