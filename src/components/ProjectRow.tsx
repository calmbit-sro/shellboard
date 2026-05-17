import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "../store/appStore";

type ProjectRowProps = {
  project: Project;
  /** What to render in the row. Usually `project.name`, but for projects
   * with `autoCwdName` it tracks the active panel's cwd. */
  displayName: string;
  editing: boolean;
  active: boolean;
  hasActivity: boolean;
  /** True when the row sits under a group — adds extra left indent. */
  indented?: boolean;
  /** Lowercased substring to highlight inside displayName. */
  highlight?: string;
  onActivate: () => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
};

function renderHighlighted(name: string, query: string) {
  if (!query) return name;
  const i = name.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark className="project-row__mark">
        {name.slice(i, i + query.length)}
      </mark>
      {name.slice(i + query.length)}
    </>
  );
}

export function ProjectRow({
  project,
  displayName,
  editing,
  active,
  hasActivity,
  indented = false,
  highlight = "",
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
    opacity: isDragging ? 0 : 1,
    boxShadow: active ? `inset 2px 0 0 ${project.color}` : undefined,
  } as CSSProperties;

  const dragProps = editing ? {} : { ...attributes, ...listeners };

  const className = [
    "project-row",
    active ? "project-row--active" : "",
    indented ? "project-row--indented" : "",
    isDragging ? "project-row--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={setNodeRef}
      className={className}
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
      <span className="project-row__dot" aria-hidden />
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
          <span className="project-row__name">
            {renderHighlighted(displayName, highlight)}
          </span>
          {hasActivity && (
            <span className="project-row__activity" aria-label="Activity" />
          )}
        </>
      )}
    </div>
  );
}
