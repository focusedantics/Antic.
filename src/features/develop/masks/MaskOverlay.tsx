import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { apply, outputToSource, sourceToOutput } from "@/core/develop/geometry";
import { updateComponent } from "@/core/develop/masks";
import type { BrushStroke, MaskComponent, MaskShape, StrokePoint } from "@/core/develop/recipe";
import { beginGesture, develop, editRecipe, endGesture } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { clamp } from "@/lib/math";
import { brush } from "./brush";

type Pt = { x: number; y: number };

/** Mapping between client pixels and source uv for the view as drawn. */
function mapping() {
  const engine = developEngine();
  const { assetId } = develop.getState();
  const recipe = engine.displayRecipe();
  const src = assetId ? engine.sourceFor(assetId) : null;
  if (!recipe || !src) return null;
  const toSrc = outputToSource(src.size, recipe.geometry);
  const toOut = sourceToOutput(src.size, recipe.geometry);
  const size = src.size;
  const long = Math.max(size.width, size.height);
  return {
    size,
    long,
    clientToSource(cx: number, cy: number): Pt {
      const [u, v] = engine.clientToOutput(cx, cy);
      const [x, y] = apply(toSrc, u, v);
      return { x, y };
    },
    sourceToClient(p: Pt): Pt {
      const [u, v] = apply(toOut, p.x, p.y);
      const [x, y] = engine.outputToClient(u, v);
      return { x, y };
    },
    /** Source uv offset of `length` long-side units along x or y. */
    unitX: long / size.width,
    unitY: long / size.height,
  };
}

function useFrame() {
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

function editShape(maskId: string, component: MaskComponent, label: string, shape: MaskShape) {
  editRecipe(label, (r) => updateComponent(r, maskId, component.id, (c) => ({ ...c, shape })));
}

export function MaskOverlay() {
  useFrame();
  const recipe = useStore(develop, (s) => s.recipe);
  const activeMaskId = useStore(develop, (s) => s.activeMaskId);
  const activeComponentId = useStore(develop, (s) => s.activeComponentId);
  const b = useStore(brush, (s) => s);
  const layer = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const mask = recipe?.masks.find((m) => m.id === activeMaskId) ?? null;
  const component = mask?.components.find((c) => c.id === activeComponentId) ?? mask?.components[0] ?? null;
  const map = mapping();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "[") brush.setState((s) => ({ size: Math.max(0.002, s.size / 1.15) }));
      else if (e.key === "]") brush.setState((s) => ({ size: Math.min(0.4, s.size * 1.15) }));
      else if (e.key.toLowerCase() === "o" && !e.metaKey && !e.ctrlKey) develop.setState((s) => ({ maskOverlay: !s.maskOverlay }));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!mask || !component || !map) return null;
  const shape = component.shape;
  const rect = developEngine().canvas.getBoundingClientRect();
  const local = (p: Pt) => ({ x: p.x - rect.left, y: p.y - rect.top });

  /** Tracks a drag as one history step; the gesture may already be open (brush strokes). */
  const drag = (e: ReactPointerEvent, label: string, onMove: (p: Pt, start: Pt) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const start = map.clientToSource(e.clientX, e.clientY);
    beginGesture(label);
    const move = (ev: PointerEvent) => onMove(map.clientToSource(ev.clientX, ev.clientY), start);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      endGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.nativeEvent as PointerEvent & { spaceHeld?: boolean }).spaceHeld) return;
    const p = map.clientToSource(e.clientX, e.clientY);
    switch (shape.kind) {
      case "brush": {
        const pressure = e.pointerType === "pen" ? Math.max(0.05, e.pressure) : 1;
        const stroke: BrushStroke = {
          mode: b.erase || e.altKey ? "erase" : "paint",
          size: b.size,
          feather: b.feather,
          flow: b.flow,
          density: b.density,
          points: [[p.x, p.y, pressure]],
        };
        let strokes = [...shape.strokes, stroke];
        const label = stroke.mode === "erase" ? "Erase brush" : "Brush stroke";
        beginGesture(label);
        editShape(mask.id, component, label, { kind: "brush", strokes });
        drag(e, label, (q) => {
          const last = strokes[strokes.length - 1];
          const prev = last.points[last.points.length - 1];
          // Skip points closer than a tenth of the brush radius.
          if (Math.hypot((q.x - prev[0]) / map.unitX, (q.y - prev[1]) / map.unitY) < b.size * 0.05) return;
          const point: StrokePoint = [q.x, q.y, pressure];
          strokes = [...strokes.slice(0, -1), { ...last, points: [...last.points, point] }];
          editShape(mask.id, component, label, { kind: "brush", strokes });
        });
        return;
      }
      case "linear":
        drag(e, "Linear gradient", (q, start) => editShape(mask.id, component, "Linear gradient", { kind: "linear", start, end: q }));
        return;
      case "radial":
        drag(e, "Radial gradient", (q, start) => {
          const r = Math.max(0.005, Math.hypot((q.x - start.x) / map.unitX, (q.y - start.y) / map.unitY));
          const rx = Math.max(0.005, Math.abs(q.x - start.x) / map.unitX) || r;
          const ry = Math.max(0.005, Math.abs(q.y - start.y) / map.unitY) || r;
          editShape(mask.id, component, "Radial gradient", { ...shape, center: start, radiusX: e.shiftKey ? r : rx, radiusY: e.shiftKey ? r : ry, angle: 0 });
        });
        return;
      case "color":
      case "luminance": {
        const engine = developEngine();
        const [u, v] = engine.clientToOutput(e.clientX, e.clientY);
        const c = engine.maskRenderer.sample(u, v);
        if (!c) return;
        if (shape.kind === "luminance") {
          const y = 0.2627 * c[0] + 0.678 * c[1] + 0.0593 * c[2];
          const L = y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(Math.max(y, 0), 1 / 2.4) - 0.055;
          editShape(mask.id, component, "Luminance range", { ...shape, low: clamp(L - 0.12), high: clamp(L + 0.12) });
        } else {
          const lab = rec2020ToOklab(c);
          const samples = e.shiftKey ? [...shape.samples, lab].slice(-5) : [lab];
          editShape(mask.id, component, "Color range", { ...shape, samples });
        }
        return;
      }
    }
  };

  // ─── Handles ───────────────────────────────────────────────────────────
  let handles: React.ReactNode = null;
  if (shape.kind === "linear") {
    const a = local(map.sourceToClient(shape.start));
    const z = local(map.sourceToClient(shape.end));
    const dx = z.x - a.x;
    const dy = z.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 2000;
    const ny = (dx / len) * 2000;
    const moveBoth = (e: ReactPointerEvent) =>
      drag(e, "Move gradient", (q, start) => {
        const d = { x: q.x - start.x, y: q.y - start.y };
        editShape(mask.id, component, "Move gradient", { ...shape, start: { x: shape.start.x + d.x, y: shape.start.y + d.y }, end: { x: shape.end.x + d.x, y: shape.end.y + d.y } });
      });
    handles = (
      <>
        <line x1={a.x - nx} y1={a.y - ny} x2={a.x + nx} y2={a.y + ny} stroke="#fff" strokeWidth={1} />
        <line x1={z.x - nx} y1={z.y - ny} x2={z.x + nx} y2={z.y + ny} stroke="#fff" strokeWidth={1} strokeDasharray="6 4" />
        <line x1={a.x} y1={a.y} x2={z.x} y2={z.y} stroke="#fff8" />
        <circle cx={(a.x + z.x) / 2} cy={(a.y + z.y) / 2} r={7} className="mask-pin" onPointerDown={moveBoth} />
        <circle cx={a.x} cy={a.y} r={6} className="mask-handle" onPointerDown={(e) => drag(e, "Linear gradient", (q) => editShape(mask.id, component, "Linear gradient", { ...shape, start: q }))} />
        <circle cx={z.x} cy={z.y} r={6} className="mask-handle" onPointerDown={(e) => drag(e, "Linear gradient", (q) => editShape(mask.id, component, "Linear gradient", { ...shape, end: q }))} />
      </>
    );
  } else if (shape.kind === "radial") {
    const ring = (scale: number) =>
      Array.from({ length: 73 }, (_, i) => {
        const t = (i / 72) * Math.PI * 2;
        const ex = Math.cos(t) * shape.radiusX * scale;
        const ey = Math.sin(t) * shape.radiusY * scale;
        const x = shape.center.x + (ex * Math.cos(shape.angle) - ey * Math.sin(shape.angle)) * map.unitX;
        const y = shape.center.y + (ex * Math.sin(shape.angle) + ey * Math.cos(shape.angle)) * map.unitY;
        const p = local(map.sourceToClient({ x, y }));
        return `${p.x},${p.y}`;
      }).join(" ");
    const c = local(map.sourceToClient(shape.center));
    const axis = (ax: number, ay: number) => {
      const x = shape.center.x + (ax * Math.cos(shape.angle) - ay * Math.sin(shape.angle)) * map.unitX;
      const y = shape.center.y + (ax * Math.sin(shape.angle) + ay * Math.cos(shape.angle)) * map.unitY;
      return local(map.sourceToClient({ x, y }));
    };
    const hx = axis(shape.radiusX, 0);
    const hy = axis(0, -shape.radiusY);
    const radius = (e: ReactPointerEvent, which: "x" | "y") =>
      drag(e, "Radial gradient", (q) => {
        const dx = (q.x - shape.center.x) / map.unitX;
        const dy = (q.y - shape.center.y) / map.unitY;
        const along = which === "x" ? dx * Math.cos(shape.angle) + dy * Math.sin(shape.angle) : -dx * Math.sin(shape.angle) + dy * Math.cos(shape.angle);
        const r = Math.max(0.005, Math.abs(along));
        editShape(mask.id, component, "Radial gradient", which === "x" ? { ...shape, radiusX: r } : { ...shape, radiusY: r });
      });
    handles = (
      <>
        <polyline points={ring(1)} fill="none" stroke="#fff" strokeWidth={1} />
        <polyline points={ring(1 - shape.feather / 100)} fill="none" stroke="#fff8" strokeDasharray="4 4" />
        <circle
          cx={c.x}
          cy={c.y}
          r={7}
          className="mask-pin"
          onPointerDown={(e) =>
            drag(e, "Move gradient", (q, start) =>
              editShape(mask.id, component, "Move gradient", { ...shape, center: { x: shape.center.x + q.x - start.x, y: shape.center.y + q.y - start.y } }),
            )
          }
        />
        <circle cx={hx.x} cy={hx.y} r={6} className="mask-handle" onPointerDown={(e) => radius(e, "x")} />
        <circle cx={hy.x} cy={hy.y} r={6} className="mask-handle" onPointerDown={(e) => radius(e, "y")} />
      </>
    );
  }

  let brushCursor: React.ReactNode = null;
  if (shape.kind === "brush" && cursor) {
    const center = local(cursor);
    const p = map.clientToSource(cursor.x, cursor.y);
    const edge = local(map.sourceToClient({ x: p.x + (b.size / 2) * map.unitX, y: p.y }));
    const r = Math.hypot(edge.x - center.x, edge.y - center.y);
    brushCursor = (
      <>
        <circle cx={center.x} cy={center.y} r={r} fill="none" stroke="#fff" strokeWidth={1} style={{ mixBlendMode: "difference" }} />
        <circle cx={center.x} cy={center.y} r={r * (1 - b.feather)} fill="none" stroke="#fff8" strokeDasharray="3 3" />
        <text x={center.x} y={center.y + 4} fill="#fff" fontSize={12} textAnchor="middle">
          {b.erase ? "−" : "+"}
        </text>
      </>
    );
  }

  return (
    <div
      ref={layer}
      className="mask-layer"
      style={{ cursor: shape.kind === "brush" ? "none" : "crosshair" }}
      onPointerDown={onDown}
      onPointerMove={(e) => setCursor({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => setCursor(null)}
    >
      <svg className="mask-svg" width="100%" height="100%">
        {handles}
        {brushCursor}
      </svg>
    </div>
  );
}

/** Linear Rec.2020 → Oklab (matches the shader's toOklab on REC2020_TO_SRGB * c). */
function rec2020ToOklab([r2, g2, b2]: [number, number, number]): [number, number, number] {
  const r = 1.6605 * r2 - 0.5876 * g2 - 0.0728 * b2;
  const g = -0.1246 * r2 + 1.1329 * g2 - 0.0083 * b2;
  const b = -0.0182 * r2 - 0.1006 * g2 + 1.1187 * b2;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
