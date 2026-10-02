import { type RefObject, useEffect, useRef } from "react";
import { layout } from "@/app/layout";
import { isSelecting, type SelectScope, startSelecting, toggleSelected } from "@/app/select-mode";

/**
 * Right-click and hold (or right-drag) to sweep a selection box over items.
 *
 * - A quick right-click still opens the usual context menu.
 * - Holding the right button (HOLD_MS) or dragging it (MOVE_PX) starts a box;
 *   everything it touches is selected live. Shift or Ctrl adds to the selection.
 * - Releasing calls `onDone` with the pointer position (for a batch menu).
 * - Esc cancels and restores the selection the sweep started from.
 * - Near the edge of `scroller` the list scrolls; items scrolled out of view
 *   (virtualized lists unmount them) keep their caught state.
 *
 * Fingers (with a `scope`, see `app/select-mode.ts`): a press held still on an item
 * enters select mode with that item selected. In select mode a tap toggles an item
 * (the item's own tap handling stands down), a swipe across the list's scroll
 * direction sweeps a box that adds what it touches, and a swipe along it scrolls.
 */
export type Box = { left: number; top: number; right: number; bottom: number };

export type SweepOptions = {
  /** Every item that can be evaluated now, with whether `box` (client px) touches it. */
  hits: (box: Box) => Iterable<readonly [id: string, inside: boolean]>;
  /** Selection when the sweep starts (kept and added to with Shift/Ctrl). */
  initial: () => readonly string[];
  onSelect: (ids: string[]) => void;
  onDone: (ids: string[], x: number, y: number) => void;
  /** The scrolling element, for auto-scroll and content-anchored boxes. Defaults to the host. */
  scroller?: () => HTMLElement | null;
  /** Return false to ignore a press that starts here (e.g. on a control). */
  accept?: (target: Element) => boolean;
  /** Touch batch selection for this list (select mode). */
  scope?: SelectScope;
  /** The list's scroll direction: a finger sweeps across it and scrolls along it. Default "y". */
  axis?: "x" | "y";
};

export const HOLD_MS = 280;
export const MOVE_PX = 6;
/** A finger held this long on an item enters select mode. */
export const LONG_PRESS_MS = 450;
const TOUCH_SLOP = 8;
const EDGE = 28;

export function boxFrom(ax: number, ay: number, bx: number, by: number): Box {
  return { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
}

export const touches = (a: Box, b: Box) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Updates caught ids with what could be evaluated; everything else keeps its state. */
export function mergeCaught(caught: ReadonlySet<string>, evaluated: Iterable<readonly [string, boolean]>): Set<string> {
  const next = new Set(caught);
  for (const [id, inside] of evaluated) {
    if (inside) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Hit test for DOM items carrying `data-sweep-id` inside `root`. */
export function* domHits(root: HTMLElement | null, box: Box): Generator<readonly [string, boolean]> {
  if (!root) return;
  for (const el of root.querySelectorAll<HTMLElement>("[data-sweep-id]")) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    yield [el.dataset.sweepId!, touches(box, r)] as const;
  }
}

/** Ordered union: the starting selection first, then newly caught ids. */
function combine(base: readonly string[], caught: ReadonlySet<string>) {
  const out = [...base];
  const have = new Set(base);
  for (const id of caught) if (!have.has(id)) out.push(id);
  return out;
}

export function useSweepSelect(ref: RefObject<HTMLElement | null>, options: SweepOptions) {
  const opts = useRef(options);
  opts.current = options;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    type Press = { x: number; y: number; target: Element; menu: { target: Element; x: number; y: number } | null };
    let press: Press | null = null;
    let active: {
      // Box start in scroller content coordinates, so it stays put while the list scrolls.
      sx: number;
      sy: number;
      x: number;
      y: number;
      base: readonly string[];
      start: readonly string[];
      caught: Set<string>;
      el: HTMLDivElement;
      raf: number;
      touch: boolean;
    } | null = null;
    let timer = 0;
    let swallowUntil = 0;
    // A finger on an item: waiting to see whether it is a tap, a hold, a sweep or a scroll.
    let finger: { id: string; target: Element; x: number; y: number; pointerId: number; selecting: boolean; mode: "pending" | "held" | "sweep"; timer: number } | null = null;
    // Mouse events browsers emulate after a tap (mousedown, click, dblclick) must not undo it.
    let swallowTapUntil = 0;

    const scroller = () => opts.current.scroller?.() ?? host;
    const origin = () => {
      const s = scroller();
      const r = s.getBoundingClientRect();
      return { x: r.left - s.scrollLeft, y: r.top - s.scrollTop };
    };

    const update = () => {
      if (!active) return;
      const o = origin();
      const box = boxFrom(active.sx + o.x, active.sy + o.y, active.x, active.y);
      // Clip the drawn box to the scroller so it never covers neighbouring panels.
      const v = scroller().getBoundingClientRect();
      const shown = { left: Math.max(box.left, v.left), top: Math.max(box.top, v.top), right: Math.min(box.right, v.right), bottom: Math.min(box.bottom, v.bottom) };
      Object.assign(active.el.style, {
        left: `${shown.left}px`,
        top: `${shown.top}px`,
        width: `${Math.max(0, shown.right - shown.left)}px`,
        height: `${Math.max(0, shown.bottom - shown.top)}px`,
      });
      active.caught = mergeCaught(active.caught, opts.current.hits(box));
      opts.current.onSelect(combine(active.base, active.caught));
    };

    const autoscroll = () => {
      if (!active) return;
      const s = scroller();
      const r = s.getBoundingClientRect();
      const speed = (d: number) => Math.ceil(Math.min(1, (EDGE - d) / EDGE) * 18);
      let dx = 0;
      let dy = 0;
      if (s.scrollWidth > s.clientWidth) {
        if (active.x < r.left + EDGE) dx = -speed(active.x - r.left);
        else if (active.x > r.right - EDGE) dx = speed(r.right - active.x);
      }
      if (s.scrollHeight > s.clientHeight) {
        if (active.y < r.top + EDGE) dy = -speed(active.y - r.top);
        else if (active.y > r.bottom - EDGE) dy = speed(r.bottom - active.y);
      }
      if (dx || dy) {
        s.scrollLeft += dx;
        s.scrollTop += dy;
        update();
      }
      active.raf = requestAnimationFrame(autoscroll);
    };

    const activate = (x: number, y: number, additive: boolean, touch = false) => {
      if (!press || active) return;
      clearTimeout(timer);
      const o = origin();
      const start = opts.current.initial();
      const el = document.createElement("div");
      el.className = "sweep-box";
      document.body.append(el);
      document.documentElement.classList.add("sweeping");
      active = { sx: press.x - o.x, sy: press.y - o.y, x, y, base: additive ? start : [], start, caught: new Set(), el, raf: 0, touch };
      active.raf = requestAnimationFrame(autoscroll);
      update();
    };

    const finish = (cancelled: boolean) => {
      if (!active) return;
      const { el, raf, start, x, y, base, caught, touch } = active;
      active = null;
      cancelAnimationFrame(raf);
      el.remove();
      document.documentElement.classList.remove("sweeping");
      // The trailing contextmenu (Windows sends it after the button comes up) is not a menu request.
      swallowUntil = performance.now() + 500;
      if (cancelled) opts.current.onSelect([...start]);
      // A finger sweep only selects: the select bar holds the actions.
      else if (touch) opts.current.onSelect(combine(base, caught));
      else opts.current.onDone(combine(base, caught), x, y);
    };

    const swallowTap = () => {
      swallowTapUntil = performance.now() + 650;
    };
    const endFinger = () => {
      if (finger) clearTimeout(finger.timer);
      finger = null;
    };
    const onTouchDown = (e: PointerEvent) => {
      const scope = opts.current.scope;
      // Select mode is the phone layout's (its bar replaces the dock); larger screens tap and sweep as before.
      if (!scope || !layout.getState().compact || !(e.target instanceof Element)) return;
      if (!e.isPrimary) return endFinger(); // a second finger: a pinch, not a selection
      const item = e.target.closest<HTMLElement>("[data-sweep-id]");
      if (!item || !host.contains(item)) return;
      if (opts.current.accept && !opts.current.accept(e.target)) return;
      const selecting = isSelecting(scope);
      // Selecting, taps belong to select mode: the item's own handlers (select only this, open, drag) stand down.
      if (selecting) e.stopPropagation();
      endFinger();
      const id = item.dataset.sweepId!;
      finger = { id, target: e.target, x: e.clientX, y: e.clientY, pointerId: e.pointerId, selecting, mode: "pending", timer: 0 };
      if (!selecting)
        finger.timer = window.setTimeout(() => {
          if (!finger || finger.mode !== "pending") return;
          finger.mode = "held";
          startSelecting(scope, id);
          navigator.vibrate?.(8);
          swallowTap();
        }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: PointerEvent) => {
      if (!finger || e.pointerId !== finger.pointerId || finger.mode !== "pending") return;
      const dx = Math.abs(e.clientX - finger.x);
      const dy = Math.abs(e.clientY - finger.y);
      if (!finger.selecting) {
        if (Math.hypot(dx, dy) > TOUCH_SLOP) endFinger(); // a scroll, not a hold
        return;
      }
      const vertical = (opts.current.axis ?? "y") === "y";
      const along = vertical ? dy : dx;
      const across = vertical ? dx : dy;
      if (along > TOUCH_SLOP && along > across) return endFinger(); // scrolling the list
      if (across > TOUCH_SLOP && across >= along) {
        finger.mode = "sweep";
        press = { x: finger.x, y: finger.y, target: finger.target, menu: null };
        activate(e.clientX, e.clientY, true, true);
      }
    };
    const onTouchUp = (e: PointerEvent) => {
      if (!finger || e.pointerId !== finger.pointerId) return;
      const f = finger;
      endFinger();
      if (f.mode === "sweep") {
        press = null;
        swallowTap();
        return finish(e.type === "pointercancel");
      }
      if (f.mode === "held") return swallowTap();
      if (f.selecting && e.type === "pointerup" && opts.current.scope) {
        toggleSelected(opts.current.scope, f.id);
        swallowTap();
      }
    };
    const onEmulatedMouse = (e: Event) => {
      if (performance.now() >= swallowTapUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // While a finger sweeps, the list must not scroll under it (edges still auto-scroll).
    const onTouchScroll = (e: TouchEvent) => {
      if (active?.touch) e.preventDefault();
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") return onTouchDown(e);
      if (e.button !== 2 || !(e.target instanceof Element)) return;
      if (opts.current.accept && !opts.current.accept(e.target)) return;
      press = { x: e.clientX, y: e.clientY, target: e.target, menu: null };
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      timer = window.setTimeout(() => activate(press?.x ?? e.clientX, press?.y ?? e.clientY, additive), HOLD_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" && !active) return onTouchMove(e);
      if (active) {
        active.x = e.clientX;
        active.y = e.clientY;
        update();
      } else if (press && (e.buttons & 2) && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_PX) {
        activate(e.clientX, e.clientY, e.shiftKey || e.ctrlKey || e.metaKey);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") return onTouchUp(e);
      if (e.button !== 2) return;
      clearTimeout(timer);
      const p = press;
      press = null;
      if (active) return finish(false);
      // A quick right-click: show the menu that was held back (macOS and Linux send it on press).
      if (p?.menu) {
        const { target, x, y } = p.menu;
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, view: window }));
      }
    };
    const onMenu = (e: MouseEvent) => {
      if (!e.isTrusted) return; // our own re-dispatched menu
      // A held finger means select mode here, not the item's menu (Android sends one).
      if (active || finger || performance.now() < swallowUntil || performance.now() < swallowTapUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (press && !press.menu) {
        // Hold the menu until we know whether this is a click or a sweep.
        e.preventDefault();
        e.stopPropagation();
        press.menu = { target: e.target as Element, x: e.clientX, y: e.clientY };
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !active) return;
      e.preventDefault();
      e.stopPropagation();
      press = null;
      finish(true);
    };
    const onBlur = () => {
      clearTimeout(timer);
      press = null;
      finish(true);
    };

    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("contextmenu", onMenu, true);
    for (const type of ["mousedown", "click", "dblclick"]) host.addEventListener(type, onEmulatedMouse, true);
    host.addEventListener("touchmove", onTouchScroll, { passive: false });
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(timer);
      finish(true);
      endFinger();
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("contextmenu", onMenu, true);
      for (const type of ["mousedown", "click", "dblclick"]) host.removeEventListener(type, onEmulatedMouse, true);
      host.removeEventListener("touchmove", onTouchScroll);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [ref]);
}
