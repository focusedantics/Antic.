import { Icon, type IconName } from "./icons";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      /** One of a set of choices, shown with a check when current. */
      checked?: boolean;
      /** Shown on phones, where menus are larger (see app.css). */
      icon?: IconName;
    }
  | "separator";

type OpenMenu = { x: number; y: number; items: MenuItem[] };
let setGlobal: ((m: OpenMenu | null) => void) | null = null;

/** Opens a context menu at the pointer. */
export function openMenu(x: number, y: number, items: MenuItem[]) {
  setGlobal?.({ x, y, items });
}

export function MenuHost() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    setGlobal = setMenu;
    return () => {
      setGlobal = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    // Layout size, not the bounding box: an opening animation scales the menu down at first.
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)),
    });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <hr key={`s${i}`} />
        ) : (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            disabled={item.disabled}
            style={item.danger ? { color: "var(--danger)" } : undefined}
            onClick={() => {
              setMenu(null);
              item.onSelect();
            }}
          >
            {item.checked !== undefined && <span className="menu-check" aria-hidden="true">{item.checked ? "✓" : ""}</span>}
            {item.icon && (
              <span className="menu-icon" aria-hidden="true">
                <Icon name={item.icon} size={20} />
              </span>
            )}
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function Dialog({
  title,
  children,
  footer,
  onClose,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // The title names the dialog for screen readers.
  const titleId = useId();
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? "dialog wide" : "dialog"} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header id={titleId}>{title}</header>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-actions">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
