import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  useAppStore,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "../store/appStore";
import { ProjectList } from "./ProjectList";
import { randomProjectColor } from "./ColorPicker";
import { Cog, Logo, Plus, Search, SidebarIcon } from "./icons";
import "./Sidebar.css";

function basename(path: string): string {
  if (!path) return "project";
  const norm = path.replace(/[\\/]+$/, "");
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

type SidebarProps = {
  onOpenSettings: () => void;
  onAddProject: (groupId?: string | null) => void;
};

export function Sidebar({ onOpenSettings, onAddProject }: SidebarProps) {
  const width = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const commitSidebarWidth = useAppStore((s) => s.commitSidebarWidth);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const addGroup = useAppStore((s) => s.addGroup);
  const addProject = useAppStore((s) => s.addProject);
  const requestGroupRename = useAppStore((s) => s.requestGroupRename);

  const [dragging, setDragging] = useState(false);
  const [fileHover, setFileHover] = useState(false);
  const [search, setSearch] = useState("");
  const asideRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  async function onAddGroup() {
    const g = await addGroup("New group");
    requestGroupRename(g.id);
  }

  useEffect(() => {
    const unlistenPromise = getCurrentWebviewWindow().onDragDropEvent(
      async (e) => {
        const aside = asideRef.current;
        if (!aside) return;
        const inside = (pos: { x: number; y: number }) => {
          const r = aside.getBoundingClientRect();
          const x = pos.x / window.devicePixelRatio;
          const y = pos.y / window.devicePixelRatio;
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        };
        const payload = e.payload;
        if (payload.type === "over") {
          setFileHover(inside(payload.position));
        } else if (payload.type === "drop") {
          const over = inside(payload.position);
          setFileHover(false);
          if (!over) return;
          for (const path of payload.paths) {
            await addProject({
              path,
              name: basename(path),
              color: randomProjectColor(),
            });
          }
        } else {
          setFileHover(false);
        }
      },
    );
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [addProject]);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      setSidebarWidth(e.clientX);
    }
    function onUp(e: MouseEvent) {
      setDragging(false);
      void commitSidebarWidth(
        Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, e.clientX)),
      );
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, setSidebarWidth, commitSidebarWidth]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return (
    <aside
      ref={asideRef}
      className={`sidebar ${fileHover ? "sidebar--drop-target" : ""}`}
      style={{ width }}
    >
      <div className="sidebar__header">
        <Logo size={20} color="var(--accent-strong)" />
        <span className="sidebar__title">ShellBoard</span>
        <span className="sidebar__spacer" />
        <button
          type="button"
          className="sidebar__icon-btn"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onClick={() => void toggleSidebar()}
        >
          <SidebarIcon size={13} />
        </button>
      </div>

      <div className="sidebar__search">
        <div className="sidebar__search-field">
          <Search size={11} />
          <input
            ref={searchRef}
            type="text"
            className="sidebar__search-input"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.preventDefault();
                e.stopPropagation();
                setSearch("");
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="sidebar__search-esc"
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              esc
            </button>
          )}
        </div>
      </div>

      <div className="sidebar__list">
        <ProjectList onAddProject={onAddProject} search={search} />
      </div>

      <div className="sidebar__footer">
        <button
          type="button"
          className="sidebar__footer-btn sidebar__footer-btn--text"
          onClick={() => void onAddGroup()}
          title="New group"
        >
          <Plus size={12} />
          <span>New group…</span>
        </button>
        <button
          type="button"
          className="sidebar__icon-btn"
          aria-label="Add project"
          title="Add project"
          onClick={() => onAddProject()}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          className="sidebar__icon-btn"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <Cog size={13} />
        </button>
      </div>

      <div
        className={`sidebar__grip ${dragging ? "sidebar__grip--active" : ""}`}
        onMouseDown={startDrag}
        aria-hidden
      />
    </aside>
  );
}
