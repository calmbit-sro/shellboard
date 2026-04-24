import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "../store/appStore";

type ProjectRowProps = {
  project: Project;
  editing: boolean;
  active: boolean;
  hasActivity: boolean;
  onActivate: () => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
};

export function ProjectRow({
  project,
  editing,
  active,
  hasActivity,
  onActivate,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: ProjectRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(project.name);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, disabled: editing });

  useEffect(() => {
    if (editing) {
      setDraft(project.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, project.name]);

  const style: CSSProperties = {
    "--project-color": project.color,
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide the in-place item completely while dragging — the DragOverlay
    // renders a floating clone that follows the cursor, so keeping the
    // original visible would produce a double / snap-back effect.
    opacity: isDragging ? 0 : 1,
  } as CSSProperties;

  // Skip attaching drag attrs/listeners during edit — they add role="button"
  // and keyboard shortcuts that interfere with typing into the input.
  const dragProps = editing ? {} : { ...attributes, ...listeners };

  return (
    <div
      ref={setNodeRef}
      className={`project-row ${isDragging ? "project-row--dragging" : ""}`}
      style={style}
      {...dragProps}
      onClick={() => {
        if (!editing) onActivate();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      title={project.path}
    >
      <span
        className={`project-row__indicator ${active ? "project-row__indicator--on" : ""}`}
        aria-hidden
      />
      {editing ? (
        <input
          ref={inputRef}
          className="project-row__input"
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
            if (trimmed && trimmed !== project.name) onCommitRename(trimmed);
            else onCancelRename();
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className="project-row__name">{project.name}</span>
          {hasActivity && (
            <span className="project-row__activity" aria-label="Activity" />
          )}
        </>
      )}
    </div>
  );
}
