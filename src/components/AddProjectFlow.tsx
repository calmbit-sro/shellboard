import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/appStore";
import { Modal } from "./Modal";
import { ColorPicker, randomProjectColor } from "./ColorPicker";

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

type AddProjectFlowProps = {
  open: boolean;
  onClose: () => void;
  /** Pre-select a group when the flow is opened from a group's context
   * menu. The user can still change the group in the form. */
  initialGroupId?: string | null;
};

type Draft = {
  path: string;
  name: string;
  color: string;
  groupId: string | null;
};

export function AddProjectFlow({
  open,
  onClose,
  initialGroupId = null,
}: AddProjectFlowProps) {
  const addProject = useAppStore((s) => s.addProject);
  const groups = useAppStore((s) => s.groups);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const pickerActive = useRef(false);

  useEffect(() => {
    if (!open) {
      pickerActive.current = false;
      return;
    }
    if (pickerActive.current || draft !== null) return;
    pickerActive.current = true;
    (async () => {
      try {
        const picked = await openDialog({
          directory: true,
          multiple: false,
          title: "Select project folder",
        });
        if (!picked || typeof picked !== "string") {
          onClose();
          return;
        }
        setDraft({
          path: picked,
          name: basename(picked),
          color: randomProjectColor(),
          groupId: initialGroupId,
        });
      } finally {
        pickerActive.current = false;
      }
    })();
  }, [open, draft, onClose]);

  async function commit() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;
    setSaving(true);
    try {
      await addProject({
        path: draft.path,
        name,
        color: draft.color,
        groupId: draft.groupId,
      });
      setDraft(null);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    if (saving) return;
    setDraft(null);
    onClose();
  }

  return (
    <Modal open={open && draft !== null} onClose={handleClose} title="New project">
      {draft && (
        <div className="add-project">
          <div className="add-project__field">
            <label>Path</label>
            <div className="add-project__path" title={draft.path}>
              {draft.path}
            </div>
          </div>
          <div className="add-project__field">
            <label htmlFor="project-name-input">Name</label>
            <input
              id="project-name-input"
              className="add-project__input"
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                }
              }}
            />
          </div>
          {groups.length > 0 && (
            <div className="add-project__field">
              <label htmlFor="project-group-select">Group</label>
              <select
                id="project-group-select"
                className="add-project__input"
                value={draft.groupId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    groupId: e.target.value || null,
                  })
                }
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="add-project__field">
            <label>Color</label>
            <ColorPicker
              value={draft.color}
              onChange={(color) => setDraft({ ...draft, color })}
            />
          </div>
          <div className="add-project__actions">
            <button type="button" onClick={handleClose}>
              Cancel
            </button>
            <button
              type="button"
              className="add-project__primary"
              onClick={() => void commit()}
              disabled={saving || !draft.name.trim()}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
