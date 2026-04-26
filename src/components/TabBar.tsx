import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore, type Tab } from "../store/appStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { cwdLabel } from "../utils/path";
import "./TabBar.css";

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const terminals = useAppStore((s) => s.terminals);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const addTab = useAppStore((s) => s.addTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const reorderTab = useAppStore((s) => s.reorderTab);
  const closeOtherTabs = useAppStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useAppStore((s) => s.closeTabsToRight);
  const duplicateTab = useAppStore((s) => s.duplicateTab);
  const requestTabRename = useAppStore((s) => s.requestTabRename);
  const renamingTabId = useAppStore((s) => s.renamingTabId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; tabId: string } | null>(
    null,
  );

  useEffect(() => {
    if (renamingTabId) {
      setEditingId(renamingTabId);
      requestTabRename(null);
    }
  }, [renamingTabId, requestTabRename]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  if (!activeProjectId) return null;

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const groupTabs = tabs.filter((t) => t.projectId === activeProjectId);

  function onDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    reorderTab(String(active.id), String(over.id));
  }

  const draggedTab = activeDragId
    ? groupTabs.find((t) => t.id === activeDragId)
    : null;

  function tabDisplayTitle(tab: Tab): string {
    if (tab.customTitle) return tab.title;
    const leafId = tab.focusedLeafId;
    const cwd = leafId ? terminals[leafId]?.cwd : undefined;
    if (!cwd) return tab.title;
    return cwdLabel(cwd);
  }

  function buildTabMenu(tabId: string): MenuItem[] {
    const tab = groupTabs.find((t) => t.id === tabId);
    if (!tab) return [];
    const idx = groupTabs.findIndex((t) => t.id === tabId);
    const hasOthers = groupTabs.length > 1;
    const hasRight = idx !== -1 && idx < groupTabs.length - 1;
    return [
      {
        label: "Rename",
        onClick: () => setEditingId(tabId),
      },
      {
        label: "Duplicate",
        onClick: () => void duplicateTab(tabId),
      },
      {
        label: "Close",
        onClick: () => void closeTab(tabId),
      },
      {
        label: "Close others",
        onClick: () => void closeOtherTabs(tabId),
        disabled: !hasOthers,
      },
      {
        label: "Close to the right",
        onClick: () => void closeTabsToRight(tabId),
        disabled: !hasRight,
      },
    ];
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveDragId(null)}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    >
      <div
        className="tab-bar"
        role="tablist"
        style={
          {
            "--tab-accent": activeProject?.color ?? "#0a84ff",
          } as CSSProperties
        }
      >
        <SortableContext
          items={groupTabs.map((t) => t.id)}
          strategy={horizontalListSortingStrategy}
        >
          {groupTabs.map((tab) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              displayTitle={tabDisplayTitle(tab)}
              isActive={tab.id === activeTabId}
              isEditing={editingId === tab.id}
              onActivate={() => setActiveTab(tab.id)}
              onEdit={() => setEditingId(tab.id)}
              onClose={() => void closeTab(tab.id)}
              onContextMenu={(x, y) => setCtx({ x, y, tabId: tab.id })}
              onCommitRename={(next) => {
                setEditingId(null);
                const trimmed = next.trim();
                if (trimmed && trimmed !== tab.title) {
                  renameTab(tab.id, trimmed);
                }
              }}
              onCancelEdit={() => setEditingId(null)}
            />
          ))}
        </SortableContext>
        <button
          type="button"
          className="tab-bar__add"
          aria-label="New tab"
          onClick={() => void addTab()}
        >
          +
        </button>
      </div>
      <DragOverlay dropAnimation={null}>
        {draggedTab ? (
          <TabClone displayTitle={tabDisplayTitle(draggedTab)} />
        ) : null}
      </DragOverlay>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildTabMenu(ctx.tabId)}
          onClose={() => setCtx(null)}
        />
      )}
    </DndContext>
  );
}

type SortableTabProps = {
  tab: Tab;
  /** Computed caption — basename(focused panel cwd) for non-custom tabs,
   * tab.title otherwise. */
  displayTitle: string;
  isActive: boolean;
  isEditing: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (value: string) => void;
  onCancelEdit: () => void;
};

function SortableTab({
  tab,
  displayTitle,
  isActive,
  isEditing,
  onActivate,
  onEdit,
  onClose,
  onContextMenu,
  onCommitRename,
  onCancelEdit,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, disabled: isEditing });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const dragProps = isEditing ? {} : { ...attributes, ...listeners };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...dragProps}
      role="tab"
      aria-selected={isActive}
      className={`tab ${isActive ? "tab--active" : ""}`}
      onClick={() => {
        if (!isEditing) onActivate();
      }}
      onDoubleClick={onEdit}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {isEditing ? (
        <TabTitleEditor
          initial={displayTitle}
          onCommit={onCommitRename}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          {tab.hasUnread && !isActive && (
            <span className="tab__activity" aria-label="Activity" />
          )}
          {tab.broadcastInput && (
            <span
              className="tab__broadcast"
              title="Broadcast input is on"
              aria-label="Broadcast input"
            >
              ⚡
            </span>
          )}
          <span className="tab__title" title={displayTitle}>
            {displayTitle}
          </span>
        </>
      )}
      <button
        type="button"
        className="tab__close"
        aria-label={`Close ${displayTitle}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        ×
      </button>
    </div>
  );
}

function TabClone({ displayTitle }: { displayTitle: string }) {
  return (
    <div className="tab tab--active" style={{ cursor: "grabbing" }}>
      <span className="tab__title">{displayTitle}</span>
      <span className="tab__close" aria-hidden>
        ×
      </span>
    </div>
  );
}

type TabTitleEditorProps = {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

function TabTitleEditor({ initial, onCommit, onCancel }: TabTitleEditorProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  return (
    <input
      ref={inputRef}
      className="tab__input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
