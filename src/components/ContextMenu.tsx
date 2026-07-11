import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ContextMenu.css";

export type MenuItem =
  | {
      label: string;
      onClick: () => void;
      disabled?: boolean;
      danger?: boolean;
      kbd?: string;
      separator?: false;
    }
  | {
      label: string;
      submenu: MenuItem[];
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
      <MenuItems items={items} onClose={onClose} />
    </div>
  );
}

function MenuItems({
  items,
  onClose,
}: {
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <>
      {items.map((item, i) => {
        if ("separator" in item && item.separator) {
          return (
            <div key={i} className="context-menu__separator" role="separator" />
          );
        }
        if ("submenu" in item) {
          return <SubMenuItem key={i} item={item} onClose={onClose} />;
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`context-menu__item ${
              item.danger ? "context-menu__item--danger" : ""
            }`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
          >
            <span className="context-menu__label">{item.label}</span>
            {item.kbd && <span className="context-menu__kbd">{item.kbd}</span>}
          </button>
        );
      })}
    </>
  );
}

function SubMenuItem({
  item,
  onClose,
}: {
  item: Extract<MenuItem, { submenu: MenuItem[] }>;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [flipLeft, setFlipLeft] = useState(false);

  // Decide flyout side on hover: the parent menu is clamped to the viewport,
  // so a right-opening submenu near the right edge would overflow — open it
  // leftward instead.
  function onEnter() {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const NESTED_WIDTH = 210;
    setFlipLeft(rect.right + NESTED_WIDTH > window.innerWidth);
  }

  return (
    <div
      ref={wrapRef}
      className="context-menu__sub-wrap"
      onMouseEnter={onEnter}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        className="context-menu__item context-menu__item--parent"
        disabled={item.disabled}
      >
        <span className="context-menu__label">{item.label}</span>
        <span className="context-menu__arrow">›</span>
      </button>
      {!item.disabled && (
        <div
          className={`context-menu context-menu--nested ${
            flipLeft ? "context-menu--nested-left" : ""
          }`}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItems items={item.submenu} onClose={onClose} />
        </div>
      )}
    </div>
  );
}
