import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectGroup } from "../store/appStore";

type GroupHeaderProps = {
  group: ProjectGroup;
  projectCount: number;
  editing: boolean;
  onToggle: () => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
};

export function GroupHeader({
  group,
  projectCount,
  editing,
  onToggle,
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
      <span
        className={`group-header__chevron ${
          group.collapsed ? "group-header__chevron--collapsed" : ""
        }`}
        aria-hidden
      >
        ▼
      </span>
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
          <span className="group-header__count">{projectCount}</span>
        </>
      )}
    </div>
  );
}
