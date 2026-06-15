import { useEffect, useState } from "react";
import {
  bindingFromEvent,
  formatBinding,
  shortcutCapture,
  type Binding,
} from "../shortcuts/binding";
import "./ShortcutInput.css";

type ShortcutInputProps = {
  value: Binding;
  /** True when `value` is a user override (enables the reset affordance). */
  overridden: boolean;
  /** Another action already uses this binding. */
  conflict?: boolean;
  onChange: (next: Binding) => void;
  onReset: () => void;
};

export function ShortcutInput({
  value,
  overridden,
  conflict,
  onChange,
  onReset,
}: ShortcutInputProps) {
  const [capturing, setCapturing] = useState(false);

  // We can't rely on the button having keyboard focus: WKWebView (Tauri on
  // macOS) doesn't focus <button>s on click. So while recording we listen on
  // window in the capture phase — which also lets us swallow the combo before
  // it reaches the app dispatcher or the Settings dialog (Escape / Cmd+F).
  useEffect(() => {
    if (!capturing) return;
    shortcutCapture.set(true);

    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        onReset();
        setCapturing(false);
        return;
      }
      const b = bindingFromEvent(e);
      if (!b) return; // lone modifier — keep waiting for the full combo
      onChange(b);
      setCapturing(false);
    }
    // Any click elsewhere cancels recording. The click that *started* capture
    // already fired its mousedown before this listener was attached, so it
    // won't immediately self-cancel.
    function onDown() {
      setCapturing(false);
    }

    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("mousedown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("mousedown", onDown, { capture: true });
      shortcutCapture.set(false);
    };
  }, [capturing, onChange, onReset]);

  return (
    <div className="sb-shortcut">
      <button
        type="button"
        className={
          "sb-surface sb-shortcut__field" +
          (capturing ? " is-capturing" : "") +
          (conflict ? " is-conflict" : "")
        }
        onClick={() => setCapturing(true)}
        title={conflict ? "This combo is used by another action" : undefined}
      >
        {capturing ? (
          <span className="sb-shortcut__hint">Press keys…</span>
        ) : (
          <kbd className="sb-shortcut__keys">{formatBinding(value)}</kbd>
        )}
      </button>
      {overridden && !capturing && (
        <button
          type="button"
          className="sb-shortcut__reset"
          onClick={onReset}
          title="Reset to default"
          aria-label="Reset to default"
        >
          ↺
        </button>
      )}
    </div>
  );
}
