import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  readText as readClipboard,
  writeText as writeClipboard,
} from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { scheduleSessionSave, useAppStore } from "../store/appStore";
import { findTheme } from "../utils/themes";
import { collectLeaves } from "../utils/mosaic";
import {
  registerTerminal,
  unregisterTerminal,
} from "../utils/terminalRegistry";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

type PtyDataPayload = { data: string };

type TerminalProps = {
  terminalId: string;
  isActive: boolean;
};

export function Terminal({ terminalId, isActive }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);

  const fontFamily = useAppStore((s) => s.settings.terminalFontFamily);
  const fontSize = useAppStore((s) => s.settings.terminalFontSize);
  const themeId = useAppStore((s) => s.settings.terminalTheme);
  const scrollback = useAppStore((s) => s.settings.scrollback);
  const searchingTerminalId = useAppStore((s) => s.searchingTerminalId);
  const setSearchingTerminal = useAppStore((s) => s.setSearchingTerminal);
  const isSearching = searchingTerminalId === terminalId;

  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialSettings = useAppStore.getState().settings;
    const xterm = new XTerm({
      cursorBlink: true,
      fontFamily: initialSettings.terminalFontFamily,
      fontSize: initialSettings.terminalFontSize,
      theme: findTheme(initialSettings.terminalTheme).theme,
      scrollback: initialSettings.scrollback,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const search = new SearchAddon();
    xterm.loadAddon(search);
    const serialize = new SerializeAddon();
    xterm.loadAddon(serialize);
    // Clickable URLs — Cmd/Ctrl + click opens in the system browser.
    xterm.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri).catch(() => {});
      }),
    );
    xterm.open(container);
    xtermRef.current = xterm;
    fitRef.current = fit;
    searchRef.current = search;
    registerTerminal(terminalId, xterm, serialize);

    // If we're restoring a session, replay the saved scrollback into this
    // new terminal BEFORE any live PTY data arrives. Writing into xterm
    // before we subscribe to the data event guarantees the saved history
    // lands above the fresh prompt.
    const saved = useAppStore.getState().consumeRestoredBuffer(terminalId);
    if (saved) {
      try {
        xterm.write(saved);
      } catch {
        /* ignore malformed saved data */
      }
    }

    // Shell startup on zsh + powerlevel10k (and a few others) emits
    // `\e[2J\e[3J\e[H` on the first real prompt: clear scrollback, clear
    // viewport, cursor home. That wipes everything we just restored and
    // repaints the prompt at the top of the window. During a short grace
    // window right after restore, strip those three sequences so the
    // restored content stays visible and the shell's prompt lands on the
    // line below it (the cursor is already parked at the end of the
    // restored content by `xterm.write(saved)`).
    let filterStartupClears = !!saved;
    if (filterStartupClears) {
      setTimeout(() => {
        filterStartupClears = false;
      }, 3000);
    }
    // \e[2J, \e[3J (any single digit), \e[H, \e[;H, \e[1;1H
    const STARTUP_CLEAR_RE = /\x1b\[(?:[23]J|H|;H|1;1H)/g;

    // Copy-on-select: when the user releases the mouse after dragging a
    // selection, push it to the system clipboard. Matches iTerm2 /
    // X11 convention. Manual Cmd+C still works as an override.
    const onMouseUp = () => {
      if (xterm.hasSelection()) {
        const text = xterm.getSelection();
        if (text) void writeClipboard(text).catch(() => {});
      }
    };
    container.addEventListener("mouseup", onMouseUp);

    // Middle-click paste (X11 convention). Tauri can't read the X11 primary
    // selection, but since copy-on-select keeps the latest selection in the
    // regular clipboard, reading from there gives the same effect.
    // preventDefault on mousedown blocks the browser's autoscroll/middle-
    // button gesture on Windows/Linux.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      void readClipboard()
        .then((text) => {
          if (text) xterm.paste(text);
        })
        .catch(() => {});
    };
    container.addEventListener("mousedown", onMouseDown);

    // Copy/paste convention:
    //   macOS:    Cmd+C (smart — copy if selection, else no-op), Cmd+V paste
    //   Linux/Win: Ctrl+Shift+C copy, Ctrl+Shift+V paste
    // Plain Ctrl+C always sends SIGINT (we don't intercept it).
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const key = e.key.toLowerCase();
      const isCopy = IS_MAC
        ? e.metaKey && !e.shiftKey && !e.altKey && key === "c"
        : e.ctrlKey && e.shiftKey && !e.altKey && key === "c";
      if (isCopy) {
        if (xterm.hasSelection()) {
          const text = xterm.getSelection();
          if (text) void writeClipboard(text).catch(() => {});
        }
        e.preventDefault();
        return false;
      }
      const isPaste = IS_MAC
        ? e.metaKey && !e.shiftKey && !e.altKey && key === "v"
        : e.ctrlKey && e.shiftKey && !e.altKey && key === "v";
      if (isPaste) {
        void readClipboard()
          .then((text) => {
            if (text) xterm.paste(text);
          })
          .catch(() => {});
        e.preventDefault();
        return false;
      }
      return true;
    });

    try {
      fit.fit();
    } catch {
      /* container may not be laid out yet */
    }

    // Sync PTY to whatever xterm measured.
    void invoke("resize_pty", {
      id: terminalId,
      cols: xterm.cols,
      rows: xterm.rows,
    });

    const disposables: { dispose: () => void }[] = [];
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    // OSC 7 tracks cwd: ESC ] 7 ; file://host/path ESC \
    // Requires shell cooperation (zsh's chpwd hook, bash's PROMPT_COMMAND, etc.)
    disposables.push(
      xterm.parser.registerOscHandler(7, (data) => {
        const m = /^file:\/\/[^/]*(\/.+)$/.exec(data);
        if (m) {
          try {
            const decoded = decodeURIComponent(m[1]);
            useAppStore.getState().updateTerminalCwd(terminalId, decoded);
          } catch {
            /* malformed percent-encoding — ignore */
          }
        }
        return true;
      }),
    );

    (async () => {
      const offData = await listen<PtyDataPayload>(
        `pty://${terminalId}/data`,
        (event) => {
          let data = event.payload.data;
          if (filterStartupClears) {
            data = data.replace(STARTUP_CLEAR_RE, "");
          }
          xterm.write(data);
          // Flag the owning tab as having background activity if the user
          // isn't currently looking at it.
          useAppStore.getState().markTabActivity(terminalId);
          // Ask for a session save so scrollback gets snapshotted after
          // new output. Heavily debounced inside the store.
          scheduleSessionSave();
        },
      );
      const offExit = await listen(`pty://${terminalId}/exit`, () => {
        void useAppStore.getState().handleTerminalExit(terminalId);
      });
      if (disposed) {
        offData();
        offExit();
        return;
      }
      unlisteners.push(offData, offExit);
    })();

    disposables.push(
      xterm.onData((data) => {
        // If the owning tab has broadcast mode on, fan out input to every
        // panel in the tab; otherwise just write to this terminal.
        const state = useAppStore.getState();
        const tab = state.tabs.find(
          (t) => t.mosaic && collectLeaves(t.mosaic).includes(terminalId),
        );
        if (tab && tab.broadcastInput && tab.mosaic) {
          for (const id of collectLeaves(tab.mosaic)) {
            void invoke("write_to_pty", { id, data });
          }
        } else {
          void invoke("write_to_pty", { id: terminalId, data });
        }
      }),
    );

    // Debounce resize_pty so a window drag doesn't send dozens of SIGWINCH
    // signals per second to the shell — that causes readline to redraw
    // repeatedly, which in certain states leaves phantom prompt lines
    // behind. We ship the final size ~100 ms after the user stops dragging.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingResize: { cols: number; rows: number } | null = null;
    disposables.push(
      xterm.onResize(({ cols, rows }) => {
        pendingResize = { cols, rows };
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          if (pendingResize) {
            void invoke("resize_pty", {
              id: terminalId,
              cols: pendingResize.cols,
              rows: pendingResize.rows,
            });
            pendingResize = null;
          }
        }, 100);
      }),
    );

    // Visual bell: reuse the activity mechanism so the tab's activity dot
    // lights up. For the currently-active tab no visual is shown (the user
    // is already looking), which matches iTerm2 behaviour.
    disposables.push(
      xterm.onBell(() => {
        useAppStore.getState().markTabActivity(terminalId);
      }),
    );

    // Coalesce ResizeObserver callbacks into one fit per animation frame.
    // Without this, a smooth drag fires the callback many times per frame
    // and fit() thrashes the xterm renderer.
    let fitRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (fitRaf !== null) return;
      fitRaf = requestAnimationFrame(() => {
        fitRaf = null;
        try {
          fit.fit();
        } catch {
          /* ignore transient layout errors */
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (fitRaf !== null) cancelAnimationFrame(fitRaf);
      if (resizeTimer) clearTimeout(resizeTimer);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      for (const d of disposables) d.dispose();
      for (const off of unlisteners) off();
      unregisterTerminal(terminalId);
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [terminalId]);

  // When this terminal becomes active, just give it focus. Sizing stays
  // correct because hidden slots keep their layout (visibility: hidden),
  // so ResizeObserver has been tracking size all along.
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  // Apply font settings live to an already-mounted xterm.
  useEffect(() => {
    const xterm = xtermRef.current;
    const fit = fitRef.current;
    if (!xterm) return;
    if (
      xterm.options.fontFamily === fontFamily &&
      xterm.options.fontSize === fontSize
    ) {
      return;
    }
    xterm.options = { fontFamily, fontSize };
    try {
      xterm.clearTextureAtlas();
    } catch {
      /* renderer may not support it */
    }
    const raf = requestAnimationFrame(() => {
      try {
        fit?.fit();
      } catch {
        /* container may be hidden */
      }
      try {
        xterm.refresh(0, Math.max(0, xterm.rows - 1));
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [fontFamily, fontSize]);

  // Apply theme changes live.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    const theme = findTheme(themeId).theme;
    xterm.options = { theme };
    try {
      xterm.clearTextureAtlas();
    } catch {
      /* ignore */
    }
    try {
      xterm.refresh(0, Math.max(0, xterm.rows - 1));
    } catch {
      /* ignore */
    }
  }, [themeId]);

  // Apply scrollback size changes live.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    if (xterm.options.scrollback === scrollback) return;
    xterm.options = { scrollback };
  }, [scrollback]);

  function runSearch(dir: "next" | "prev", term: string) {
    const s = searchRef.current;
    if (!s || !term) return;
    if (dir === "next") s.findNext(term);
    else s.findPrevious(term);
  }

  function closeSearch() {
    const s = searchRef.current;
    try {
      s?.clearDecorations();
    } catch {
      /* older API */
    }
    setSearchTerm("");
    setSearchingTerminal(null);
    xtermRef.current?.focus();
  }

  return (
    <div className="terminal-wrapper">
      <div ref={containerRef} className="terminal-container" />
      {isSearching && (
        <div className="terminal-search" onMouseDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            type="text"
            value={searchTerm}
            placeholder="Find…"
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (e.target.value) runSearch("next", e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) runSearch("prev", searchTerm);
                else runSearch("next", searchTerm);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button
            type="button"
            onClick={() => runSearch("prev", searchTerm)}
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => runSearch("next", searchTerm)}
            aria-label="Next match"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Close search"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
