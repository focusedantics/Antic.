import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icons";
import { Filmstrip } from "@/features/library/Filmstrip";
import { useStore } from "./hooks";
import { actionsSlot, floatHost, layout, openSheet, type SheetSide } from "./layout";
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
  /**
   * The sheet opens at its content's own height rather than the remembered one, and
   * without a title row: Develop's Edit shows about three sliders (dragging the grip
   * up still makes it taller).
   */
  readonly fit?: boolean;
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
  const sideways = useStore(layout, (s) => s.sideways);
  const showFilmstrip = useStore(prefs, (s) => s.showFilmstrip);
  const workspace = useStore(ui, (s) => s.workspace);
  const items = dock ?? [
    { id: "left", label: "Panels", icon: "folders", side: "left" },
    { id: "right", label: "Info", icon: "info", side: "right" },
  ];
  const open = sheet ? (items.find((i) => i.side === sheet && (i.active ?? true)) ?? items.find((i) => i.side === sheet)) : null;
  const host = useStore(floatHost, (s) => s.element);
  const cover = useStore(layout, (s) => s.cover);
  // Held upright, panels float translucent over the picture, like Lightroom mobile's;
  // the picture moves up clear of them where it can. Held sideways they sit beside it.
  const floating = !!open && !sideways;
  const panel = sheet && open && (
    <Sheet key={open.fit ? `fit-${open.id}` : "sheet"} title={open.label} fit={open.fit} floating={floating} onClose={() => openSheet(null)}>
      {sheet === "left" ? left : right}
    </Sheet>
  );
  return (
    <main className="workspace compact" style={{ "--cover": `${cover}px` } as React.CSSProperties}>
      <section className="center">
        {center}
        {floating && !host && panel}
      </section>
      {floating && host && createPortal(panel, host)}
      {!floating && panel}
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
function Sheet({ title, fit = false, floating = false, onClose, children }: { title: string; fit?: boolean; floating?: boolean; onClose: () => void; children: ReactNode }) {
  const remembered = useStore(prefs, (s) => s.sheetHeight);
  // A fitted sheet starts at its content's height; dragging it taller lasts until it closes.
  const [stretched, setStretched] = useState<number | null>(null);
  const height = fit ? stretched : remembered;
  const ref = useRef<HTMLDivElement>(null);
  const [min, max] = PANEL_LIMITS.sheet;
  // The content's own height as a share of the screen, measured while it is fitted.
  const natural = useRef<number>(SNAPS[0]);
  useLayoutEffect(() => {
    if (fit && height === null && ref.current && !ref.current.dataset.dragging) natural.current = ref.current.getBoundingClientRect().height / window.innerHeight;
  });
  // A floating sheet tells the viewer how much of it is covered, so the photo can sit clear of it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!floating || !el) return;
    const report = () => layout.setState({ cover: el.getBoundingClientRect().height });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      observer.disconnect();
      layout.setState({ cover: 0 });
    };
  }, [floating]);
  const setHeight = (share: number | null) => (fit ? setStretched(share) : share !== null && setPrefs({ sheetHeight: share }));

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
      if (share < 0.2 || (flickDown && share < startH / window.innerHeight)) return onClose();
      if (fit) {
        // Back near the content's height: fit it again.
        const fitted = natural.current;
        const snap = [fitted, ...SNAPS.filter((x) => x > fitted + 0.05)].reduce((a, b) => (Math.abs(b - share) < Math.abs(a - share) ? b : a));
        return setHeight(snap === fitted ? null : snap);
      }
      const snap = SNAPS.reduce((a, b) => (Math.abs(b - share) < Math.abs(a - share) ? b : a));
      setHeight(Math.min(max, Math.max(min, snap)));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  const keyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.stopPropagation();
    const now = height ?? natural.current;
    if (e.key === "ArrowUp") setHeight(SNAPS.find((s) => s > now + 0.01) ?? SNAPS[SNAPS.length - 1]);
    else if (fit && height !== null) setHeight([...SNAPS].reverse().find((s) => s < height - 0.01 && s > natural.current + 0.05) ?? null);
    else if (fit || now <= SNAPS[0] + 0.01) onClose();
    else setHeight([...SNAPS].reverse().find((s) => s < now - 0.01) ?? SNAPS[0]);
  };
  return (
    <section
      ref={ref}
      className="sheet"
      style={height === null ? undefined : ({ "--sheet": height } as React.CSSProperties)}
      data-fit={fit ? (height === null ? "content" : "stretched") : undefined}
      data-floating={floating || undefined}
      aria-label={title}
      data-testid="sheet"
    >
      <div
        className="sheet-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the panel"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={height === null ? undefined : Math.round(height * 100)}
        tabIndex={0}
        onPointerDown={down}
        onKeyDown={keyDown}
      >
        <span aria-hidden="true" />
      </div>
      {!fit && (
        <div className="sheet-head">
          <strong>{title}</strong>
          <button type="button" className="btn ghost small" aria-label="Close the panel" onClick={onClose}>
            ✕
          </button>
        </div>
      )}
      <div className="sheet-body side">{children}</div>
    </section>
  );
}
