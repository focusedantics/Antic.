import { type PointerEvent as ReactPointerEvent, useEffect } from "react";
import { useStore } from "@/app/hooks";
import { apply } from "@/core/develop/geometry";
import type { Layer, LayerCrop } from "@/core/document/model";
import { canvasToContent, contentCorners, contentToCanvas, locate, updateLayer } from "@/core/document/operations";
import { beginDocGesture, composite, type CompositeState, editDocument, endDocGesture } from "@/core/document/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { clamp, type Point } from "@/lib/math";

/**
 * Free crop on the canvas (double-tap a photo, or Crop in its properties): the whole photo
 * shows with what is cut away dimmed; any edge or corner drags on its own (no fixed shape),
 * and a drag inside moves the crop over the photo. The crop is the layer's `crop`, so it
 * is data like any other edit and the photo itself is never changed.
 */

/** Layers the crop tool works on: photos and filled photo frames. */
export const croppable = (l: Layer | null | undefined): boolean => !!l && !l.locked && (l.kind === "image" || (l.kind === "slot" && !!l.assetId));

/** The layer being cropped: the selected one, while the crop tool is on. */
export function cropTarget(): Layer | null {
  const { doc, selection, tool } = composite.getState();
  if (tool !== "crop" || !doc || !selection.length) return null;
  const l = locate(doc.layers, selection[selection.length - 1])?.layer;
  return l && croppable(l) ? l : null;
}

/** The view before cropping zoomed out to show a whole photo, to go back to after. */
let viewBefore: CompositeState["view"] | null = null;

/**
 * Starts cropping a layer. A photo reaching past the screen (larger than the page, or
 * zoomed in) is first brought whole into view, so every edge can be taken hold of.
 */
export function startCrop(id: string) {
  const { doc, view, tool } = composite.getState();
  // Left some other way last time (the Move tool): that view is stale.
  if (tool !== "crop") viewBefore = null;
  composite.setState({ tool: "crop", selection: [id], maskLayerId: null });
  const layer = doc ? locate(doc.layers, id)?.layer : null;
  if (!doc || !layer) return;
  const engine = developEngine();
  const corners = contentCorners(layer.transform);
  const rect = engine.canvas.getBoundingClientRect();
  const inside = corners.every((c) => {
    const p = engine.docToClient(c.x, c.y);
    return p.x >= rect.left + REACH && p.x <= rect.right - REACH && p.y >= rect.top + REACH && p.y <= rect.bottom - REACH;
  });
  if (inside) return;
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  viewBefore ??= view;
  composite.setState({ view: { fit: false, zoom: Math.min(engine.compositeScale(), engine.compositeFitFor(x1 - x0, y1 - y0)), centerX: (x0 + x1) / 2 / doc.width, centerY: (y0 + y1) / 2 / doc.height } });
}

/** Back to moving layers, and to the view from before cropping. */
export function endCrop() {
  composite.setState({ tool: "move", ...(viewBefore ? { view: viewBefore } : {}) });
  viewBefore = null;
}

/** How near an edge (screen pixels) a press takes hold of it. */
const REACH = 22;
/** Smallest crop, as a share of the photo's width or height. */
const MIN = 0.03;
const FULL: LayerCrop = { left: 0, top: 0, right: 1, bottom: 1 };

/** Which edges a handle moves. */
type Edges = { left?: true; right?: true; top?: true; bottom?: true };
const HANDLES: { at: [number, number]; edges: Edges; cursor: string }[] = [
  { at: [0, 0], edges: { left: true, top: true }, cursor: "nwse-resize" },
  { at: [0.5, 0], edges: { top: true }, cursor: "ns-resize" },
  { at: [1, 0], edges: { right: true, top: true }, cursor: "nesw-resize" },
  { at: [1, 0.5], edges: { right: true }, cursor: "ew-resize" },
  { at: [1, 1], edges: { right: true, bottom: true }, cursor: "nwse-resize" },
  { at: [0.5, 1], edges: { bottom: true }, cursor: "ns-resize" },
  { at: [0, 1], edges: { left: true, bottom: true }, cursor: "nesw-resize" },
  { at: [0, 0.5], edges: { left: true }, cursor: "ew-resize" },
];

/** The crop with the given edges moved to a point in the photo (0–1 across and down). */
export function dragEdges(c: LayerCrop, edges: Edges, u: number, v: number): LayerCrop {
  return {
    left: edges.left ? clamp(u, 0, c.right - MIN) : c.left,
    right: edges.right ? clamp(u, c.left + MIN, 1) : c.right,
    top: edges.top ? clamp(v, 0, c.bottom - MIN) : c.top,
    bottom: edges.bottom ? clamp(v, c.top + MIN, 1) : c.bottom,
  };
}

/** The crop moved by du, dv, kept on the photo. */
export function moveCrop(c: LayerCrop, du: number, dv: number): LayerCrop {
  const w = c.right - c.left;
  const h = c.bottom - c.top;
  const left = clamp(c.left + du, 0, 1 - w);
  const top = clamp(c.top + dv, 0, 1 - h);
  return { left, top, right: left + w, bottom: top + h };
}

const setCrop = (id: string, crop: LayerCrop) => editDocument("Crop", (d) => updateLayer(d, id, (l) => ({ ...l, crop })));

export function CropOverlay({ toDoc, local, onDone }: { toDoc: (x: number, y: number) => Point; local: (p: Point) => Point; onDone: () => void }) {
  useStore(composite, (s) => s.doc);
  const layer = cropTarget();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        onDone();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onDone]);
  // The selection moved to something that can't be cropped: back to moving.
  useEffect(() => {
    if (!layer) onDone();
  }, [layer, onDone]);
  if (!layer) return null;
  const toScreen = contentToCanvas(layer.transform);
  const at = (u: number, v: number) => {
    const [x, y] = apply(toScreen, u, v);
    return local({ x, y });
  };
  const toPhoto = (clientX: number, clientY: number) => {
    const p = toDoc(clientX, clientY);
    const [u, v] = apply(canvasToContent(layer.transform), p.x, p.y);
    return { u, v };
  };
  const c = layer.crop;
  const quad = (l: number, t: number, r: number, b: number) => [at(l, t), at(r, t), at(r, b), at(l, b)];
  const points = (q: Point[]) => q.map((p) => `${p.x},${p.y}`).join(" ");
  const whole = quad(0, 0, 1, 1);
  const kept = quad(c.left, c.top, c.right, c.bottom);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const drag = (e: ReactPointerEvent, change: (start: { u: number; v: number }, now: { u: number; v: number }) => LayerCrop) => {
    e.preventDefault();
    e.stopPropagation();
    const start = toPhoto(e.clientX, e.clientY);
    const id = layer.id;
    beginDocGesture("Crop");
    const move = (ev: PointerEvent) => setCrop(id, change(start, toPhoto(ev.clientX, ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      endDocGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // A finger's width, as a share of the photo's width and height on screen.
  const reachU = REACH / Math.max(1, Math.hypot(whole[1].x - whole[0].x, whole[1].y - whole[0].y));
  const reachV = REACH / Math.max(1, Math.hypot(whole[3].x - whole[0].x, whole[3].y - whole[0].y));

  const onBackground = (e: ReactPointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const p = toPhoto(e.clientX, e.clientY);
    const c0 = layer.crop;
    // Near an edge (or two, at a corner): that edge drags, even between the handles or
    // where the edge is at the very side of the screen.
    const across = p.v > c0.top - reachV && p.v < c0.bottom + reachV;
    const down = p.u > c0.left - reachU && p.u < c0.right + reachU;
    const edges: Edges = {
      ...(across && Math.abs(p.u - c0.left) < reachU ? { left: true } : across && Math.abs(p.u - c0.right) < reachU ? { right: true } : {}),
      ...(down && Math.abs(p.v - c0.top) < reachV ? { top: true } : down && Math.abs(p.v - c0.bottom) < reachV ? { bottom: true } : {}),
    };
    if (Object.keys(edges).length) return drag(e, (_s, n) => dragEdges(c0, edges, n.u, n.v));
    // Outside the photo: done. On it: slide the crop over the photo.
    if (p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1) return onDone();
    drag(e, (s, n) => moveCrop(c0, n.u - s.u, n.v - s.v));
  };

  return (
    <div className="tool-overlay" data-tool="crop" onPointerDown={onBackground}>
      <svg className="transform-svg">
        <path className="crop-dim" fillRule="evenodd" d={`M${points(whole)}Z M${points(kept)}Z`} />
        <polygon className="crop-area" points={points(kept)} />
        {[1 / 3, 2 / 3].map((t) => (
          <g key={t} className="crop-thirds">
            <line x1={at(lerp(c.left, c.right, t), c.top).x} y1={at(lerp(c.left, c.right, t), c.top).y} x2={at(lerp(c.left, c.right, t), c.bottom).x} y2={at(lerp(c.left, c.right, t), c.bottom).y} />
            <line x1={at(c.left, lerp(c.top, c.bottom, t)).x} y1={at(c.left, lerp(c.top, c.bottom, t)).y} x2={at(c.right, lerp(c.top, c.bottom, t)).x} y2={at(c.right, lerp(c.top, c.bottom, t)).y} />
          </g>
        ))}
        <polygon className="crop-frame" points={points(kept)} />
        {HANDLES.map(({ at: [hu, hv], edges, cursor }, i) => {
          const p = at(lerp(c.left, c.right, hu), lerp(c.top, c.bottom, hv));
          const corner = hu !== 0.5 && hv !== 0.5;
          return (
            <g key={i} style={{ cursor }} onPointerDown={(e) => drag(e, (_s, n) => dragEdges(layer.crop, edges, n.u, n.v))}>
              {/* A finger-sized target around a small visible handle. */}
              <circle className="crop-hit" cx={p.x} cy={p.y} r={20} />
              <rect className="crop-handle" data-corner={corner || undefined} x={p.x - (corner ? 7 : 5)} y={p.y - (corner ? 7 : 5)} width={corner ? 14 : 10} height={corner ? 14 : 10} rx={2} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Above the canvas while cropping: what to do, Reset and Done. */
export function CropOptions({ onDone }: { onDone: () => void }) {
  useStore(composite, (s) => s.doc);
  const layer = cropTarget();
  if (!layer) return null;
  const c = layer.crop;
  const cropped = c.left > 0 || c.top > 0 || c.right < 1 || c.bottom < 1;
  return (
    <div className="tool-options" role="toolbar" aria-label="Crop options">
      <span className="tool-hint" title="Drag any edge or corner; drag inside the crop to move it over the photo. Enter or a tap outside the photo finishes.">
        Drag edges or corners · drag inside to move
      </span>
      <button type="button" className="btn small" disabled={!cropped} onClick={() => editDocument("Reset crop", (d) => updateLayer(d, layer.id, (l) => ({ ...l, crop: FULL })), { merge: false })}>
        Reset
      </button>
      <button type="button" className="btn small primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
