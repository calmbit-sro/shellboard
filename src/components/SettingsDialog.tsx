import { useState } from "react";
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  useAppStore,
} from "../store/appStore";
import { findTheme, THEMES } from "../utils/themes";
import { Modal } from "./Modal";
import "./SettingsDialog.css";

function ThemeSwatches({ currentId }: { currentId: string }) {
  const t = findTheme(currentId).theme;
  const swatches = [
    t.background,
    t.foreground,
    t.red,
    t.green,
    t.yellow,
    t.blue,
    t.magenta,
    t.cyan,
  ];
  return (
    <div className="settings__swatches" aria-hidden>
      {swatches.map((c, i) => (
        <span
          key={i}
          className="settings__swatch"
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

const FONT_PRESETS = [
  {
    label: "System (Menlo / Consolas)",
    value: DEFAULT_SETTINGS.terminalFontFamily,
  },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "Monaco", value: "Monaco, monospace" },
  { label: "SF Mono", value: '"SF Mono", ui-monospace, monospace' },
  { label: "Fira Code", value: '"Fira Code", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
  { label: "MesloLGS NF", value: '"MesloLGS NF", monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", monospace' },
];

type SettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  onOpenAbout: () => void;
};

export function SettingsDialog({
  open,
  onClose,
  onOpenAbout,
}: SettingsDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const presetMatch = FONT_PRESETS.find(
    (p) => p.value === settings.terminalFontFamily,
  );
  const [isCustom, setIsCustom] = useState(!presetMatch);
  const [customFamily, setCustomFamily] = useState(
    presetMatch ? DEFAULT_SETTINGS.terminalFontFamily : settings.terminalFontFamily,
  );

  return (
    <Modal open={open} onClose={onClose} title="Settings" maxWidth={480}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__heading">Terminal</h3>

          <div className="settings__field">
            <label htmlFor="term-font-preset">Font</label>
            <select
              id="term-font-preset"
              value={
                isCustom
                  ? "__custom__"
                  : settings.terminalFontFamily
              }
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setIsCustom(true);
                  void updateSettings({ terminalFontFamily: customFamily });
                } else {
                  setIsCustom(false);
                  void updateSettings({ terminalFontFamily: e.target.value });
                }
              }}
            >
              {FONT_PRESETS.map((p) => (
                <option key={p.label} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
          </div>

          {isCustom && (
            <div className="settings__field">
              <label htmlFor="term-font-custom">Custom font-family</label>
              <input
                id="term-font-custom"
                type="text"
                value={customFamily}
                placeholder='e.g. "Fira Code", monospace'
                onChange={(e) => setCustomFamily(e.target.value)}
                onBlur={() => {
                  if (customFamily.trim()) {
                    void updateSettings({ terminalFontFamily: customFamily });
                  }
                }}
              />
            </div>
          )}

          <div className="settings__field">
            <label htmlFor="term-font-size">
              Font size ({SETTINGS_LIMITS.terminalFontSize.min}–
              {SETTINGS_LIMITS.terminalFontSize.max} px)
            </label>
            <input
              id="term-font-size"
              type="number"
              min={SETTINGS_LIMITS.terminalFontSize.min}
              max={SETTINGS_LIMITS.terminalFontSize.max}
              value={settings.terminalFontSize}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) {
                  void updateSettings({ terminalFontSize: n });
                }
              }}
            />
          </div>

          <div className="settings__field">
            <label htmlFor="term-scrollback">
              Scrollback ({SETTINGS_LIMITS.scrollback.min}–
              {SETTINGS_LIMITS.scrollback.max} lines)
            </label>
            <input
              id="term-scrollback"
              type="number"
              min={SETTINGS_LIMITS.scrollback.min}
              max={SETTINGS_LIMITS.scrollback.max}
              step={500}
              value={settings.scrollback}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) {
                  void updateSettings({ scrollback: n });
                }
              }}
            />
          </div>

          <div className="settings__field">
            <label htmlFor="term-theme">Theme</label>
            <select
              id="term-theme"
              value={settings.terminalTheme}
              onChange={(e) =>
                void updateSettings({ terminalTheme: e.target.value })
              }
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <ThemeSwatches currentId={settings.terminalTheme} />
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__heading">Application</h3>

          <div className="settings__field">
            <label htmlFor="ui-font-size">
              UI font size ({SETTINGS_LIMITS.uiFontSize.min}–
              {SETTINGS_LIMITS.uiFontSize.max} px)
            </label>
            <input
              id="ui-font-size"
              type="number"
              min={SETTINGS_LIMITS.uiFontSize.min}
              max={SETTINGS_LIMITS.uiFontSize.max}
              value={settings.uiFontSize}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) {
                  void updateSettings({ uiFontSize: n });
                }
              }}
            />
          </div>

          <div className="settings__field settings__field--check">
            <label className="settings__check">
              <input
                type="checkbox"
                checked={settings.autoCwdTracking}
                onChange={(e) =>
                  void updateSettings({ autoCwdTracking: e.target.checked })
                }
              />
              <span>Track current directory (OSC 7 auto-setup)</span>
            </label>
            <p className="settings__hint">
              Injects a shell hook so session restore remembers the directory
              you <code>cd</code>’d into. Supported: zsh, bash, fish, nushell.
              Affects newly-spawned terminals only.
            </p>
          </div>

          <div className="settings__field settings__field--check">
            <label className="settings__check">
              <input
                type="checkbox"
                checked={settings.checkForUpdatesOnStartup}
                onChange={(e) =>
                  void updateSettings({
                    checkForUpdatesOnStartup: e.target.checked,
                  })
                }
              />
              <span>Check for updates on startup</span>
            </label>
            <p className="settings__hint">
              Pings GitHub Releases at most once per day. When a newer
              version exists, a clickable badge appears in the status bar.
            </p>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__heading">Shell</h3>

          <div className="settings__field">
            <label htmlFor="shell-path">Shell path</label>
            <input
              id="shell-path"
              type="text"
              className="settings__text"
              placeholder="Default: $SHELL"
              value={settings.shellPath}
              onChange={(e) =>
                void updateSettings({ shellPath: e.target.value })
              }
            />
          </div>

          <div className="settings__field">
            <label htmlFor="shell-args">Shell arguments</label>
            <input
              id="shell-args"
              type="text"
              className="settings__text"
              placeholder="Default: auto (-l for POSIX shells)"
              value={settings.shellArgs}
              onChange={(e) =>
                void updateSettings({ shellArgs: e.target.value })
              }
            />
            <p className="settings__hint">
              Leave both fields empty for automatic handling. When you set
              your own arguments, Shellboard stops adding <code>-l</code>
              automatically — provide it yourself if you want a login shell.
              Affects newly-spawned terminals only.
            </p>
          </div>
        </section>

        <div className="settings__footer">
          <button
            type="button"
            className="settings__about"
            onClick={onOpenAbout}
          >
            About…
          </button>
          <button
            type="button"
            className="settings__reset"
            onClick={() => {
              setIsCustom(false);
              setCustomFamily(DEFAULT_SETTINGS.terminalFontFamily);
              void updateSettings(DEFAULT_SETTINGS);
            }}
          >
            Reset to defaults
          </button>
          <button
            type="button"
            className="settings__done"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
