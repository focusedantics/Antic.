import { viewDpr } from "@/lib/device";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { layout } from "@/app/layout";
import { ui } from "@/app/state";
import type { BrushStroke, StrokePoint } from "@/core/develop/recipe";
import type { Layer } from "@/core/document/model";
import { canvasToContent, contentCorners, flatten, hitTest, layerBounds, locate, moveTransform, updateLayer } from "@/core/document/operations";
import { beginDocGesture, composite, editDocument, endDocGesture } from "@/core/document/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { apply } from "@/core/develop/geometry";
import { clamp, type Point } from "@/lib/math";
import { brush } from "@/features/develop/masks/brush";
import { addAssetsToComposite, fillSlot, importPhotosFromDevice } from "./actions";
import { useSweepSelect } from "@/components/sweep";
import { sweepLayers } from "./LayersPanel";

const SNAP_PX = 7;

export function zoomComposite(zoom: number, clientX?: number, clientY?: number) {
  const engine = developEngine();
  const { doc, view } = composite.getState();
  if (!doc) return;
  const fit = engine.compositeFitScale();
  if (zoom <= fit * 1.001) {
    composite.setState({ view: { ...view, fit: true, zoom: fit } });
    return;
  }
  let cx = view.fit ? 0.5 : view.centerX;
  let cy = view.fit ? 0.5 : view.centerY;
  if (clientX !== undefined && clientY !== undefined) {
    const p = engine.clientToDoc(clientX, clientY);
    const k = engine.compositeScale() / zoom;
    cx = p.x / doc.width + (cx - p.x / doc.width) * k;
    cy = p.y / doc.height + (cy - p.y / doc.height) * k;
  }
  composite.setState({ view: { fit: false, zoom, centerX: clamp(cx), centerY: clamp(cy) } });
}

function useRerenderOnFrame() {
  const [, force] = useState(0);
  useEffect(() => {
    const engine = developEngine();
    const previous = engine.onFrame;
    engine.onFrame = () => force((n) => n + 1);
    return () => {
      engine.onFrame = previous;
    };
  }, []);
}

/** Candidate snap lines: canvas edges/center, guides, other layers' edges/centers. */
function snapLines(exclude: ReadonlySet<string>) {
  const { doc, showGuides } = composite.getState();
  if (!doc) return { x: [] as number[], y: [] as number[] };
  const x = [0, doc.width / 2, doc.width];
  const y = [0, doc.height / 2, doc.height];
  if (showGuides) for (const g of doc.guides) (g.axis === "x" ? x : y).push(g.position);
  for (const l of flatten(doc.layers)) {
    if (exclude.has(l.id) || !l.visible || l.kind === "fill" || l.kind === "adjustment" || l.kind === "effect" || l.kind === "group") continue;
    const b = layerBounds(l);
    x.push(b.x, b.x + b.width / 2, b.x + b.width);
    y.push(b.y, b.y + b.height / 2, b.y + b.height);
  }
  return { x, y };
}

function snapDelta(values: number[], lines: number[], threshold: number) {
  let best: { d: number; line: number } | null = null;
  for (const v of values)
    for (const line of lines) {
      const d = line - v;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line };
    }
  return best;
}

type Guides = { x: number | null; y: number | null };

export function CompositeView() {
  const ref = useRef<HTMLDivElement>(null);
  // Phones: a panel floating over the bottom; the document moves up clear of it.
  const cover = useStore(layout, (s) => (s.compact ? s.cover : 0));
  useEffect(() => developEngine().setCover(cover), [cover]);
  // Right-click and hold, then drag on the canvas: select every layer the box touches.
  useSweepSelect(ref, {
    ...sweepLayers,
    accept: (target) => !target.closest(".ruler"),
    hits: function* (box) {
      const doc = composite.getState().doc;
      if (!doc) return;
      const engine = developEngine();
      const a = engine.clientToDoc(box.left, box.top);
      const b = engine.clientToDoc(box.right, box.bottom);
      const area = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
      // The same layers a click can pick: visible pictures, text and shapes.
      for (const l of flatten(doc.layers)) {
        if (!l.visible || l.kind === "group" || l.kind === "adjustment" || l.kind === "effect" || l.kind === "fill") continue;
        const r = layerBounds(l);
        yield [l.id, area.left <= r.x + r.width && area.right >= r.x && area.top <= r.y + r.height && area.bottom >= r.y] as const;
      }
    },
  });
  useRerenderOnFrame();
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  const tool = useStore(composite, (s) => s.tool);
  const showGuides = useStore(composite, (s) => s.showGuides);
  const maskLayerId = useStore(composite, (s) => s.maskLayerId);
  const maskComponentId = useStore(composite, (s) => s.maskComponentId);
  const b = useStore(brush, (s) => s);
  const [snapShown, setSnapShown] = useState<Guides>({ x: null, y: null });
  const [cursor, setCursor] = useState<Point | null>(null);

  useEffect(() => {
    const engine = developEngine();
    engine.mode = "composite";
    engine.invalidate();
    engine.attach(ref.current!);
    return () => {
      engine.detach();
      engine.mode = "develop";
      engine.invalidate();
    };
  }, []);

  // Pan (space / middle button) and wheel zoom.
  useEffect(() => {
    const el = ref.current!;
    const engine = developEngine();
    let space = false;
    let pan: { x: number; y: number; cx: number; cy: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      space = e.type === "keydown";
      el.style.cursor = space ? "grab" : "";
      if (space) e.preventDefault();
    };
    const onDown = (e: PointerEvent) => {
      const { view, doc } = composite.getState();
      if (!doc || !(e.button === 1 || (space && e.button === 0))) return;
      e.preventDefault();
      e.stopPropagation();
      pan = { x: e.clientX, y: e.clientY, cx: view.fit ? 0.5 : view.centerX, cy: view.fit ? 0.5 : view.centerY };
      el.setPointerCapture(e.pointerId);
      if (view.fit) composite.setState({ view: { fit: false, zoom: engine.compositeScale(), centerX: 0.5, centerY: 0.5 } });
    };
    const onMove = (e: PointerEvent) => {
      if (!pan) return;
      const { doc, view } = composite.getState();
      if (!doc) return;
      const s = engine.compositeScale() / viewDpr();
      composite.setState({ view: { ...view, fit: false, centerX: clamp(pan.cx - (e.clientX - pan.x) / s / doc.width), centerY: clamp(pan.cy - (e.clientY - pan.y) / s / doc.height) } });
    };
    const onUp = () => {
      pan = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomComposite(clamp(engine.compositeScale() * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), engine.compositeFitScale(), 16), e.clientX, e.clientY);
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  const engine = developEngine();
  const rect = engine.canvas.getBoundingClientRect();
  const local = (p: Point) => {
    const c = engine.docToClient(p.x, p.y);
    return { x: c.x - rect.left, y: c.y - rect.top };
  };
  const pxPerDoc = engine.compositeScale() / viewDpr();
  const primary = doc && selection.length ? (locate(doc.layers, selection[selection.length - 1])?.layer ?? null) : null;

  // ─── Move / transform ──────────────────────────────────────────────────
  const dragTransform = (e: ReactPointerEvent, label: string, apply: (dx: number, dy: number, p: Point, ev: PointerEvent) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const start = engine.clientToDoc(e.clientX, e.clientY);
    beginDocGesture(label);
    const move = (ev: PointerEvent) => {
      const p = engine.clientToDoc(ev.clientX, ev.clientY);
      apply(p.x - start.x, p.y - start.y, p, ev);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSnapShown({ x: null, y: null });
      endDocGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Topmost visible layer under a canvas point (groups are selected through their children). */
  const layerAt = (p: { x: number; y: number }) =>
    doc
      ? flatten(doc.layers)
          .filter((l) => l.visible && l.kind !== "group" && l.kind !== "adjustment" && l.kind !== "effect" && l.kind !== "fill")
          .reverse()
          .find((l) => hitTest(l, p))
      : undefined;
  // An empty photo frame tapped while already selected asks for its photo (on the click, so
  // the file picker opens from a user gesture, which phones require).
  const frameTap = useRef<string | null>(null);

  const onCanvasDown = (e: ReactPointerEvent) => {
    frameTap.current = null;
    if (e.button !== 0 || !doc) return;
    const p = engine.clientToDoc(e.clientX, e.clientY);
    if (tool === "mask" && maskLayerId) return paintMask(e);
    const hit = layerAt(p);
    const before = composite.getState().selection;
    if (hit?.kind === "slot" && !hit.assetId && !hit.locked && before.length === 1 && before[0] === hit.id) frameTap.current = hit.id;
    if (!hit) {
      composite.setState({ selection: [] });
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const current = composite.getState().selection;
    const selectionIds = additive ? (current.includes(hit.id) ? current.filter((id) => id !== hit.id) : [...current, hit.id]) : current.includes(hit.id) ? current : [hit.id];
    composite.setState({ selection: selectionIds });
    const moving = selectionIds.map((id) => locate(doc.layers, id)?.layer).filter((l): l is Layer => !!l && !l.locked);
    if (!moving.length) return;
    const starts = new Map(moving.map((l) => [l.id, l.transform]));
    const startBounds = moving.map(layerBounds);
    const exclude = new Set(moving.map((l) => l.id));
    const lines = snapLines(exclude);
    dragTransform(e, "Move", (dx, dy, _p, ev) => {
      let sx = dx;
      let sy = dy;
      const { snap } = composite.getState();
      const shown: Guides = { x: null, y: null };
      if (snap && !ev.altKey) {
        const minX = Math.min(...startBounds.map((b) => b.x)) + dx;
        const maxX = Math.max(...startBounds.map((b) => b.x + b.width)) + dx;
        const minY = Math.min(...startBounds.map((b) => b.y)) + dy;
        const maxY = Math.max(...startBounds.map((b) => b.y + b.height)) + dy;
        const tx = snapDelta([minX, (minX + maxX) / 2, maxX], lines.x, SNAP_PX / pxPerDoc);
        const ty = snapDelta([minY, (minY + maxY) / 2, maxY], lines.y, SNAP_PX / pxPerDoc);
        if (tx) {
          sx += tx.d;
          shown.x = tx.line;
        }
        if (ty) {
          sy += ty.d;
          shown.y = ty.line;
        }
      }
      setSnapShown(shown);
      editDocument("Move", (d) => {
        let next = d;
        for (const [id, t] of starts) next = updateLayer(next, id, (l) => ({ ...l, transform: moveTransform(t, sx, sy) }));
        return next;
      });
    });
  };

  const scaleHandle = (layer: Layer, corner: number) => (e: ReactPointerEvent) => {
    const t0 = layer.transform;
    const corners0 = contentCorners(t0);
    if (e.ctrlKey || e.metaKey) {
      // Perspective: move this corner freely.
      dragTransform(e, "Distort", (dx, dy) => {
        const corners = corners0.map((c, i) => (i === corner ? { x: c.x + dx, y: c.y + dy } : c)) as [Point, Point, Point, Point];
        editDocument("Distort", (d) => updateLayer(d, layer.id, (l) => ({ ...l, transform: { ...l.transform, corners } })));
      });
      return;
    }
    const opposite = corners0[(corner + 2) % 4];
    const rad = (t0.rotation * Math.PI) / 180;
    const ux = { x: Math.cos(rad), y: Math.sin(rad) };
    const uy = { x: -Math.sin(rad), y: Math.cos(rad) };
    dragTransform(e, "Scale", (_dx, _dy, p, ev) => {
      // Size in the layer's rotated axes, anchored at the opposite corner.
      const vx = (p.x - opposite.x) * ux.x + (p.y - opposite.y) * ux.y;
      const vy = (p.x - opposite.x) * uy.x + (p.y - opposite.y) * uy.y;
      let w = Math.max(2, Math.abs(vx));
      let h = Math.max(2, Math.abs(vy));
      if (!ev.shiftKey) {
        const k = Math.max(w / t0.width, h / t0.height);
        w = t0.width * k;
        h = t0.height * k;
      }
      const sx = Math.sign(vx) || 1;
      const sy = Math.sign(vy) || 1;
      const cx = opposite.x + ux.x * (w / 2) * sx + uy.x * (h / 2) * sy;
      const cy = opposite.y + ux.y * (w / 2) * sx + uy.y * (h / 2) * sy;
      editDocument("Scale", (d) => updateLayer(d, layer.id, (l) => ({ ...l, transform: { ...l.transform, x: cx, y: cy, width: w, height: h, corners: undefined } })));
    });
  };

  const rotateHandle = (layer: Layer) => (e: ReactPointerEvent) => {
    const t0 = layer.transform;
    const start = engine.clientToDoc(e.clientX, e.clientY);
    const a0 = Math.atan2(start.y - t0.y, start.x - t0.x);
    dragTransform(e, "Rotate", (_dx, _dy, p, ev) => {
      let angle = t0.rotation + ((Math.atan2(p.y - t0.y, p.x - t0.x) - a0) * 180) / Math.PI;
      if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
      editDocument("Rotate", (d) => updateLayer(d, layer.id, (l) => ({ ...l, transform: { ...l.transform, rotation: angle, corners: undefined } })));
    });
  };

  // ─── Layer mask painting ───────────────────────────────────────────────
  const maskLayer = doc && maskLayerId ? (locate(doc.layers, maskLayerId)?.layer ?? null) : null;
  const maskComponent = maskLayer?.mask?.components.find((c) => c.id === maskComponentId) ?? null;
  const toContent = (layer: Layer, p: Point) => {
    const [u, v] = apply(canvasToContent(layer.transform), p.x, p.y);
    return { x: u, y: v };
  };
  function paintMask(e: ReactPointerEvent) {
    if (!maskLayer || !maskComponent) return;
    const shape = maskComponent.shape;
    const layerId = maskLayer.id;
    const componentId = maskComponent.id;
    const setShape = (label: string, next: typeof shape) =>
      editDocument(label, (d) => updateLayer(d, layerId, (l) => ({ ...l, mask: l.mask ? { ...l.mask, components: l.mask.components.map((c) => (c.id === componentId ? { ...c, shape: next } : c)) } : null })));
    const start = toContent(maskLayer, engine.clientToDoc(e.clientX, e.clientY));
    if (shape.kind === "brush") {
      const long = Math.max(maskLayer.transform.width, maskLayer.transform.height);
      const pressure = e.pointerType === "pen" ? Math.max(0.05, e.pressure) : 1;
      // Brush size is set in screen pixels; convert to the layer's long side.
      const size = (b.size * Math.max(doc!.width, doc!.height)) / long;
      const stroke: BrushStroke = { mode: b.erase || e.altKey ? "erase" : "paint", size, feather: b.feather, flow: b.flow, density: b.density, points: [[start.x, start.y, pressure]] };
      let strokes = [...shape.strokes, stroke];
      const label = stroke.mode === "erase" ? "Mask: erase" : "Mask: paint";
      beginDocGesture(label);
      setShape(label, { kind: "brush", strokes });
      dragTransform(e, label, (_dx, _dy, p) => {
        const q = toContent(maskLayer, p);
        const last = strokes[strokes.length - 1];
        const point: StrokePoint = [q.x, q.y, pressure];
        strokes = [...strokes.slice(0, -1), { ...last, points: [...last.points, point] }];
        setShape(label, { kind: "brush", strokes });
      });
      return;
    }
    if (shape.kind === "linear") dragTransform(e, "Mask gradient", (_dx, _dy, p) => setShape("Mask gradient", { kind: "linear", start, end: toContent(maskLayer, p) }));
    if (shape.kind === "radial")
      dragTransform(e, "Mask gradient", (_dx, _dy, p) => {
        const q = toContent(maskLayer, p);
        const aspect = maskLayer.transform.width / maskLayer.transform.height;
        const long = Math.max(aspect, 1);
        setShape("Mask gradient", { ...shape, center: start, radiusX: Math.max(0.01, (Math.abs(q.x - start.x) * aspect) / long), radiusY: Math.max(0.01, Math.abs(q.y - start.y) / long) });
      });
  }

  // ─── Rulers & guides ───────────────────────────────────────────────────
  const dragGuide = (axis: "x" | "y", id?: string) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!doc) return;
    let guideId = id;
    beginDocGesture("Guide");
    if (!guideId) {
      guideId = `guide_${Date.now()}`;
      const p = engine.clientToDoc(e.clientX, e.clientY);
      editDocument("Guide", (d) => ({ ...d, guides: [...d.guides, { id: guideId!, axis, position: axis === "x" ? p.x : p.y }] }));
    }
    const move = (ev: PointerEvent) => {
      const p = engine.clientToDoc(ev.clientX, ev.clientY);
      editDocument("Guide", (d) => ({ ...d, guides: d.guides.map((g) => (g.id === guideId ? { ...g, position: Math.round(axis === "x" ? p.x : p.y) } : g)) }));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Dropping a guide back on a ruler removes it.
      const r = engine.canvas.getBoundingClientRect();
      if ((axis === "y" && ev.clientY < r.top + 18) || (axis === "x" && ev.clientX < r.left + 18))
        editDocument("Remove guide", (d) => ({ ...d, guides: d.guides.filter((g) => g.id !== guideId) }));
      endDocGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    const slot = frameTap.current;
    frameTap.current = null;
    if (!slot || !doc) return;
    // Only a tap: not the end of a drag.
    const hit = layerAt(engine.clientToDoc(e.clientX, e.clientY));
    if (hit?.id !== slot) return;
    void importPhotosFromDevice(false).then(([id]) => id && fillSlot(slot, id));
  };

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData("application/x-focused-assets");
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const at = engine.clientToDoc(e.clientX, e.clientY);
    // Dropped on a photo frame: the photo fills it.
    const target = layerAt(at);
    if (target?.kind === "slot" && !target.locked) return fillSlot(target.id, id);
    const selected = ui.getState().selection;
    void addAssetsToComposite(selected.has(id) ? [...selected] : [id], at);
  };

  let overlay: React.ReactNode = null;
  if (doc && primary && tool === "move" && primary.kind !== "fill" && primary.kind !== "adjustment" && primary.kind !== "effect" && primary.kind !== "group") {
    const quad = contentCorners(primary.transform).map(local);
    const top = { x: (quad[0].x + quad[1].x) / 2, y: (quad[0].y + quad[1].y) / 2 };
    const center = local({ x: primary.transform.x, y: primary.transform.y });
    const dir = { x: top.x - center.x, y: top.y - center.y };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const knob = { x: top.x + (dir.x / len) * 24, y: top.y + (dir.y / len) * 24 };
    overlay = (
      <>
        <polygon className="outline" points={quad.map((p) => `${p.x},${p.y}`).join(" ")} />
        {!primary.locked && (
          <>
            <line x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} stroke="#1a73e8" />
            <circle className="rotate" cx={knob.x} cy={knob.y} r={6} onPointerDown={rotateHandle(primary)} />
            {quad.map((p, i) => (
              <rect key={i} className="handle" x={p.x - 5} y={p.y - 5} width={10} height={10} style={{ cursor: i % 2 ? "nesw-resize" : "nwse-resize" }} onPointerDown={scaleHandle(primary, i)} />
            ))}
          </>
        )}
      </>
    );
  }
  let brushCursor: React.ReactNode = null;
  if (tool === "mask" && maskComponent?.shape.kind === "brush" && cursor && doc) {
    const r = ((b.size * Math.max(doc.width, doc.height)) / 2) * pxPerDoc;
    brushCursor = <circle cx={cursor.x - rect.left} cy={cursor.y - rect.top} r={r} fill="none" stroke="#fff" style={{ mixBlendMode: "difference" }} />;
  }

  const rulerTicks = (axis: "x" | "y") => {
    if (!doc) return null;
    const step = [10, 25, 50, 100, 250, 500, 1000, 2500].find((s) => s * pxPerDoc >= 60) ?? 5000;
    const ticks: React.ReactNode[] = [];
    const size = axis === "x" ? doc.width : doc.height;
    for (let v = 0; v <= size; v += step) {
      const p = local(axis === "x" ? { x: v, y: 0 } : { x: 0, y: v });
      ticks.push(
        <span key={v} style={{ position: "absolute", [axis === "x" ? "left" : "top"]: (axis === "x" ? p.x : p.y) - 18, [axis === "x" ? "top" : "left"]: 2 }}>
          {v}
        </span>,
      );
    }
    return ticks;
  };

  return (
    <div
      className="composite-view"
      ref={ref}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-focused-assets")) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div
        className="transform-layer"
        style={{ cursor: tool === "mask" && maskComponent?.shape.kind === "brush" ? "none" : "default" }}
        onPointerDown={onCanvasDown}
        onClick={onCanvasClick}
        onPointerMove={(e) => setCursor({ x: e.clientX, y: e.clientY })}
        onPointerLeave={() => setCursor(null)}
      >
        <svg className="transform-svg">
          {doc && showGuides &&
            doc.guides.map((g) => {
              const p = local(g.axis === "x" ? { x: g.position, y: 0 } : { x: 0, y: g.position });
              return g.axis === "x" ? (
                <line key={g.id} className="guide" x1={p.x} x2={p.x} y1={0} y2="100%" style={{ pointerEvents: "stroke", cursor: "ew-resize" }} onPointerDown={dragGuide("x", g.id)} />
              ) : (
                <line key={g.id} className="guide" y1={p.y} y2={p.y} x1={0} x2="100%" style={{ pointerEvents: "stroke", cursor: "ns-resize" }} onPointerDown={dragGuide("y", g.id)} />
              );
            })}
          {snapShown.x !== null && <line className="snap" x1={local({ x: snapShown.x, y: 0 }).x} x2={local({ x: snapShown.x, y: 0 }).x} y1={0} y2="100%" />}
          {snapShown.y !== null && <line className="snap" y1={local({ x: 0, y: snapShown.y }).y} y2={local({ x: 0, y: snapShown.y }).y} x1={0} x2="100%" />}
          {overlay}
          {brushCursor}
        </svg>
      </div>
      {doc && (
        <>
          <div className="ruler top" onPointerDown={dragGuide("y")} title="Drag down to add a horizontal guide">
            {rulerTicks("x")}
          </div>
          <div className="ruler left" onPointerDown={dragGuide("x")} title="Drag right to add a vertical guide">
            {rulerTicks("y")}
          </div>
        </>
      )}
      {doc && engine.compositeLoading && <div className="develop-status">Developing photos for the composition…</div>}
    </div>
  );
}
