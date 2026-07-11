// The single source of truth for *which* keyboard actions exist and their
// default bindings. Three consumers derive from it: the App-level keydown
// dispatcher (App.tsx wires a handler per id), the editable Settings → Shortcuts
// UI, and the `?` cheat sheet. User overrides live in Settings.keybindings and
// win over the defaults via resolveBindings().

import { IS_MAC, type Binding } from "./binding";

export type ShortcutCategory = "Tabs" | "Splits" | "Focus" | "Terminal" | "App";

export type ShortcutAction = {
  id: string;
  category: ShortcutCategory;
  label: string;
  defaultBinding: Binding;
};

// The primary app modifier, mirroring the long-standing convention: Cmd on
// macOS, Ctrl on Linux/Windows. The recent-terminal switcher is the deliberate
// exception — it uses literal Ctrl on *both* platforms (see below).
const PRIMARY: Pick<Binding, "meta" | "ctrl"> = IS_MAC
  ? { meta: true }
  : { ctrl: true };

function primary(extra: Partial<Binding> & { key: string }): Binding {
  return { ...PRIMARY, ...extra };
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  // ── Tabs ──
  { id: "tab.new", category: "Tabs", label: "New tab", defaultBinding: primary({ key: "t" }) },
  { id: "tab.close", category: "Tabs", label: "Close tab", defaultBinding: primary({ key: "w" }) },
  {
    id: "panel.close",
    category: "Tabs",
    label: "Close panel",
    defaultBinding: primary({ shift: true, key: "w" }),
  },
  {
    id: "tab.next",
    category: "Tabs",
    label: "Next tab",
    defaultBinding: primary({ shift: true, key: "]" }),
  },
  {
    id: "tab.prev",
    category: "Tabs",
    label: "Previous tab",
    defaultBinding: primary({ shift: true, key: "[" }),
  },
  // The cross-project recently-used-terminal switcher. Literal Ctrl+Tab on both
  // platforms: reliable on macOS (Cmd+Tab is OS-reserved), and terminals can't
  // distinguish Ctrl+Tab from a bare Tab byte, so capturing it at the window
  // level is safe. A deliberate exception to "leave plain Ctrl to the shell".
  {
    id: "switcher.next",
    category: "Tabs",
    label: "Recent terminal — next",
    defaultBinding: { ctrl: true, key: "Tab" },
  },
  {
    id: "switcher.prev",
    category: "Tabs",
    label: "Recent terminal — previous",
    defaultBinding: { ctrl: true, shift: true, key: "Tab" },
  },

  // ── Splits ──
  {
    id: "split.vertical",
    category: "Splits",
    label: "Split vertical (panel right)",
    defaultBinding: primary({ key: "d" }),
  },
  {
    id: "split.horizontal",
    category: "Splits",
    label: "Split horizontal (panel down)",
    defaultBinding: primary({ shift: true, key: "d" }),
  },
  {
    id: "split.left",
    category: "Splits",
    label: "Split left",
    defaultBinding: primary({ shift: true, key: "ArrowLeft" }),
  },
  {
    id: "split.right",
    category: "Splits",
    label: "Split right",
    defaultBinding: primary({ shift: true, key: "ArrowRight" }),
  },
  {
    id: "split.up",
    category: "Splits",
    label: "Split up",
    defaultBinding: primary({ shift: true, key: "ArrowUp" }),
  },
  {
    id: "split.down",
    category: "Splits",
    label: "Split down",
    defaultBinding: primary({ shift: true, key: "ArrowDown" }),
  },

  // ── Focus ──
  {
    id: "focus.left",
    category: "Focus",
    label: "Focus panel left",
    defaultBinding: primary({ alt: true, key: "ArrowLeft" }),
  },
  {
    id: "focus.right",
    category: "Focus",
    label: "Focus panel right",
    defaultBinding: primary({ alt: true, key: "ArrowRight" }),
  },
  {
    id: "focus.up",
    category: "Focus",
    label: "Focus panel up",
    defaultBinding: primary({ alt: true, key: "ArrowUp" }),
  },
  {
    id: "focus.down",
    category: "Focus",
    label: "Focus panel down",
    defaultBinding: primary({ alt: true, key: "ArrowDown" }),
  },

  // ── Terminal ──
  {
    id: "search.terminal",
    category: "Terminal",
    label: "Find in terminal",
    defaultBinding: primary({ key: "f" }),
  },
  {
    id: "search.global",
    category: "Terminal",
    label: "Global search",
    defaultBinding: primary({ shift: true, key: "f" }),
  },
  // Prompt jumping needs shell integration on (OSC 133 marks) — a no-op
  // otherwise.
  {
    id: "prompt.prev",
    category: "Terminal",
    label: "Previous prompt",
    defaultBinding: primary({ key: "ArrowUp" }),
  },
  {
    id: "prompt.next",
    category: "Terminal",
    label: "Next prompt",
    defaultBinding: primary({ key: "ArrowDown" }),
  },
  {
    id: "apps.running",
    category: "Terminal",
    label: "Running apps",
    defaultBinding: primary({ shift: true, key: "r" }),
  },
  { id: "zoom.in", category: "Terminal", label: "Zoom in", defaultBinding: primary({ key: "=" }) },
  { id: "zoom.out", category: "Terminal", label: "Zoom out", defaultBinding: primary({ key: "-" }) },
  {
    id: "zoom.reset",
    category: "Terminal",
    label: "Reset zoom",
    defaultBinding: primary({ key: "0" }),
  },

  // ── App ──
  {
    id: "project.quickAdd",
    category: "App",
    label: "Quick-add project from cwd",
    defaultBinding: primary({ key: "n" }),
  },
  {
    id: "sidebar.toggle",
    category: "App",
    label: "Toggle sidebar",
    defaultBinding: primary({ key: "b" }),
  },
  {
    id: "settings.open",
    category: "App",
    label: "Open settings",
    defaultBinding: primary({ key: "," }),
  },
  {
    id: "palette.open",
    category: "App",
    label: "Command palette",
    defaultBinding: primary({ key: "k" }),
  },
];

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  "Tabs",
  "Splits",
  "Focus",
  "Terminal",
  "App",
];

export type BindingMap = Record<string, Binding>;

export const DEFAULT_BINDINGS: BindingMap = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultBinding]),
);

const ACTION_IDS = new Set(SHORTCUT_ACTIONS.map((a) => a.id));

export function isKnownActionId(id: string): boolean {
  return ACTION_IDS.has(id);
}

/** Defaults overlaid with the user's overrides (only known ids honored). */
export function resolveBindings(overrides: BindingMap | undefined): BindingMap {
  const out: BindingMap = { ...DEFAULT_BINDINGS };
  if (overrides) {
    for (const [id, b] of Object.entries(overrides)) {
      if (ACTION_IDS.has(id)) out[id] = b;
    }
  }
  return out;
}
