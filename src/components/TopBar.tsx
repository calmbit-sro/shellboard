import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { findTheme } from "../utils/themes";
import { Logo, Moon, Sun } from "./icons";
import "./TopBar.css";

/** Relative luminance of an #rrggbb / #rgb / rgba(...) color. Returns 0..1. */
function colorLuminance(input: string | undefined): number {
  if (!input) return 0;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (m) {
    const hex = m[1].length === 3
      ? m[1].split("").map((c) => c + c).join("")
      : m[1];
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(input);
  if (rgba) {
    const r = Number(rgba[1]) / 255;
    const g = Number(rgba[2]) / 255;
    const b = Number(rgba[3]) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return 0;
}

function isLightTheme(themeId: string): boolean {
  const bg = findTheme(themeId).theme.background;
  return colorLuminance(bg) > 0.5;
}

const CHROME_THEME_KEY = "shellboard.chromeTheme";
const TERM_PREF_KEY = "shellboard.terminalThemeByChrome";

function readSavedChromeTheme(): "dark" | "light" {
  if (typeof localStorage === "undefined") return "dark";
  const v = localStorage.getItem(CHROME_THEME_KEY);
  return v === "light" ? "light" : "dark";
}

function readTermPrefs(): { dark: string; light: string } {
  const fallback = { dark: "shellboard", light: "shellboard-light" };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(TERM_PREF_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<{ dark: string; light: string }>;
    return {
      dark: typeof parsed.dark === "string" ? parsed.dark : fallback.dark,
      light: typeof parsed.light === "string" ? parsed.light : fallback.light,
    };
  } catch {
    return fallback;
  }
}

function writeTermPrefs(prefs: { dark: string; light: string }) {
  try {
    localStorage.setItem(TERM_PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

type TopBarProps = {
  onOpenPalette: () => void;
};

export function TopBar({ onOpenPalette }: TopBarProps) {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const terminalTheme = useAppStore((s) => s.settings.terminalTheme);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [chromeTheme, setChromeTheme] = useState<"dark" | "light">(
    readSavedChromeTheme,
  );
  // Per-mode terminal theme memory. When the user picks a terminal theme
  // (via Settings or palette) we record it as the preferred theme for the
  // current chrome mode; toggling chrome then restores the other mode's
  // saved choice. Defaults to the ShellBoard pair.
  const termPrefsRef = useRef(readTermPrefs());
  // Distinguishes "store changed because the user picked a theme" from
  // "store changed because we applied a saved pref" — so the auto-apply
  // doesn't keep overwriting itself.
  const applyingPrefRef = useRef(false);

  useEffect(() => {
    if (chromeTheme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      localStorage.setItem(CHROME_THEME_KEY, chromeTheme);
    } catch {
      /* ignore */
    }
    // Restore the saved terminal theme for this chrome mode. Runs at mount
    // too, so a saved chrome=light hydrates the matching light terminal.
    const desired = termPrefsRef.current[chromeTheme];
    if (desired && useAppStore.getState().settings.terminalTheme !== desired) {
      applyingPrefRef.current = true;
      void updateSettings({ terminalTheme: desired });
    }
  }, [chromeTheme, updateSettings]);

  // When the user manually picks a terminal theme (from Settings or the
  // palette), follow its lightness with the chrome and remember the choice
  // as the pref for that chrome mode. Skip the next change if it's just us
  // applying the saved pref above.
  useEffect(() => {
    if (applyingPrefRef.current) {
      applyingPrefRef.current = false;
      return;
    }
    const themeIsLight = isLightTheme(terminalTheme);
    const targetChrome: "dark" | "light" = themeIsLight ? "light" : "dark";
    if (targetChrome !== chromeTheme) {
      // Save the pref under the *new* chrome mode so toggling back later
      // restores this choice, not the placeholder it would have replaced.
      termPrefsRef.current = {
        ...termPrefsRef.current,
        [targetChrome]: terminalTheme,
      };
      writeTermPrefs(termPrefsRef.current);
      setChromeTheme(targetChrome);
      return;
    }
    if (termPrefsRef.current[chromeTheme] === terminalTheme) return;
    termPrefsRef.current = {
      ...termPrefsRef.current,
      [chromeTheme]: terminalTheme,
    };
    writeTermPrefs(termPrefsRef.current);
  }, [terminalTheme, chromeTheme]);

  const toggleChromeTheme = () => {
    setChromeTheme((t) => (t === "dark" ? "light" : "dark"));
  };

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar__brand" data-tauri-drag-region>
        <Logo size={16} color="var(--accent-strong)" />
        <span className="topbar__name">ShellBoard</span>
        {activeProject && (
          <>
            <span className="topbar__sep">/</span>
            <span className="topbar__project">{activeProject.name}</span>
          </>
        )}
      </div>
      <span className="topbar__spacer" data-tauri-drag-region />
      <button
        type="button"
        className="topbar__btn"
        onClick={toggleChromeTheme}
        aria-label={chromeTheme === "dark" ? "Switch to light" : "Switch to dark"}
        title={chromeTheme === "dark" ? "Light mode" : "Dark mode"}
      >
        {chromeTheme === "dark" ? <Moon size={13} /> : <Sun size={13} />}
      </button>
      <button
        type="button"
        className="topbar__cmdk"
        onClick={onOpenPalette}
        title="Command palette"
      >
        <span className="topbar__cmdk-key">⌘</span>
        <span className="topbar__cmdk-key">K</span>
      </button>
    </div>
  );
}
