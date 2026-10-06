import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import type { PaintLayer, PaintOp, PaintStroke } from "@/core/document/model";
import { canvasToContent, insertLayer, locate, paintLayer, updateLayer } from "@/core/document/operations";
import { BRUSHES, recognize, streamline } from "@/core/document/paint";
import { beginDocGesture, composite, editDocument, endDocGesture } from "@/core/document/session";
import type { Point } from "@/lib/math";
import { chooseBrush, paint, releaseFocus } from "./state";

type Mapping = { toDoc: (clientX: number, clientY: number) => Point; pxPerDoc: number };

const apply = (m: readonly number[], p: Point) => {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
};

/** The selected drawing, or a new one above the selection (inside the current gesture). */
function drawingLayer(): PaintLayer | null {
  const { doc, selection } = composite.getState();
  if (!doc) return null;
  const selected = selection.length ? locate(doc.layers, selection[selection.length - 1])?.layer : null;
  if (selected?.kind === "paint" && !selected.locked && selected.visible) return selected;
  const layer = paintLayer(doc);
  editDocument("New drawing", (d) => insertLayer(d, layer, selection.at(-1)));
  composite.setState({ selection: [layer.id] });
  return layer;
}

/** How long the pointer rests at the end of a stroke before it is straightened. */
const HOLD_MS = 550;

/**
 * Brushes and the bucket on the canvas. Each stroke is one undoable step; the document
 * is updated once per frame while drawing (the compositor redraws only the new stroke).
 */
export function PaintOverlay({ toDoc, pxPerDoc }: Mapping) {
  const s = useStore(paint, (x) => x);
  const [hover, setHover] = useState<Point | null>(null);
  const [snapped, setSnapped] = useState<{ label: string; at: Point } | null>(null);
  const active = useRef<{ pointer: number; cancel: () => void } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => () => active.current?.cancel(), []);
  useEffect(() => {
    if (!snapped) return;
    const t = setTimeout(() => setSnapped(null), 900);
    return () => clearTimeout(t);
  }, [snapped]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // A second finger while drawing: that was a pinch or a mistake, so drop the stroke.
    if (active.current) {
      active.current.cancel();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    releaseFocus();
    const settings = paint.getState();
    beginDocGesture(settings.bucket ? "Fill" : "Brush stroke");
    const layer = drawingLayer();
    if (!layer) return endDocGesture();
    const toUnit = canvasToContent(layer.transform);
    const unit = (p: Point) => apply(toUnit, p);
    const before: readonly PaintOp[] = (locate(composite.getState().doc!.layers, layer.id)?.layer as PaintLayer).ops;
    const setOps = (ops: readonly PaintOp[]) => editDocument(settings.bucket ? "Fill" : "Brush stroke", (d) => updateLayer(d, layer.id, (l) => (l.kind === "paint" ? { ...l, ops } : l)));

    if (settings.bucket) {
      const u = unit(toDoc(e.clientX, e.clientY));
      setOps([...before, { type: "fill", x: u.x, y: u.y, color: settings.color, opacity: settings.opacity, tolerance: settings.tolerance }]);
      endDocGesture();
      return;
    }

    const pressured = e.pointerType === "pen";
    let stroke: PaintStroke = {
      type: "stroke",
      brush: settings.brush,
      color: settings.color,
      size: settings.size / layer.transform.width,
      opacity: settings.opacity,
      hardness: settings.hardness,
      points: [],
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    const points: number[] = [];
    const docPoints: Point[] = [];
    let prev: Point | null = null;
    let frame = 0;
    let done = false;
    let shaped = false;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let anchor: Point | null = null;
    const flush = () => {
      frame = 0;
      stroke = { ...stroke, points: points.slice() };
      setOps([...before, stroke]);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const add = (ev: PointerEvent | ReactPointerEvent) => {
      const p = toDoc(ev.clientX, ev.clientY);
      const sm = streamline(prev, p.x, p.y, settings.smoothing);
      prev = sm;
      docPoints.push(sm);
      const u = unit(sm);
      points.push(u.x, u.y, pressured ? Math.max(0.05, ev.pressure || 0.5) : 1);
    };
    const straighten = () => {
      hold = null;
      if (!settings.shapes || done || shaped) return;
      const shape = recognize(docPoints);
      if (!shape) return;
      shaped = true;
      const pressure = points.length ? points.filter((_, i) => i % 3 === 2).reduce((a, b) => a + b, 0) / (points.length / 3) : 1;
      points.length = 0;
      for (const p of shape.points) {
        const u = unit(p);
        points.push(u.x, u.y, pressure);
      }
      flush();
      const last = shape.points[shape.points.length - 1];
      const label = { line: "Line", ellipse: "Ellipse", triangle: "Triangle", rectangle: "Rectangle", polygon: "Shape" }[shape.kind];
      setSnapped({ label, at: last });
    };
    const rest = (p: Point) => {
      // Moving more than a few screen pixels restarts the hold.
      if (anchor && Math.hypot(p.x - anchor.x, p.y - anchor.y) * pxPerDoc < 4) return;
      anchor = p;
      if (hold) clearTimeout(hold);
      hold = setTimeout(straighten, HOLD_MS);
    };
    add(e);
    flush();
    rest(prev!);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId || shaped) return;
      const events = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
      for (const c of events.length ? events : [ev]) add(c);
      schedule();
      rest(prev!);
    };
    const finish = (cancelled: boolean) => {
      if (done) return;
      done = true;
      if (frame) cancelAnimationFrame(frame);
      if (hold) clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (cancelled) setOps(before);
      else flush();
      endDocGesture();
      active.current = null;
    };
    const up = (ev: PointerEvent) => ev.pointerId === e.pointerId && finish(false);
    const cancel = (ev: PointerEvent) => ev.pointerId === e.pointerId && finish(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    active.current = { pointer: e.pointerId, cancel: () => finish(true) };
  };

  const rect = ref.current?.getBoundingClientRect();
  const radius = Math.max(1, (s.size / 2) * pxPerDoc);
  return (
    <div
      ref={ref}
      className="tool-overlay"
      data-tool="paint"
      style={{ cursor: s.bucket ? "crosshair" : "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => e.pointerType !== "touch" && setHover({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="transform-svg">
        {hover && rect && !s.bucket && (
          <>
            <circle cx={hover.x - rect.left} cy={hover.y - rect.top} r={radius} fill="none" stroke="#000" strokeOpacity={0.5} strokeWidth={2} />
            <circle cx={hover.x - rect.left} cy={hover.y - rect.top} r={radius} fill="none" stroke="#fff" strokeWidth={1} />
          </>
        )}
      </svg>
      {snapped && <div className="tool-toast">{snapped.label}</div>}
    </div>
  );
}

/** Brush, colour and size: the drawing tool's options, above the canvas. */
export function PaintOptions({ onDone }: { onDone: () => void }) {
  const s = useStore(paint, (x) => x);
  const doc = useStore(composite, (x) => x.doc);
  const short = doc ? Math.min(doc.width, doc.height) : 1000;
  const maxSize = Math.max(50, Math.round(short / 4));
  const range = (label: string, value: number, min: number, max: number, onChange: (v: number) => void, format: (v: number) => string) => (
    <label className="tool-range">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} aria-label={label} aria-valuetext={format(value)} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format(value)}</output>
    </label>
  );
  return (
    <div className="tool-options" role="toolbar" aria-label="Drawing options">
      <div className="segmented" role="group" aria-label="Brush">
        {BRUSHES.map((b) => (
          <button key={b.kind} type="button" title={b.note} aria-pressed={!s.bucket && s.brush === b.kind} onClick={() => chooseBrush(b.kind, short)}>
            {b.label}
          </button>
        ))}
        <button type="button" title="Fill an area with the colour (tap inside a shape)" aria-pressed={s.bucket} onClick={() => paint.setState({ bucket: !s.bucket })}>
          Fill
        </button>
      </div>
      <input type="color" value={s.color} aria-label="Brush colour" onChange={(e) => paint.setState({ color: e.target.value })} />
      {!s.bucket && range("Size", Math.round(s.size), 1, maxSize, (v) => paint.setState({ size: v }), (v) => `${v}px`)}
      {range("Opacity", Math.round(s.opacity * 100), 1, 100, (v) => paint.setState({ opacity: v / 100 }), (v) => `${v}%`)}
      {!s.bucket && s.brush === "soft" && range("Hardness", Math.round(s.hardness * 100), 0, 100, (v) => paint.setState({ hardness: v / 100 }), (v) => `${v}%`)}
      {!s.bucket && range("Smoothing", Math.round(s.smoothing * 100), 0, 100, (v) => paint.setState({ smoothing: v / 100 }), (v) => `${v}%`)}
      {s.bucket && range("Tolerance", Math.round(s.tolerance * 100), 0, 100, (v) => paint.setState({ tolerance: v / 100 }), (v) => `${v}%`)}
      {!s.bucket && (
        <label className="check" title="Hold still at the end of a stroke to straighten it into a line, circle, rectangle or triangle">
          <input type="checkbox" checked={s.shapes} onChange={(e) => paint.setState({ shapes: e.target.checked })} /> Hold to straighten
        </label>
      )}
      <button type="button" className="btn small primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
