import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import "./ErrorToast.css";

/** Dismissable, auto-expiring error toast. Reads the store's `errorToast`
 * field, which spawn paths set when a terminal can't be created (e.g. the OS
 * ran out of PTYs). Replaces the old behavior where such failures were
 * silently swallowed. */
export function ErrorToast() {
  const message = useAppStore((s) => s.errorToast);
  const dismiss = useAppStore((s) => s.dismissError);

  useEffect(() => {
    if (!message) return;
    const handle = setTimeout(() => dismiss(), 7000);
    return () => clearTimeout(handle);
  }, [message, dismiss]);

  if (!message) return null;

  return (
    <div className="error-toast" role="alert">
      <span className="error-toast__icon" aria-hidden>
        ⚠
      </span>
      <span className="error-toast__message">{message}</span>
      <button
        type="button"
        className="error-toast__dismiss"
        onClick={() => dismiss()}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
