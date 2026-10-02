import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icons";
import { Filmstrip } from "@/features/library/Filmstrip";
import { useStore } from "./hooks";
import { actionsSlot, layout, openSheet, type SheetSide } from "./layout";
import { PANEL_LIMITS, prefs, setPrefs } from "./prefs";
import { ui } from "./state";

/**
 * A button in the phone dock. It opens the sheet with one side's panels; `onSelect`
 * can first pick a tool (Develop's Crop, Masks, Heal open the right side on that tool).
 * Without a side it only runs `onSelect` (Composite's Effects opens the effects browser).
 */
export type DockItem = {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly side?: SheetSide;
  readonly disabled?: boolean;
  /** Shown as current while the sheet is open on its side (default: any time the side is open). */
  readonly active?: boolean;
  readonly onSelect?: () => void;
};

export type ShellProps = { left: ReactNode; center: ReactNode; right: ReactNode; dock?: readonly DockItem[] };

/** Three columns on a computer; on a phone, the viewer with a dock and a sheet. */
export function Shell(props: ShellProps) {
  const compact = useStore(layout, (s) => s.compact);
  return compact ? <CompactShell {...props} /> : <WideShell {...props} />;
}

// ─── Computer ────────────────────────────────────────────────────────────────

function WideShell({ left, center, right }: ShellProps) {
  const showLeft = useStore(prefs, (s) => s.showLeft);
  const showRight = useStore(prefs, (s) => s.showRight);
  const leftWidth = useStore(prefs, (s) => s.leftWidth);
  const rightWidth = useStore(prefs, (s) => s.rightWidth);
  return (
    <main className="workspace">
      {showLeft ? (
        <div className="side-frame" style={leftWidth ? ({ "--left-width": `${leftWidth}px` } as React.CSSProperties) : undefined}>
          <aside className="side left">{left}</aside>
          <Resizer side="left" />
        </div>
      ) : (
        <div />
      )}
      <section className="center">{center}</section>
      {showRight ? (
        <div className="side-frame" style={rightWidth ? ({ "--panel-width": `${rightWidth}px` } as React.CSSProperties) : undefined}>
          <Resizer side="right" />
          <aside className="side right">{right}</aside>
        </div>
      ) : (
        <div />
      )}
    </main>
  );
}

/** The panel's inner edge: drag to resize, arrow keys in steps, double-click for the default width. */
function Resizer({ side }: { side: "left" | "right" }) {
  const key = side === "left" ? "leftWidth" : "rightWidth";
  const cssVar = side === "left" ? "--left-width" : "--panel-width";
  const [min, max] = PANEL_LIMITS[side];
  const value = useStore(prefs, (s) => s[key]);
  const ref = useRef<HTMLDivElement>(null);
  const current = () => ref.current?.parentElement?.querySelector<HTMLElement>("aside.side")?.getBoundingClientRect().width ?? min;
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const frame = ref.current!.parentElement!;
    const startX = e.clientX;
    const startW = current();
    let width = startW;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.dataset.dragging = "true";
    // While dragging the width lives on the element; the preference is written once, at the end.
    const move = (ev: PointerEvent) => {
      width = clamp(startW + (side === "left" ? ev.clientX - startX : startX - ev.clientX));
      frame.style.setProperty(cssVar, `${width}px`);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      delete el.dataset.dragging;
      if (width !== startW) setPrefs({ [key]: width });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const keyDown = (e: ReactKeyboardEvent) => {
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key !== grow && e.key !== shrink && e.key !== "Home") return;
    e.preventDefault();
    e.stopPropagation(); // arrows also move between photos
    if (e.key === "Home") setPrefs({ [key]: null });
    else setPrefs({ [key]: clamp(current() + (e.key === grow ? 16 : -16)) });
  };
  return (
    <div
      ref={ref}
      className={`resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize the left panel" : "Resize the right panel"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value ?? current())}
      tabIndex={0}
      title="Drag to resize · double-click for the default width"
      onPointerDown={down}
      onDoubleClick={() => {
        ref.current?.parentElement?.style.removeProperty(cssVar);
        setPrefs({ [key]: null });
      }}
      onKeyDown={keyDown}
    />
  );
}

/** Top-bar toggles for the side panels and the filmstrip (Tab and Shift+F do the same). */
export function PanelToggles() {
  const showLeft = useStore(prefs, (s) => s.showLeft);
  const showRight = useStore(prefs, (s) => s.showRight);
  const showFilmstrip = useStore(prefs, (s) => s.showFilmstrip);
  const workspace = useStore(ui, (s) => s.workspace);
  const left = workspace === "develop" ? "presets, snapshots and history" : workspace === "library" ? "folders and collections" : workspace === "composite" ? "documents" : "clips";
  return (
    <div className="panel-toggles" role="group" aria-label="Panels">
      <button type="button" className="tool-btn" aria-pressed={showLeft} aria-label="Left panel" title={`${showLeft ? "Hide" : "Show"} the left panel (${left})`} onClick={() => setPrefs({ showLeft: !showLeft })}>
        <Icon name="panel-left" size={16} />
      </button>
      {workspace !== "video" && (
        <button type="button" className="tool-btn" aria-pressed={showFilmstrip} aria-label="Filmstrip" title={`${showFilmstrip ? "Hide" : "Show"} the filmstrip (Shift+F)`} onClick={() => setPrefs({ showFilmstrip: !showFilmstrip })}>
          <Icon name="panel-bottom" size={16} />
        </button>
      )}
      <button type="button" className="tool-btn" aria-pressed={showRight} aria-label="Right panel" title={`${showRight ? "Hide" : "Show"} the right panel`} onClick={() => setPrefs({ showRight: !showRight })}>
        <Icon name="panel-right" size={16} />
      </button>
    </div>
  );
}

// ─── Phone ───────────────────────────────────────────────────────────────────

/**
 * A workspace's main actions (undo, redo, export). On a phone they move out of the
 * long scrolling toolbar into the top bar, where Lightroom mobile keeps them; the
 * toolbar's own buttons carry `wide-only` and hide. On a computer this renders nothing.
 */
export function CompactActions({ children }: { children: ReactNode }) {
  const compact = useStore(layout, (s) => s.compact);
  const slot = useStore(actionsSlot, (s) => s.element);
  return compact && slot ? createPortal(children, slot) : null;
}

export function TopAction({ icon, label, onClick, disabled, primary, title }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; primary?: boolean; title?: string }) {
  return (
    <button type="button" className={`top-action${primary ? " primary" : ""}`} aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={20} />
    </button>
  );
}

function CompactShell({ left, center, right, dock }: ShellProps) {
  const sheet = useStore(layout, (s) => s.sheet);
  const showFilmstrip = useStore(prefs, (s) => s.showFilmstrip);
  const workspace = useStore(ui, (s) => s.workspace);
  const items = dock ?? [
    { id: "left", label: "Panels", icon: "folders", side: "left" },
    { id: "right", label: "Info", icon: "info", side: "right" },
  ];
  const open = sheet ? (items.find((i) => i.side === sheet && (i.active ?? true)) ?? items.find((i) => i.side === sheet)) : null;
  return (
    <main className="workspace compact">
      <section className="center">{center}</section>
      {sheet && open && (
        <Sheet title={open.label} onClose={() => openSheet(null)}>
          {sheet === "left" ? left : right}
        </Sheet>
      )}
      {!sheet && showFilmstrip && workspace !== "video" && <Filmstrip />}
      <nav className="dock" aria-label="Panels">
        {items.map((item) => {
          const current = !!item.side && sheet === item.side && (item.active ?? true);
          return (
            <button
              key={item.id}
              type="button"
              className="dock-btn"
              aria-pressed={item.side ? current : undefined}
              disabled={item.disabled}
              onClick={() => {
                if (current) return openSheet(null);
                item.onSelect?.();
                if (item.side) openSheet(item.side);
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </main>
  );
}

const SNAPS = [0.3, 0.5, 0.85];

/** A panel over the bottom of the screen: drag the grip to resize (it snaps), down to close. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const height = useStore(prefs, (s) => s.sheetHeight);
  const ref = useRef<HTMLDivElement>(null);
  const [min, max] = PANEL_LIMITS.sheet;

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current!;
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const startT = performance.now();
    let px = startH;
    el.dataset.dragging = "true";
    const move = (ev: PointerEvent) => {
      px = Math.max(40, Math.min(window.innerHeight * max, startH + startY - ev.clientY));
      el.style.height = `${px}px`;
    };
    const up = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      delete el.dataset.dragging;
      el.style.height = "";
      const share = px / window.innerHeight;
      const flickDown = (ev.clientY - startY) / Math.max(1, performance.now() - startT) > 0.9;
      if (Math.abs(ev.clientY - startY) < 4) return; // a tap on the grip
      if (share < 0.2 || (flickDown && share < height)) return onClose();
      const snap = SNAPS.reduce((a, b) => (Math.abs(b - share) < Math.abs(a - share) ? b : a));
      setPrefs({ sheetHeight: Math.min(max, Math.max(min, snap)) });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  const keyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowUp") setPrefs({ sheetHeight: SNAPS.find((s) => s > height + 0.01) ?? SNAPS[SNAPS.length - 1] });
    else if (height <= SNAPS[0] + 0.01) onClose();
    else setPrefs({ sheetHeight: [...SNAPS].reverse().find((s) => s < height - 0.01) ?? SNAPS[0] });
  };
  return (
    <section ref={ref} className="sheet" style={{ "--sheet": height } as React.CSSProperties} aria-label={title} data-testid="sheet">
      <div
        className="sheet-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the panel"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(height * 100)}
        tabIndex={0}
        onPointerDown={down}
        onKeyDown={keyDown}
      >
        <span aria-hidden="true" />
      </div>
      <div className="sheet-head">
        <strong>{title}</strong>
        <button type="button" className="btn ghost small" aria-label="Close the panel" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="sheet-body side">{children}</div>
    </section>
  );
}
