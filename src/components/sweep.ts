import { type RefObject, useEffect, useRef } from "react";

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
};

export const HOLD_MS = 280;
export const MOVE_PX = 6;
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
    } | null = null;
    let timer = 0;
    let swallowUntil = 0;

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

    const activate = (x: number, y: number, additive: boolean) => {
      if (!press || active) return;
      clearTimeout(timer);
      const o = origin();
      const start = opts.current.initial();
      const el = document.createElement("div");
      el.className = "sweep-box";
      document.body.append(el);
      document.documentElement.classList.add("sweeping");
      active = { sx: press.x - o.x, sy: press.y - o.y, x, y, base: additive ? start : [], start, caught: new Set(), el, raf: 0 };
      active.raf = requestAnimationFrame(autoscroll);
      update();
    };

    const finish = (cancelled: boolean) => {
      if (!active) return;
      const { el, raf, start, x, y, base, caught } = active;
      active = null;
      cancelAnimationFrame(raf);
      el.remove();
      document.documentElement.classList.remove("sweeping");
      // The trailing contextmenu (Windows sends it after the button comes up) is not a menu request.
      swallowUntil = performance.now() + 500;
      if (cancelled) opts.current.onSelect([...start]);
      else opts.current.onDone(combine(base, caught), x, y);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 2 || !(e.target instanceof Element)) return;
      if (opts.current.accept && !opts.current.accept(e.target)) return;
      press = { x: e.clientX, y: e.clientY, target: e.target, menu: null };
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      timer = window.setTimeout(() => activate(press?.x ?? e.clientX, press?.y ?? e.clientY, additive), HOLD_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (active) {
        active.x = e.clientX;
        active.y = e.clientY;
        update();
      } else if (press && (e.buttons & 2) && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_PX) {
        activate(e.clientX, e.clientY, e.shiftKey || e.ctrlKey || e.metaKey);
      }
    };
    const onUp = (e: PointerEvent) => {
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
      if (active || performance.now() < swallowUntil) {
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
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(timer);
      finish(true);
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("contextmenu", onMenu, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [ref]);
}
