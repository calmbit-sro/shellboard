import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  useAppStore,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "../store/appStore";
import { ProjectList } from "./ProjectList";
import { randomProjectColor } from "./ColorPicker";
import "./Sidebar.css";

function basename(path: string): string {
  if (!path) return "project";
  const norm = path.replace(/[\\/]+$/, "");
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

type SidebarProps = {
  onOpenSettings: () => void;
  /** Groups can pre-select themselves in the add-project flow by passing
   * their id; the `+` button passes nothing for "no group". */
  onAddProject: (groupId?: string | null) => void;
};

export function Sidebar({ onOpenSettings, onAddProject }: SidebarProps) {
  const width = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const commitSidebarWidth = useAppStore((s) => s.commitSidebarWidth);
  const addGroup = useAppStore((s) => s.addGroup);
  const addProject = useAppStore((s) => s.addProject);
  const requestGroupRename = useAppStore((s) => s.requestGroupRename);

  const [dragging, setDragging] = useState(false);
  const [fileHover, setFileHover] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);

  async function onAddGroup() {
    const g = await addGroup("New group");
    requestGroupRename(g.id);
  }

  // Listen for native file-drop events and turn dropped folders into
  // projects. Only fire when the cursor is over the sidebar element —
  // the DragDrop event is window-wide so we gate by hit-testing.
  useEffect(() => {
    const unlistenPromise = getCurrentWebviewWindow().onDragDropEvent(
      async (e) => {
        const aside = asideRef.current;
        if (!aside) return;
        const inside = (pos: { x: number; y: number }) => {
          const r = aside.getBoundingClientRect();
          // DragDropEvent position is in physical pixels for some platforms;
          // divide by devicePixelRatio to get CSS pixels.
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

  // Global mousemove/mouseup handlers active only while dragging the grip.
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
        <span className="sidebar__title">Projects</span>
        <div className="sidebar__header-actions">
          <button
            type="button"
            className="sidebar__icon-btn"
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            ⚙
          </button>
          <button
            type="button"
            className="sidebar__icon-btn"
            aria-label="Add group"
            title="Add group"
            onClick={() => void onAddGroup()}
          >
            ☰
          </button>
          <button
            type="button"
            className="sidebar__icon-btn"
            aria-label="Add project"
            title="Add project"
            onClick={() => onAddProject()}
          >
            +
          </button>
        </div>
      </div>
      <div className="sidebar__list">
        <ProjectList onAddProject={onAddProject} />
      </div>
      <div
        className={`sidebar__grip ${dragging ? "sidebar__grip--active" : ""}`}
        onMouseDown={startDrag}
        aria-hidden
      />
    </aside>
  );
}
