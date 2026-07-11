import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { collectLeaves } from "../utils/mosaic";
import { listTerminals, getTerminal } from "../utils/terminalRegistry";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { Search } from "./icons";
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

/** Only the most recent lines of each terminal are scanned — at the maximum
 * scrollback setting (100k lines) a full walk of every buffer would block the
 * main thread for noticeable stretches. */
const MAX_SCAN_LINES = 10_000;
const MAX_HITS = 200;

/**
 * Scan every mounted xterm's buffer for matches. Bounded by MAX_SCAN_LINES
 * per terminal and MAX_HITS overall, and runs on the debounced query rather
 * than per keystroke.
 */
function search(query: string): Hit[] {
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
    for (let i = Math.max(0, total - MAX_SCAN_LINES); i < total; i++) {
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
        // Cap to keep the UI snappy for runaway matches.
        if (hits.length >= MAX_HITS) break;
      }
    }
    if (hits.length >= MAX_HITS) break;
  }

  return hits;
}

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useFocusTrap(listRef, open);

  // Debounce the buffer scan — searching on every keystroke visibly blocks
  // typing once many terminals with large scrollbacks are mounted.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(handle);
  }, [query]);

  const hits = useMemo(
    () => (open ? search(debouncedQuery) : []),
    [debouncedQuery, open],
  );

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebouncedQuery("");
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
      <div
        ref={listRef}
        className="gsearch"
        role="dialog"
        aria-modal="true"
        aria-label="Search all terminals"
      >
        <div className="gsearch__header">
          <Search size={15} className="gsearch__icon" />
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
          <span className="gsearch__esc">esc</span>
        </div>
        <div className="gsearch__list">
          {!query && (
            <div className="gsearch__hint">
              Type to search buffers of all open terminals.
            </div>
          )}
          {query && query === debouncedQuery && hits.length === 0 && (
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
        <div className="gsearch__footer">
          <span>↵ jump to tab</span>
          <span className="gsearch__footer-spacer" />
          <span>scrollback included</span>
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
