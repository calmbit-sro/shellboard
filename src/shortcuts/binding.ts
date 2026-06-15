// Keyboard shortcut binding model.
//
// A Binding captures the literal modifier state plus a layout-position key
// token (derived from KeyboardEvent.code, so it survives Shift remapping like
// `]` → `}`). Modifiers are stored literally — no "Mod = Cmd/Ctrl" abstraction —
// because the recent-terminal switcher defaults to a *literal* Ctrl+Tab even on
// macOS (where Cmd+Tab is the OS app switcher and never reaches us). Config is
// per-machine (local config dir, never synced), so literal modifiers are
// unambiguous.

export type Binding = {
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Layout-position key token: "t", "Tab", "ArrowLeft", "]", "=", "`", "1" … */
  key: string;
};

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const LONE_MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift"]);

// Map a KeyboardEvent to a stable token. We key off `event.code` (physical key)
// for letters, digits, and punctuation so a binding matches regardless of which
// glyph Shift would produce. Named keys (Tab, arrows, …) pass through by code.
const CODE_TOKENS: Record<string, string> = {
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Escape",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

export function eventKeyToken(e: KeyboardEvent): string | null {
  if (LONE_MODIFIERS.has(e.key)) return null;
  const code = e.code;
  if (code) {
    if (code.startsWith("Key")) return code.slice(3).toLowerCase(); // KeyA → "a"
    if (code.startsWith("Digit")) return code.slice(5); // Digit1 → "1"
    if (code.startsWith("Numpad")) {
      const rest = code.slice(6);
      if (/^\d$/.test(rest)) return rest;
    }
    const mapped = CODE_TOKENS[code];
    if (mapped) return mapped;
  }
  // Fallback for events without a usable code (rare): normalize letters.
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
}

/** Build a Binding from a captured keydown, or null for a lone modifier press. */
export function bindingFromEvent(e: KeyboardEvent): Binding | null {
  const key = eventKeyToken(e);
  if (key === null) return null;
  const b: Binding = { key };
  if (e.metaKey) b.meta = true;
  if (e.ctrlKey) b.ctrl = true;
  if (e.altKey) b.alt = true;
  if (e.shiftKey) b.shift = true;
  return b;
}

/** Does a live keydown event satisfy this binding? Modifiers must match exactly. */
export function matchBinding(e: KeyboardEvent, b: Binding): boolean {
  return (
    e.metaKey === !!b.meta &&
    e.ctrlKey === !!b.ctrl &&
    e.altKey === !!b.alt &&
    e.shiftKey === !!b.shift &&
    eventKeyToken(e) === b.key
  );
}

/** True when this binding is a well-formed object (defensive hydrate guard). */
export function isValidBinding(v: unknown): v is Binding {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.key !== "string" || b.key.length === 0) return false;
  for (const m of ["meta", "ctrl", "alt", "shift"] as const) {
    if (m in b && typeof b[m] !== "boolean") return false;
  }
  return true;
}

/** Stable string key for equality / conflict grouping. */
export function bindingKey(b: Binding): string {
  return `${b.meta ? "M" : ""}${b.ctrl ? "C" : ""}${b.alt ? "A" : ""}${
    b.shift ? "S" : ""
  }-${b.key}`;
}

export function bindingsEqual(a: Binding, b: Binding): boolean {
  return bindingKey(a) === bindingKey(b);
}

/** The modifiers a Binding requires — used to know what release commits the switcher. */
export function bindingMods(b: Binding): Pick<Binding, "meta" | "ctrl" | "alt"> {
  return { meta: !!b.meta, ctrl: !!b.ctrl, alt: !!b.alt };
}

// ── Display ────────────────────────────────────────────────────────────────

const KEY_GLYPHS: Record<string, string> = {
  Tab: "Tab",
  Enter: "↩",
  Escape: "Esc",
  Space: "Space",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

function displayKey(key: string): string {
  if (KEY_GLYPHS[key]) return KEY_GLYPHS[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Human-readable combo using the platform's modifier symbols. */
export function formatBinding(b: Binding): string {
  if (IS_MAC) {
    // macOS canonical order: ⌃ ⌥ ⇧ ⌘
    const parts = [
      b.ctrl ? "⌃" : "",
      b.alt ? "⌥" : "",
      b.shift ? "⇧" : "",
      b.meta ? "⌘" : "",
    ].filter(Boolean);
    return parts.join("") + displayKey(b.key);
  }
  const parts = [
    b.ctrl ? "Ctrl" : "",
    b.alt ? "Alt" : "",
    b.shift ? "Shift" : "",
    b.meta ? "Meta" : "",
  ].filter(Boolean);
  return [...parts, displayKey(b.key)].join("+");
}

// ── Capture coordination ─────────────────────────────────────────────────
// While a ShortcutInput is recording a combo, the global App dispatcher must
// stand down so capturing e.g. Cmd+T doesn't also open a new tab. ShortcutInput
// flips this on focus / off on blur; App.tsx checks it at the top of onKey.

let _capturing = false;
export const shortcutCapture = {
  isActive: () => _capturing,
  set: (v: boolean) => {
    _capturing = v;
  },
};
