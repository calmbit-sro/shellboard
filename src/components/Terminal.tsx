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
import { markTerminalBufferDirty } from "../utils/sessionSerialize";
import { addPromptMark, clearPromptMarks } from "../utils/promptMarks";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

const IS_LINUX =
  typeof navigator !== "undefined" && /Linux/.test(navigator.platform);

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
  const fitAndSyncRef = useRef<(() => void) | null>(null);

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
    // Clickable URLs — only Cmd (macOS) / Ctrl (others) + click opens in the
    // system browser. Plain click is a no-op so the user can drag-select a
    // URL to copy without it being yanked away into the browser.
    xterm.loadAddon(
      new WebLinksAddon((event, uri) => {
        const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
        if (!modifier) return;
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
        // The callback runs after xterm's async parse — by then the mount
        // fit() has resized the buffer, and that reflow can leave the
        // viewport anchored above the end. Pin it back to the bottom so the
        // prompt lands where the user left it (and subsequent PTY writes
        // keep auto-scrolling).
        xterm.write(saved, () => xterm.scrollToBottom());
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

    // Middle-click paste. On macOS/Windows there's no native middle-click
    // primary-selection paste, so we synthesize one: copy-on-select keeps the
    // latest selection in the regular clipboard, and reading from there gives
    // the same effect. preventDefault on mousedown blocks the browser's
    // autoscroll/middle-button gesture.
    // On Linux/WebKitGTK the webview already performs a native middle-click
    // primary-selection paste into xterm's textarea, so doing it ourselves
    // would paste twice. We still preventDefault (to suppress autoscroll) but
    // skip the manual paste and let the native one through.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (IS_LINUX) return;
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

    // Single source of truth for "make xterm match the container, then push
    // those dimensions to the PTY". Used at mount, on tab activation, and
    // after font changes — anywhere the container may have been measured
    // wrong or the cell metrics changed without a corresponding container
    // resize. ResizeObserver-driven resizes during a drag still go through
    // the debounced xterm.onResize path below to avoid SIGWINCH spam.
    const fitAndSync = () => {
      try {
        fit.fit();
      } catch {
        /* container may be hidden or not laid out yet */
      }
      void invoke("resize_pty", {
        id: terminalId,
        cols: xterm.cols,
        rows: xterm.rows,
      });
    };
    fitAndSyncRef.current = fitAndSync;
    fitAndSync();

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

    // OSC 133 shell-integration marks: A = prompt start (jump anchor),
    // C = command started, D;<code> = command finished. Emitted by the
    // hooks pty.rs injects when shell integration is on.
    disposables.push(
      xterm.parser.registerOscHandler(133, (data) => {
        const kind = data[0];
        if (kind === "A") {
          const marker = xterm.registerMarker(0);
          if (marker) addPromptMark(terminalId, marker);
        } else if (kind === "C") {
          useAppStore.getState().handleCommandStart(terminalId);
        } else if (kind === "D") {
          const code = parseInt(data.slice(2), 10);
          useAppStore
            .getState()
            .handleCommandEnd(terminalId, Number.isFinite(code) ? code : 0);
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
          // new output. Heavily debounced inside the store; marking dirty
          // means only this terminal gets re-serialized by the save.
          markTerminalBufferDirty(terminalId);
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

    // Push every xterm size change to the PTY immediately. Earlier this was
    // debounced 100 ms to avoid SIGWINCH spam during a window drag, but the
    // ResizeObserver→RAF→fit chain already coalesces to ~60 Hz, so a second
    // debounce layer just left a window where xterm.cols/rows had updated
    // but the PTY hadn't — TUI apps (Claude Code/Ink) rendered with stale
    // dimensions and left dirty cells in the freshly-grown area. Sending
    // eagerly keeps xterm and PTY in lockstep frame-by-frame.
    disposables.push(
      xterm.onResize(({ cols, rows }) => {
        void invoke("resize_pty", { id: terminalId, cols, rows });
        // A resize reflows soft-wrap boundaries in the buffer, so the cached
        // serialized snapshot no longer matches what's on screen.
        markTerminalBufferDirty(terminalId);
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
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      for (const d of disposables) d.dispose();
      for (const off of unlisteners) off();
      unregisterTerminal(terminalId);
      clearPromptMarks(terminalId);
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      fitAndSyncRef.current = null;
    };
  }, [terminalId]);

  // When this terminal becomes active, give it focus and re-fit. Hidden
  // slots are laid out (visibility: hidden, inset: 0) and ResizeObserver
  // tracks them, but if the container wasn't yet at its final size at mount
  // — or the PTY missed an earlier resize — the saved cols/rows can be
  // stale. Re-fitting on activation is cheap and prevents the symptom where
  // typed input appears below the prompt because PTY cols ≠ xterm cols.
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      fitAndSyncRef.current?.();
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  // Apply font settings live to an already-mounted xterm.
  useEffect(() => {
    const xterm = xtermRef.current;
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
      fitAndSyncRef.current?.();
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
    // Spread to a fresh object — v6 compares option objects by reference and
    // skips no-op assignments, so reapplying the same cached preset wouldn't
    // take effect.
    const theme = { ...findTheme(themeId).theme };
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
