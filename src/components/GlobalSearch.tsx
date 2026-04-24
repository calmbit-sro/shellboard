import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { collectLeaves } from "../utils/mosaic";
import { listTerminals, getTerminal } from "../utils/terminalRegistry";
import "./GlobalSearch.css";

type Hit = {
  terminalId: string;
  tabId: string;
  tabTitle: string;
  projectName: string;
  projectColor: string;
  line: number;
  text: string;
};

type GlobalSearchProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Scan every mounted xterm's buffer for matches. Cheap at typical buffer
 * sizes (scrollback is usually a few thousand lines per terminal); we
 * run it synchronously when the query changes.
 */
function search(query: string, tabsById: Map<string, unknown>): Hit[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const state = useAppStore.getState();
  const hits: Hit[] = [];

  for (const { id, xterm } of listTerminals()) {
    // Find the owning tab (scan tabs, each has a mosaic of leaf ids).
    const tab = state.tabs.find(
      (t) => t.mosaic && collectLeaves(t.mosaic).includes(id),
    );
    if (!tab) continue;
    const project = state.projects.find((p) => p.id === tab.projectId);
    const projectName = project?.name ?? "";
    const projectColor = project?.color ?? "#0a84ff";

    const buf = xterm.buffer.active;
    // Search the scrollback + active region; length covers both.
    const total = buf.length;
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.toLowerCase().includes(q)) {
        hits.push({
          terminalId: id,
          tabId: tab.id,
          tabTitle: tab.title,
          projectName,
          projectColor,
          line: i,
          text: text.trim(),
        });
        // Cap per-terminal to keep the UI snappy for runaway matches.
        if (hits.length >= 200) break;
      }
    }
    if (hits.length >= 200) break;
  }

  // Unused arg — satisfying lint without changing call site.
  void tabsById;
  return hits;
}

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const tabs = useAppStore((s) => s.tabs);
  const tabsById = useMemo(
    () => new Map(tabs.map((t) => [t.id, t])),
    [tabs],
  );

  const hits = useMemo(
    () => (open ? search(query, tabsById) : []),
    [query, open, tabsById],
  );

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIdx(0);
  }, [open]);

  useEffect(() => {
    itemRefs.current[selectedIdx]?.scrollIntoView({
      block: "nearest",
    });
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

  function jumpTo(hit: Hit) {
    const store = useAppStore.getState();
    const tab = store.tabs.find((t) => t.id === hit.tabId);
    if (!tab) return;
    // Switch project if needed (always set active so setActiveTab lands).
    if (tab.projectId !== store.activeProjectId) {
      void store.setActiveProject(tab.projectId).then(() => {
        store.setActiveTab(hit.tabId);
        scrollToLine(hit.terminalId, hit.line);
      });
    } else {
      store.setActiveTab(hit.tabId);
      scrollToLine(hit.terminalId, hit.line);
    }
    onClose();
  }

  function scrollToLine(terminalId: string, line: number) {
    const xterm = getTerminal(terminalId);
    if (!xterm) return;
    // Give the tab switch a frame to commit visibility before scrolling.
    requestAnimationFrame(() => {
      try {
        xterm.scrollToLine(line);
        xterm.focus();
      } catch {
        /* line out of range after writes; swallow */
      }
    });
  }

  if (!open) return null;

  return (
    <div className="gsearch-backdrop">
      <div ref={listRef} className="gsearch">
        <input
          autoFocus
          type="text"
          placeholder="Search across all terminals…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedIdx((i) => Math.min(hits.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = hits[selectedIdx];
              if (hit) jumpTo(hit);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="gsearch__input"
        />
        <div className="gsearch__list">
          {!query && (
            <div className="gsearch__hint">
              Type to search buffers of all open terminals.
            </div>
          )}
          {query && hits.length === 0 && (
            <div className="gsearch__hint">No matches.</div>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.terminalId}-${hit.line}-${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              className={`gsearch__item ${i === selectedIdx ? "gsearch__item--selected" : ""}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => jumpTo(hit)}
            >
              <span
                className="gsearch__dot"
                style={{ background: hit.projectColor }}
              />
              <span className="gsearch__label">
                <span className="gsearch__meta">
                  {hit.projectName} · {hit.tabTitle}{" "}
                  <span className="gsearch__line">:{hit.line + 1}</span>
                </span>
                <span className="gsearch__text">
                  {highlight(hit.text, query)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: Array<string | { match: string }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push({ match: text.slice(idx, idx + needle.length) });
    i = idx + needle.length;
  }
  return parts.map((p, k) =>
    typeof p === "string" ? (
      <span key={k}>{p}</span>
    ) : (
      <mark key={k} className="gsearch__match">
        {p.match}
      </mark>
    ),
  );
}
