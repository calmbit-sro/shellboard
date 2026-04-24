import { useEffect, type ReactNode } from "react";
import "./Modal.css";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxWidth?: number;
};

export function Modal({ open, onClose, title, children, maxWidth = 420 }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        style={{ maxWidth }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && <div className="modal__title">{title}</div>}
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
