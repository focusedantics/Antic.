import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { ColorField } from "@/features/color/ColorField";
import type { PathNode, SubPath } from "@/core/document/model";
import { canvasToPathPoint, insertLayer, locate, pathFromCanvas, pathPointToCanvas, refitPath, toEditablePath, updateLayer } from "@/core/document/operations";
import { beginDocGesture, composite, editDocument, endDocGesture } from "@/core/document/session";
import type { Point } from "@/lib/math";
import { createStore } from "zustand/vanilla";
import { paint, releaseFocus } from "./state";

/** The path being drawn with the pen (canvas px), so the options bar can finish it too. */
const draft = createStore<{ nodes: PathNode[] }>(() => ({ nodes: [] }));
const setNodes = (next: PathNode[] | ((n: PathNode[]) => PathNode[])) => draft.setState((s) => ({ nodes: typeof next === "function" ? next(s.nodes) : next }));

/** Ends the pen's path: a closed shape (filled) or an open line (stroked) becomes a path layer. */
export function finishPen(closed: boolean) {
  const list = draft.getState().nodes;
  const { doc, selection } = composite.getState();
  setNodes([]);
  if (!doc || list.length < 2) return;
  const { color, size } = paint.getState();
  const layer = pathFromCanvas(doc, list, closed, closed ? { fill: color, stroke: null, strokeWidth: 0 } : { fill: null, stroke: color, strokeWidth: Math.max(1, size) });
  editDocument(closed ? "Draw shape" : "Draw path", (d) => insertLayer(d, layer, selection.at(-1)));
  composite.setState({ selection: [layer.id] });
}

type Mapping = { toDoc: (clientX: number, clientY: number) => Point; local: (p: Point) => Point };

/** Screen distance (px) within which a click lands on a point. */
const NEAR = 10;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** SVG path data for nodes already mapped to screen px. */
function svgPath(sub: { closed: boolean; nodes: readonly PathNode[] }): string {
  const n = sub.nodes;
  if (!n.length) return "";
  let d = `M${n[0].x} ${n[0].y}`;
  const count = sub.closed ? n.length : n.length - 1;
  for (let i = 0; i < count; i++) {
    const a = n[i];
    const b = n[(i + 1) % n.length];
    d += a.out || b.in ? `C${(a.out ?? a).x} ${(a.out ?? a).y} ${(b.in ?? b).x} ${(b.in ?? b).y} ${b.x} ${b.y}` : `L${b.x} ${b.y}`;
  }
  return sub.closed ? `${d}Z` : d;
}

const mapNode = (n: PathNode, f: (p: Point) => Point): PathNode => ({ ...f(n), ...(n.in ? { in: f(n.in) } : {}), ...(n.out ? { out: f(n.out) } : {}) });

/**
 * The pen: click for corners, drag for curves, click the first point to close the shape;
 * Enter or a double click finishes an open path, Escape cancels, Backspace undoes a point.
 */
export function PenOverlay({ toDoc, local, onDone }: Mapping & { onDone: () => void }) {
  const nodes = useStore(draft, (s) => s.nodes);
  const [hover, setHover] = useState<Point | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const finish = finishPen;
  // Leaving the pen drops an unfinished path.
  useEffect(() => () => setNodes([]), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (nodesRef.current.length) setNodes([]);
        else onDone();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (!nodesRef.current.length) return;
        e.preventDefault();
        e.stopPropagation();
        setNodes((n) => n.slice(0, -1));
      }
    };
    // Capture: before the workspace's keys (Delete would remove the selected layer).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    releaseFocus();
    const p = toDoc(e.clientX, e.clientY);
    const list = nodesRef.current;
    if (list.length >= 2 && dist(local(p), local(list[0])) < NEAR) return finish(true);
    // A double click ends an open path (its second click is not a new point).
    if (e.detail >= 2 && list.length >= 2) return finish(false);
    const index = list.length;
    setNodes([...list, { x: p.x, y: p.y }]);
    const move = (ev: PointerEvent) => {
      const q = toDoc(ev.clientX, ev.clientY);
      // Dragging pulls out symmetric handles: a smooth point.
      if (dist(local(q), local(p)) < 3) return;
      setNodes((n) => n.map((node, i) => (i === index ? { x: p.x, y: p.y, out: q, in: { x: 2 * p.x - q.x, y: 2 * p.y - q.y } } : node)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const screen = nodes.map((n) => mapNode(n, local));
  const last = screen[screen.length - 1];
  const preview = hover && last ? svgPath({ closed: false, nodes: [{ ...last, in: undefined }, { ...local(hover) }] }) : "";
  const closing = hover && screen.length >= 2 && dist(local(hover), screen[0]) < NEAR;
  return (
    <div className="tool-overlay" data-tool="pen" style={{ cursor: "crosshair" }} onPointerDown={onPointerDown} onPointerMove={(e) => setHover(toDoc(e.clientX, e.clientY))} onPointerLeave={() => setHover(null)}>
      <svg className="transform-svg">
        {screen.length > 0 && <path className="pen-path" d={svgPath({ closed: false, nodes: screen })} />}
        {preview && <path className="pen-preview" d={preview} />}
        {screen.map((n, i) => (
          <g key={i}>
            {n.in && <line className="pen-handle" x1={n.x} y1={n.y} x2={n.in.x} y2={n.in.y} />}
            {n.out && <line className="pen-handle" x1={n.x} y1={n.y} x2={n.out.x} y2={n.out.y} />}
            {n.out && <circle className="pen-knob" cx={n.out.x} cy={n.out.y} r={3.5} />}
            <rect className="pen-anchor" data-first={i === 0 && closing ? "close" : undefined} x={n.x - 4} y={n.y - 4} width={8} height={8} />
          </g>
        ))}
      </svg>
    </div>
  );
}

type Grab = { sub: number; node: number; part: "anchor" | "in" | "out" };

/** Nearest point on any segment of the paths (screen px) to `p`: where to insert a node. */
function nearestOnPaths(paths: readonly SubPath[], p: Point): { sub: number; seg: number; t: number; d: number } | null {
  let best: { sub: number; seg: number; t: number; d: number } | null = null;
  paths.forEach((sub, si) => {
    const n = sub.nodes;
    const count = sub.closed ? n.length : n.length - 1;
    for (let i = 0; i < count; i++) {
      const a = n[i];
      const b = n[(i + 1) % n.length];
      const c1 = a.out ?? a;
      const c2 = b.in ?? b;
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const u = 1 - t;
        const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x;
        const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
        const d = Math.hypot(x - p.x, y - p.y);
        if (!best || d < best.d) best = { sub: si, seg: i, t, d };
      }
    }
  });
  return best;
}

/** Splits segment `seg` of a subpath at `t` (de Casteljau), adding a smooth node there. */
export function splitSegment(sub: SubPath, seg: number, t: number): SubPath {
  const n = sub.nodes;
  const a = n[seg];
  const b = n[(seg + 1) % n.length];
  const lerp = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  if (!a.out && !b.in) {
    const mid = lerp(a, b);
    return { ...sub, nodes: [...n.slice(0, seg + 1), mid, ...n.slice(seg + 1)] };
  }
  const p1 = a.out ?? a;
  const p2 = b.in ?? b;
  const q0 = lerp(a, p1);
  const q1 = lerp(p1, p2);
  const q2 = lerp(p2, b);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  const nodes = n.slice();
  nodes[seg] = { ...a, out: q0 };
  const nextIndex = (seg + 1) % n.length;
  nodes[nextIndex] = { ...b, in: q2 };
  nodes.splice(seg + 1, 0, { x: m.x, y: m.y, in: r0, out: r1 });
  return { ...sub, nodes };
}

/**
 * Node editing on the selected path: drag points and handles (a smooth point keeps its
 * handles in line; Alt breaks them), double-click a point to make it sharp or smooth,
 * double-click the outline to add a point, Delete removes the selected point.
 */
export function NodesOverlay({ toDoc, local, onDone }: Mapping & { onDone: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  const [picked, setPicked] = useState<{ sub: number; node: number } | null>(null);
  const found = doc && selection.length ? locate(doc.layers, selection[selection.length - 1])?.layer : null;
  const layer = found?.kind === "path" ? found : null;

  useEffect(() => {
    if (!layer) onDone();
  }, [layer, onDone]);

  // Delete removes the picked point (capture: before the workspace deletes the layer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === "Delete" || e.key === "Backspace") && picked && layer) {
        e.preventDefault();
        e.stopPropagation();
        editDocument("Delete point", (d) =>
          updateLayer(d, layer.id, (l) => {
            if (l.kind !== "path") return l;
            const paths = l.paths.map((s, i) => (i === picked.sub ? { ...s, nodes: s.nodes.filter((_, k) => k !== picked.node) } : s)).filter((s) => s.nodes.length >= 2);
            return paths.length ? refitPath({ ...l, paths }) : l;
          }),
        );
        setPicked(null);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!layer) return null;
  const editable = layer.shape ? toEditablePath(layer) : layer;
  const toScreen = (p: Point) => local(pathPointToCanvas(editable, p));
  const screen = editable.paths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => mapNode(n, toScreen)) }));

  /** Rewrites one node through the drag (in unit coordinates of the layer as it was). */
  const drag = (e: ReactPointerEvent, grab: Grab) => {
    e.preventDefault();
    e.stopPropagation();
    releaseFocus();
    setPicked({ sub: grab.sub, node: grab.node });
    const start = editable;
    const original = start.paths[grab.sub].nodes[grab.node];
    const from = canvasToPathPoint(start, toDoc(e.clientX, e.clientY));
    beginDocGesture(grab.part === "anchor" ? "Move point" : "Move handle");
    let moved = false;
    const move = (ev: PointerEvent) => {
      const q = canvasToPathPoint(start, toDoc(ev.clientX, ev.clientY));
      const dx = q.x - from.x;
      const dy = q.y - from.y;
      moved = true;
      let next: PathNode;
      if (grab.part === "anchor") {
        const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
        next = mapNode(original, shift);
      } else {
        const handle = { x: (original[grab.part] ?? original).x + dx, y: (original[grab.part] ?? original).y + dy };
        const other = grab.part === "in" ? "out" : "in";
        const opposite = original[other];
        next = { ...original, [grab.part]: handle };
        if (opposite && !ev.altKey) {
          // Keep a smooth point smooth: the other handle turns with this one, keeping its length.
          const len = Math.hypot(opposite.x - original.x, opposite.y - original.y);
          const hx = handle.x - original.x;
          const hy = handle.y - original.y;
          const hl = Math.hypot(hx, hy) || 1;
          next = { ...next, [other]: { x: original.x - (hx / hl) * len, y: original.y - (hy / hl) * len } };
        }
      }
      editDocument("Edit path", (d) =>
        updateLayer(d, layer.id, (l) => (l.kind === "path" ? { ...start, id: l.id, paths: start.paths.map((s, i) => (i === grab.sub ? { ...s, nodes: s.nodes.map((n, k) => (k === grab.node ? next : n)) } : s)) } : l)),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Fit the box to the new outline (points may have left it).
      if (moved) editDocument("Edit path", (d) => updateLayer(d, layer.id, (l) => (l.kind === "path" ? refitPath(l) : l)));
      endDocGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleSmooth = (sub: number, node: number) => {
    editDocument("Sharp or smooth point", (d) =>
      updateLayer(d, layer.id, (l) => {
        if (l.kind !== "path") return l;
        const base = l.shape ? toEditablePath(l) : l;
        const paths = base.paths.map((s, i) => {
          if (i !== sub) return s;
          const n = s.nodes;
          const p = n[node];
          if (p.in || p.out) return { ...s, nodes: n.map((x, k) => (k === node ? { x: p.x, y: p.y } : x)) };
          // Smooth: handles along the line through its neighbours, a third of the way to each.
          const prev = n[(node - 1 + n.length) % n.length];
          const next = n[(node + 1) % n.length];
          const dx = (next.x - prev.x) / 6;
          const dy = (next.y - prev.y) / 6;
          return { ...s, nodes: n.map((x, k) => (k === node ? { x: p.x, y: p.y, in: { x: p.x - dx, y: p.y - dy }, out: { x: p.x + dx, y: p.y + dy } } : x)) };
        });
        return refitPath({ ...base, paths });
      }),
    );
  };

  const insert = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    const hit = nearestOnPaths(screen, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!hit || hit.d > NEAR * 1.5) return;
    editDocument("Add point", (d) =>
      updateLayer(d, layer.id, (l) => {
        if (l.kind !== "path") return l;
        const base = l.shape ? toEditablePath(l) : l;
        return { ...base, paths: base.paths.map((s, i) => (i === hit.sub ? splitSegment(s, hit.seg, hit.t) : s)) };
      }),
    );
    setPicked({ sub: hit.sub, node: hit.seg + 1 });
  };

  return (
    <div className="tool-overlay" data-tool="nodes" onPointerDown={(e) => e.target === e.currentTarget && setPicked(null)}>
      <svg className="transform-svg">
        {screen.map((s, si) => (
          <g key={si}>
            <path className="node-outline" d={svgPath(s)} />
            <path className="node-hit" d={svgPath(s)} onDoubleClick={insert} />
          </g>
        ))}
        {screen.map((s, si) =>
          s.nodes.map((n, ni) => {
            const on = picked?.sub === si && picked.node === ni;
            return (
              <g key={`${si}-${ni}`}>
                {on && n.in && <line className="pen-handle" x1={n.x} y1={n.y} x2={n.in.x} y2={n.in.y} />}
                {on && n.out && <line className="pen-handle" x1={n.x} y1={n.y} x2={n.out.x} y2={n.out.y} />}
                {on && n.in && <circle className="pen-knob" cx={n.in.x} cy={n.in.y} r={5} onPointerDown={(e) => drag(e, { sub: si, node: ni, part: "in" })} />}
                {on && n.out && <circle className="pen-knob" cx={n.out.x} cy={n.out.y} r={5} onPointerDown={(e) => drag(e, { sub: si, node: ni, part: "out" })} />}
                <rect
                  className="pen-anchor"
                  data-picked={on || undefined}
                  x={n.x - 5}
                  y={n.y - 5}
                  width={10}
                  height={10}
                  onPointerDown={(e) => drag(e, { sub: si, node: ni, part: "anchor" })}
                  onDoubleClick={() => toggleSmooth(si, ni)}
                />
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}

/** The pen's and the point tool's options, above the canvas. */
export function PenOptions({ tool, onDone }: { tool: "pen" | "nodes"; onDone: () => void }) {
  const s = useStore(paint, (x) => x);
  const drawing = useStore(draft, (d) => d.nodes.length);
  return (
    <div className="tool-options" role="toolbar" aria-label={tool === "pen" ? "Pen options" : "Point options"}>
      {tool === "pen" ? (
        <>
          <ColorField label="Pen colour" value={s.color} onChange={(c) => paint.setState({ color: c })} />
          <label className="tool-range">
            <span>Line</span>
            <input type="range" min={1} max={100} value={Math.min(100, Math.round(s.size))} aria-label="Line width" onChange={(e) => paint.setState({ size: Number(e.target.value) })} />
            <output>{Math.round(s.size)}px</output>
          </label>
          <span className="tool-hint" title="Click for corners, drag for curves. Click the first point to close a shape; Enter or double-click ends a line; Backspace removes the last point.">
            Click: corner · drag: curve
          </span>
          <button type="button" className="btn small" disabled={drawing < 2} onClick={() => finishPen(false)}>
            End line
          </button>
          <button type="button" className="btn small" disabled={drawing < 3} onClick={() => finishPen(true)}>
            Close shape
          </button>
        </>
      ) : (
        <span className="tool-hint" title="Drag points and handles (Alt moves one handle alone). Double-click a point to make it sharp or smooth, double-click the outline to add a point; Delete removes the selected point.">
          Drag points · double-click to add or smooth
        </span>
      )}
      <button
        type="button"
        className="btn small primary"
        onClick={() => {
          // Done keeps a path in progress (as an open line).
          if (tool === "pen" && drawing >= 2) finishPen(false);
          onDone();
        }}
      >
        Done
      </button>
    </div>
  );
}
