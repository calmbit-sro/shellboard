/**
 * Tracks whether the app window was just brought to the foreground, so a click
 * that activates a background window can be told apart from a click made while
 * the window was already focused.
 *
 * Why this exists: with `acceptFirstMouse` on (see src-tauri/tauri.conf.json),
 * macOS delivers the window-activating click straight into the webview — and
 * thus into xterm, which forwards it to a mouse-tracking TUI (e.g. an
 * interactive prompt). That makes the click you used just to switch windows
 * accidentally pick an option. Terminal.tsx uses `isActivatingClick()` to
 * suppress the mouse report for that first click while still focusing the pane.
 *
 * The window-focused flag is set from `blur`/`focus`: when the user is in
 * another app, `blur` has already fired, so at the activating click the flag is
 * reliably false regardless of whether the paired `focus` event lands before or
 * after the mousedown. The short grace window is a backstop for the ordering
 * where `focus` fires first.
 */

const GRACE_MS = 250;

let windowFocused =
  typeof document !== "undefined" ? document.hasFocus() : true;
let lastFocusGainAt = -Infinity;

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    windowFocused = true;
    lastFocusGainAt = performance.now();
  });
  window.addEventListener("blur", () => {
    windowFocused = false;
  });
}

/**
 * True when the current click is (or immediately follows) the one that brought
 * the window to the foreground — i.e. the window was not focused, or only just
 * became focused within the grace window.
 */
export function isActivatingClick(): boolean {
  return !windowFocused || performance.now() - lastFocusGainAt < GRACE_MS;
}
