import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ContextMenu.css";

export type MenuItem =
  | {
      label: string;
      onClick: () => void;
      disabled?: boolean;
      separator?: false;
    }
  | { separator: true };

type ContextMenuProps = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp to viewport after the menu is measured so it never renders offscreen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(x, Math.max(0, vw - rect.width - 2));
    const top = Math.min(y, Math.max(0, vh - rect.height - 2));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        "separator" in item && item.separator ? (
          <div key={i} className="context-menu__separator" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className="context-menu__item"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
