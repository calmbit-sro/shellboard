import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { Logo, Moon, Sun } from "./icons";
import "./TopBar.css";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

const CHROME_THEME_KEY = "shellboard.chromeTheme";

function readSavedChromeTheme(): "dark" | "light" {
  if (typeof localStorage === "undefined") return "dark";
  const v = localStorage.getItem(CHROME_THEME_KEY);
  return v === "light" ? "light" : "dark";
}

type TopBarProps = {
  onOpenPalette: () => void;
};

export function TopBar({ onOpenPalette }: TopBarProps) {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const [chromeTheme, setChromeTheme] = useState<"dark" | "light">(
    readSavedChromeTheme,
  );

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
  }, [chromeTheme]);

  const toggleChromeTheme = () => {
    setChromeTheme((t) => (t === "dark" ? "light" : "dark"));
  };

  return (
    <div className="topbar" data-tauri-drag-region>
      {IS_MAC && <div className="topbar__traffic-lights" aria-hidden />}
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
