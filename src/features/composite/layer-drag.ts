import { type DropPlace, locate, moveLayers } from "@/core/document/operations";
import { composite, editDocument } from "@/core/document/session";

/**
 * Reordering layers by dragging their rows. Pointer events, not HTML drag and drop,
 * so a finger on a phone works as well as a mouse or pen: the row's grip starts a
 * drag at once (touch, mouse or pen), and on a computer the whole row starts one
 * after a few pixels of movement. While dragging, a copy of the row follows the
 * pointer, the row under it shows where the layers will land (above, below, or into
 * a group), and the list scrolls when the pointer nears its top or bottom. Escape
 * cancels; letting go makes one undoable "Move layer" edit.
 */

const EDGE = 28; // px from a scroller's edge where auto-scroll starts
const MAX_SPEED = 14; // px per frame at the very edge
const DWELL_MS = 250; // the pointer rests at an edge this long first, so rows near it stay easy to drop on

type Target = { row: HTMLElement; id: string; place: DropPlace };

/** The nearest ancestor that scrolls vertically (the side panel, or the phone's sheet). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Where a drop at client y would put the layers, relative to `row`. */
function placeFor(row: HTMLElement, y: number, ids: readonly string[]): DropPlace {
  const r = row.getBoundingClientRect();
  const t = (y - r.top) / Math.max(1, r.height);
  const group = row.dataset.kind === "group" && !ids.includes(row.dataset.sweepId!);
  if (group) {
    // An open group's children are listed under it, so its lower part means "into".
    if (row.dataset.expanded === "true") return t < 0.3 ? "above" : "into";
    return t < 0.3 ? "above" : t > 0.7 ? "below" : "into";
  }
  return t < 0.5 ? "above" : "below";
}

/**
 * Starts dragging `ids` from `row` (the layer row the press began on). `immediate`
 * starts at once (the grip); otherwise only after the pointer moves a few pixels
 * (a plain press on a row stays a click).
 */
export function startLayerDrag(e: PointerEvent, row: HTMLElement, ids: readonly string[], immediate: boolean) {
  const list = row.closest<HTMLElement>(".layer-list");
  if (!list || !ids.length) return;
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  let x = startX;
  let y = startY;
  let ghost: HTMLElement | null = null;
  let target: Target | null = null;
  let raf = 0;
  let scroller: HTMLElement | null = null;
  let edgeSince = 0;
  const offsetY = startY - row.getBoundingClientRect().top;

  const rows = () => [...list.querySelectorAll<HTMLElement>(".layer-row")];
  const setTarget = (next: Target | null) => {
    if (target && (!next || target.row !== next.row || target.place !== next.place)) delete target.row.dataset.reorder;
    target = next;
    if (target) target.row.dataset.reorder = target.place;
  };

  const begin = () => {
    const r = row.getBoundingClientRect();
    ghost = row.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("role");
    ghost.removeAttribute("data-sweep-id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.classList.add("layer-ghost");
    ghost.style.width = `${r.width}px`;
    ghost.style.left = `${r.left}px`;
    if (ids.length > 1) {
      const badge = document.createElement("span");
      badge.className = "layer-ghost-count";
      badge.textContent = `${ids.length} layers`;
      ghost.append(badge);
    }
    document.body.append(ghost);
    for (const el of rows()) if (ids.includes(el.dataset.sweepId!)) el.classList.add("layer-dragging");
    document.documentElement.classList.add("layer-reordering");
    scroller = scrollerOf(list);
    if (e.pointerType === "touch") navigator.vibrate?.(8);
    raf = requestAnimationFrame(tick);
  };

  const locateTarget = () => {
    const all = rows();
    if (!all.length) return setTarget(null);
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".layer-row");
    if (hit && list.contains(hit) && !hit.classList.contains("layer-ghost")) {
      // Over one of the dragged rows: no move.
      if (ids.includes(hit.dataset.sweepId!)) return setTarget(null);
      return setTarget({ row: hit, id: hit.dataset.sweepId!, place: placeFor(hit, y, ids) });
    }
    // Past the ends of the list: the top or the bottom of the document.
    const roots = all.filter((el) => el.dataset.depth === "0" && !ids.includes(el.dataset.sweepId!));
    if (!roots.length) return setTarget(null);
    if (y < roots[0].getBoundingClientRect().top) return setTarget({ row: roots[0], id: roots[0].dataset.sweepId!, place: "above" });
    const last = roots[roots.length - 1];
    if (y > last.getBoundingClientRect().bottom) return setTarget({ row: last, id: last.dataset.sweepId!, place: "below" });
  };

  const tick = () => {
    if (!ghost) return;
    ghost.style.top = `${y - offsetY}px`;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const up = y < r.top + EDGE && scroller.scrollTop > 0;
      const down = y > r.bottom - EDGE && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
      if (!up && !down) edgeSince = 0;
      else if (!edgeSince) edgeSince = performance.now();
      else if (performance.now() - edgeSince > DWELL_MS) {
        const speed = up ? -(r.top + EDGE - y) / EDGE : (y - (r.bottom - EDGE)) / EDGE;
        scroller.scrollTop += Math.max(-1, Math.min(1, speed)) * MAX_SPEED;
      }
    }
    locateTarget();
    raf = requestAnimationFrame(tick);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    if (!ghost && Math.hypot(x - startX, y - startY) > 4) begin();
    if (ghost) ev.preventDefault();
  };
  const stop = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(raf);
    const t = target;
    setTarget(null);
    if (!ghost) return;
    ghost.remove();
    ghost = null;
    for (const el of rows()) el.classList.remove("layer-dragging");
    document.documentElement.classList.remove("layer-reordering");
    // The click that ends a mouse drag must not select the row underneath.
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!commit || !t) return;
    const doc = composite.getState().doc;
    if (!doc || !locate(doc.layers, t.id)) return;
    editDocument(ids.length > 1 ? `Move ${ids.length} layers` : "Move layer", (d) => moveLayers(d, ids, t.id, t.place));
  };
  const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && stop(true);
  const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && stop(false);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    stop(false);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  if (immediate) begin();
}
