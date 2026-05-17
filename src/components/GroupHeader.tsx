import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectGroup } from "../store/appStore";
import { Chevron, Folder, Plus } from "./icons";

type GroupHeaderProps = {
  group: ProjectGroup;
  projectCount: number;
  editing: boolean;
  expanded: boolean;
  hasActivity: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
};

export function GroupHeader({
  group,
  projectCount,
  editing,
  expanded,
  hasActivity,
  onToggle,
  onAdd,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: GroupHeaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(group.name);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `group-${group.id}`, disabled: editing });

  useEffect(() => {
    if (editing) {
      setDraft(group.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, group.name]);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const dragProps = editing ? {} : { ...attributes, ...listeners };

  return (
    <div
      ref={setNodeRef}
      className={`group-header ${isDragging ? "group-header--dragging" : ""}`}
      style={style}
      {...dragProps}
      onClick={() => {
        if (!editing) onToggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <Chevron open={expanded} />
      <Folder size={11} className="group-header__folder" />
      {editing ? (
        <input
          ref={inputRef}
          className="group-header__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const trimmed = draft.trim();
              if (trimmed) onCommitRename(trimmed);
              else onCancelRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={() => {
            const trimmed = draft.trim();
            if (trimmed && trimmed !== group.name) onCommitRename(trimmed);
            else onCancelRename();
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className="group-header__name">{group.name}</span>
          {hasActivity && (
            <span className="group-header__activity" aria-label="Activity" />
          )}
          <span className="group-header__count">{projectCount}</span>
          <button
            type="button"
            className="group-header__add"
            aria-label="Add project here"
            title="Add project here"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Plus size={11} />
          </button>
        </>
      )}
    </div>
  );
}
