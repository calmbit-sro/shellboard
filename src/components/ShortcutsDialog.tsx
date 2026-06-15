import { useMemo } from "react";
import { Modal } from "./Modal";
import { useAppStore } from "../store/appStore";
import { formatBinding, IS_MAC } from "../shortcuts/binding";
import {
  resolveBindings,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORIES,
} from "../shortcuts/registry";
import "./ShortcutsDialog.css";

const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";

// Fixed accelerators and terminal-level keys that aren't part of the
// rebindable registry — listed here so the cheat sheet stays complete.
const EXTRA_GROUPS: Array<{ heading: string; items: Array<[string, string]> }> = [
  {
    heading: "Fixed",
    items: [
      [`${MOD}1..9`, "Jump to tab N"],
      [`${MOD}${SHIFT}P`, "Command palette (alias)"],
      [`?`, "This shortcut list"],
    ],
  },
  {
    heading: "Terminal",
    items: [
      [IS_MAC ? `${MOD}C / ${MOD}V` : `Ctrl${SHIFT}C / V`, "Copy / paste"],
      [`${MOD}-click URL`, "Open link in browser"],
    ],
  },
];

type ShortcutsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const keybindings = useAppStore((s) => s.settings.keybindings);
  const resolved = useMemo(() => resolveBindings(keybindings), [keybindings]);

  const registryGroups = SHORTCUT_CATEGORIES.map((category) => ({
    heading: category,
    items: SHORTCUT_ACTIONS.filter((a) => a.category === category).map(
      (a) => [formatBinding(resolved[a.id]), a.label] as [string, string],
    ),
  })).filter((g) => g.items.length > 0);

  const groups = [...registryGroups, ...EXTRA_GROUPS];

  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" maxWidth={560}>
      <div className="shortcuts">
        {groups.map((g) => (
          <section key={g.heading} className="shortcuts__group">
            <h3 className="shortcuts__heading">{g.heading}</h3>
            <dl className="shortcuts__list">
              {g.items.map(([key, label]) => (
                <div key={`${g.heading}-${label}`} className="shortcuts__row">
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
