import { Modal } from "./Modal";
import "./ShortcutsDialog.css";

type Group = { heading: string; items: Array<[string, string]> };

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const ALT = IS_MAC ? "⌥" : "Alt";

const GROUPS: Group[] = [
  {
    heading: "Tabs",
    items: [
      [`${MOD}T`, "New tab"],
      [`${MOD}W`, "Close tab"],
      [`${MOD}${SHIFT}W`, "Close panel"],
      [`${MOD}Tab`, "Next tab"],
      [`${MOD}${SHIFT}Tab`, "Previous tab"],
      [`${MOD}${SHIFT}]`, "Next tab (macOS alias)"],
      [`${MOD}${SHIFT}[`, "Previous tab (macOS alias)"],
      [`${MOD}1..9`, "Jump to tab N"],
    ],
  },
  {
    heading: "Splits",
    items: [
      [`${MOD}D`, "Split vertical (right)"],
      [`${MOD}${SHIFT}D`, "Split horizontal (down)"],
      [`${MOD}${ALT}←↑↓→`, "Move focus between panels"],
    ],
  },
  {
    heading: "Terminal",
    items: [
      [`${MOD}F`, "Find in terminal"],
      [`${MOD}${SHIFT}F`, "Global search"],
      [`${MOD}K`, "Clear terminal"],
      [`${MOD}=`, "Zoom in"],
      [`${MOD}-`, "Zoom out"],
      [`${MOD}0`, "Reset zoom"],
      [`${MOD}C / ${MOD}V`, "Copy / paste (macOS)"],
      [`Ctrl${SHIFT}C / V`, "Copy / paste (Linux/Win)"],
      [`${MOD}-click URL`, "Open link in browser"],
    ],
  },
  {
    heading: "App",
    items: [
      [`${MOD}B`, "Toggle sidebar"],
      [`${MOD},`, "Settings"],
      [`${MOD}${SHIFT}P`, "Command palette"],
      [`?`, "This shortcut list"],
    ],
  },
];

type ShortcutsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" maxWidth={560}>
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <section key={g.heading} className="shortcuts__group">
            <h3 className="shortcuts__heading">{g.heading}</h3>
            <dl className="shortcuts__list">
              {g.items.map(([key, label]) => (
                <div key={key} className="shortcuts__row">
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
