import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../store/appStore";
import "./StatusBar.css";

type StatusBarProps = {
  onOpenShortcuts: () => void;
};

function basename(path: string): string {
  if (!path) return "";
  const norm = path.replace(/[\\/]+$/, "");
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function StatusBar({ onOpenShortcuts }: StatusBarProps) {
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabs = useAppStore((s) => s.tabs);
  const terminals = useAppStore((s) => s.terminals);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const focusedLeaf = activeTab?.focusedLeafId ?? null;
  const cwd = focusedLeaf ? terminals[focusedLeaf]?.cwd ?? "" : "";

  type GitStatus = {
    branch: string | null;
    ahead: number;
    behind: number;
    staged: number;
    modified: number;
    untracked: number;
    conflicts: number;
  };

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  // Fetch app version once per mount — it never changes during runtime.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getVersion();
        if (!cancelled) setVersion(v);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch git status when cwd changes, plus a light poll every 5s so that
  // commits / stages / pushes reflect without the user changing directory.
  // git status --porcelain is <30 ms so the cost is negligible.
  useEffect(() => {
    if (!cwd) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    async function fetchStatus() {
      try {
        const s = await invoke<GitStatus | null>("git_status", { path: cwd });
        if (!cancelled) setGitStatus(s);
      } catch {
        if (!cancelled) setGitStatus(null);
      }
    }
    void fetchStatus();
    const timer = setInterval(fetchStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd]);

  const hasTerminal = !!(activeTab && cwd);
  const shellName = basename(
    (typeof navigator !== "undefined" &&
      (window as unknown as { __TAURI_SHELL_NAME__?: string })
        .__TAURI_SHELL_NAME__) ||
      inferShell(),
  );

  return (
    <div className="status-bar">
      {hasTerminal && (
        <>
          <span className="status-bar__segment status-bar__shell">
            {shellName || "shell"}
          </span>
          <span className="status-bar__sep">·</span>
          <span
            className="status-bar__segment status-bar__cwd"
            title={cwd}
          >
            {abbreviatePath(cwd)}
          </span>
          {gitStatus?.branch && (
            <>
              <span className="status-bar__sep">·</span>
              <span
                className="status-bar__segment status-bar__branch"
                title={gitTooltip(gitStatus)}
              >
                <span className="status-bar__branch-name">
                  ⎇ {gitStatus.branch}
                </span>
                {gitStatus.staged > 0 && (
                  <span
                    className="status-bar__git-staged"
                    title="Staged changes"
                  >
                    +{gitStatus.staged}
                  </span>
                )}
                {gitStatus.modified > 0 && (
                  <span
                    className="status-bar__git-modified"
                    title="Modified tracked files"
                  >
                    ●{gitStatus.modified}
                  </span>
                )}
                {gitStatus.untracked > 0 && (
                  <span
                    className="status-bar__git-untracked"
                    title="Untracked files"
                  >
                    ?{gitStatus.untracked}
                  </span>
                )}
                {gitStatus.conflicts > 0 && (
                  <span
                    className="status-bar__git-conflicts"
                    title="Conflicts"
                  >
                    ⚠{gitStatus.conflicts}
                  </span>
                )}
                {gitStatus.ahead > 0 && (
                  <span className="status-bar__git-ahead">
                    ↑{gitStatus.ahead}
                  </span>
                )}
                {gitStatus.behind > 0 && (
                  <span className="status-bar__git-behind">
                    ↓{gitStatus.behind}
                  </span>
                )}
              </span>
            </>
          )}
        </>
      )}
      <button
        type="button"
        className="status-bar__help"
        onClick={onOpenShortcuts}
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
      >
        ?
      </button>
      <span className="status-bar__version" title="Shellboard version">
        {version ? `v${version}` : ""}
      </span>
    </div>
  );
}

function inferShell(): string {
  // We don't have direct env access in the renderer, but the common case is
  // /bin/zsh on macOS. Good enough as a label; the real truth lives in PTY.
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "zsh";
  if (ua.includes("windows")) return "pwsh";
  return "bash";
}

/**
 * Shorten paths to fit the status bar: /Users/petr/Projects/foo → ~/P…/foo
 * for anything starting with the home directory.
 */
function abbreviatePath(path: string): string {
  // Very basic heuristic — replace /Users/<me> or /home/<me> prefix with ~.
  const m = /^(?:\/Users\/|\/home\/)[^/]+(\/.*)?$/.exec(path);
  if (m) return `~${m[1] ?? ""}`;
  return path;
}

type GitInfo = {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
};

function gitTooltip(s: GitInfo): string {
  const lines: string[] = [];
  if (s.branch) lines.push(`Branch: ${s.branch}`);
  const parts: string[] = [];
  if (s.staged) parts.push(`${s.staged} staged`);
  if (s.modified) parts.push(`${s.modified} modified`);
  if (s.untracked) parts.push(`${s.untracked} untracked`);
  if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"}`);
  if (parts.length) lines.push(parts.join(", "));
  else lines.push("Clean working tree");
  if (s.ahead || s.behind) {
    const ab: string[] = [];
    if (s.ahead) ab.push(`${s.ahead} ahead`);
    if (s.behind) ab.push(`${s.behind} behind`);
    lines.push(ab.join(", "));
  }
  return lines.join("\n");
}
