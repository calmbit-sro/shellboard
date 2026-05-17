import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/appStore";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  GitBranch,
  Terminal as TerminalIcon,
} from "./icons";
import "./StatusBar.css";

type StatusBarProps = {
  onOpenShortcuts: () => void;
};

export function StatusBar({ onOpenShortcuts }: StatusBarProps) {
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabs = useAppStore((s) => s.tabs);
  const terminals = useAppStore((s) => s.terminals);
  const updateInfo = useAppStore((s) => s.updateInfo);

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
  const shellName = inferShell();
  const branchLabel = gitStatus?.branch
    ? middleTruncate(gitStatus.branch, 28)
    : null;

  return (
    <div className="status-bar">
      {hasTerminal && (
        <>
          <span className="status-bar__segment" title={shellName}>
            <TerminalIcon size={11} className="status-bar__icon" />
            <span>{shellName}</span>
          </span>
          <span className="status-bar__sep">·</span>
          <span className="status-bar__segment status-bar__cwd" title={cwd}>
            <Folder size={11} className="status-bar__icon" />
            <span>{abbreviatePath(cwd)}</span>
          </span>
          {branchLabel && gitStatus && (
            <>
              <span className="status-bar__sep">·</span>
              <span
                className="status-bar__segment status-bar__branch"
                title={gitTooltip(gitStatus)}
              >
                <GitBranch size={11} className="status-bar__icon" />
                <span>{branchLabel}</span>
              </span>
              {gitStatus.staged > 0 && (
                <span
                  className="status-bar__git status-bar__git--staged"
                  title="Staged changes"
                >
                  +{gitStatus.staged}
                </span>
              )}
              {gitStatus.modified > 0 && (
                <span
                  className="status-bar__git status-bar__git--modified"
                  title="Modified tracked files"
                >
                  ●{gitStatus.modified}
                </span>
              )}
              {gitStatus.untracked > 0 && (
                <span
                  className="status-bar__git status-bar__git--untracked"
                  title="Untracked files"
                >
                  ?{gitStatus.untracked}
                </span>
              )}
              {gitStatus.conflicts > 0 && (
                <span
                  className="status-bar__git status-bar__git--conflicts"
                  title="Conflicts"
                >
                  ⚠{gitStatus.conflicts}
                </span>
              )}
              {gitStatus.ahead > 0 && (
                <span
                  className="status-bar__git status-bar__git--ahead"
                  title={`${gitStatus.ahead} ahead`}
                >
                  <ArrowUp size={10} />
                  {gitStatus.ahead}
                </span>
              )}
              {gitStatus.behind > 0 && (
                <span
                  className="status-bar__git status-bar__git--behind"
                  title={`${gitStatus.behind} behind`}
                >
                  <ArrowDown size={10} />
                  {gitStatus.behind}
                </span>
              )}
            </>
          )}
        </>
      )}
      <span className="status-bar__spacer" />
      {updateInfo && (
        <button
          type="button"
          className="status-bar__update"
          title={`Update available: v${updateInfo.latest} (you're on v${updateInfo.current}). Click to open the release page.`}
          aria-label={`Download Shellboard v${updateInfo.latest}`}
          onClick={() => {
            void openUrl(updateInfo.url).catch(() => {});
          }}
        >
          ↑ v{updateInfo.latest}
        </button>
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
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "zsh";
  if (ua.includes("windows")) return "pwsh";
  return "bash";
}

/** Replace `/Users/<me>` or `/home/<me>` prefix with `~`. */
function abbreviatePath(path: string): string {
  const m = /^(?:\/Users\/|\/home\/)[^/]+(\/.*)?$/.exec(path);
  if (m) return `~${m[1] ?? ""}`;
  return path;
}

/** Keep head + tail visible, ellipsis in the middle. */
function middleTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = max - 1; // accounting for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
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
  if (s.conflicts)
    parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"}`);
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

