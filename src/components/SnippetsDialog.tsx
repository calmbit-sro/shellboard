import { useEffect, useState } from "react";
import { useAppStore, type Snippet } from "../store/appStore";
import { Modal } from "./Modal";
import "./SnippetsDialog.css";

type SnippetsDialogProps = {
  projectId: string | null;
  onClose: () => void;
};

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `snip-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function SnippetsDialog({ projectId, onClose }: SnippetsDialogProps) {
  const project = useAppStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  );
  const setProjectSnippets = useAppStore((s) => s.setProjectSnippets);
  const runSnippet = useAppStore((s) => s.runSnippet);

  const [drafts, setDrafts] = useState<Snippet[]>([]);

  useEffect(() => {
    if (project) {
      setDrafts(project.snippets ?? []);
    }
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return null;

  function commit(next: Snippet[]) {
    setDrafts(next);
    void setProjectSnippets(project!.id, next);
  }

  function addSnippet() {
    commit([...drafts, { id: uuid(), name: "", command: "" }]);
  }
  function updateSnippet(id: string, patch: Partial<Snippet>) {
    commit(drafts.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function removeSnippet(id: string) {
    commit(drafts.filter((s) => s.id !== id));
  }

  return (
    <Modal
      open={!!projectId}
      onClose={onClose}
      title={`Snippets · ${project.name}`}
      maxWidth={540}
    >
      <div className="snippets">
        {drafts.length === 0 && (
          <div className="snippets__empty">
            No snippets yet. Quick commands you run often — they paste into
            the active terminal on click.
          </div>
        )}
        <div className="snippets__list">
          {drafts.map((s) => (
            <div key={s.id} className="snippets__row">
              <input
                className="snippets__name"
                placeholder="Name"
                value={s.name}
                onChange={(e) => updateSnippet(s.id, { name: e.target.value })}
              />
              <input
                className="snippets__command"
                placeholder="command --arg"
                value={s.command}
                onChange={(e) =>
                  updateSnippet(s.id, { command: e.target.value })
                }
              />
              <button
                type="button"
                className="snippets__run"
                title="Run in active terminal"
                disabled={!s.command.trim()}
                onClick={() => void runSnippet(project.id, s.id)}
              >
                Run
              </button>
              <button
                type="button"
                className="snippets__remove"
                title="Remove"
                onClick={() => removeSnippet(s.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="snippets__actions">
          <button
            type="button"
            className="snippets__add"
            onClick={addSnippet}
          >
            + Add snippet
          </button>
          <button type="button" className="snippets__done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
