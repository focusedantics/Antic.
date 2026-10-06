import type { Point } from "@/lib/math";
import type { PathNode, SmartShape, SmartShapeKind, SubPath } from "./model";

/**
 * Smart shapes and vector path helpers. Shapes are built in a space `aspect` wide and
 * 1 tall (the layer box's proportions, so rounded corners stay round and stars stay
 * regular), then mapped to the unit box the path layer stores.
 */

export const SMART_SHAPES: readonly { kind: SmartShapeKind; label: string; points?: [number, number]; ratio?: string; defaults: Omit<SmartShape, "kind"> }[] = [
  { kind: "rectangle", label: "Rectangle", defaults: { points: 4, ratio: 0.5, round: 0 } },
  { kind: "ellipse", label: "Ellipse", defaults: { points: 4, ratio: 0.5, round: 0 } },
  { kind: "polygon", label: "Polygon", points: [3, 12], defaults: { points: 3, ratio: 0.5, round: 0 } },
  { kind: "star", label: "Star", points: [3, 24], ratio: "Inner radius", defaults: { points: 5, ratio: 0.45, round: 0 } },
  { kind: "burst", label: "Burst", points: [8, 48], ratio: "Inner radius", defaults: { points: 18, ratio: 0.78, round: 0 } },
  { kind: "heart", label: "Heart", defaults: { points: 4, ratio: 0.5, round: 0 } },
  { kind: "arrow", label: "Arrow", ratio: "Shaft", defaults: { points: 4, ratio: 0.42, round: 0 } },
  { kind: "double-arrow", label: "Double arrow", ratio: "Shaft", defaults: { points: 4, ratio: 0.42, round: 0 } },
  { kind: "chevron", label: "Chevron", ratio: "Notch", defaults: { points: 4, ratio: 0.5, round: 0 } },
  { kind: "speech", label: "Speech bubble", ratio: "Tail position", defaults: { points: 4, ratio: 0.3, round: 0.35 } },
  { kind: "ring", label: "Ring", ratio: "Hole", defaults: { points: 4, ratio: 0.6, round: 0 } },
  { kind: "cross", label: "Cross", ratio: "Bar", defaults: { points: 4, ratio: 0.34, round: 0 } },
  { kind: "crescent", label: "Crescent", ratio: "Bite", defaults: { points: 4, ratio: 0.45, round: 0 } },
  { kind: "teardrop", label: "Teardrop", defaults: { points: 4, ratio: 0.5, round: 0 } },
  { kind: "cloud", label: "Cloud", points: [5, 14], ratio: "Puffiness", defaults: { points: 8, ratio: 0.5, round: 0 } },
  { kind: "line", label: "Line", defaults: { points: 2, ratio: 0.5, round: 0 } },
];

export const smartShape = (kind: SmartShapeKind): SmartShape => ({ kind, ...SMART_SHAPES.find((s) => s.kind === kind)!.defaults });

/** Bézier handle length for a quarter circle, as a share of the radius. */
const KAPPA = 0.5522847498;

type Corner = { x: number; y: number; /** rounding multiplier */ r?: number };

/** A closed polygon with corners rounded by up to `radius` (each limited to half its shorter edge). */
function roundPolygon(points: readonly Corner[], radius: number): SubPath {
  const n = points.length;
  const nodes: PathNode[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a = points[(i + n - 1) % n];
    const b = points[(i + 1) % n];
    const la = Math.hypot(a.x - p.x, a.y - p.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    const cut = Math.min(radius * (p.r ?? 1), la / 2, lb / 2);
    if (cut < 1e-6 || la < 1e-9 || lb < 1e-9) {
      nodes.push({ x: p.x, y: p.y });
      continue;
    }
    const p1 = { x: p.x + ((a.x - p.x) / la) * cut, y: p.y + ((a.y - p.y) / la) * cut };
    const p2 = { x: p.x + ((b.x - p.x) / lb) * cut, y: p.y + ((b.y - p.y) / lb) * cut };
    nodes.push({ ...p1, out: { x: p1.x + (p.x - p1.x) * KAPPA, y: p1.y + (p.y - p1.y) * KAPPA } });
    nodes.push({ ...p2, in: { x: p2.x + (p.x - p2.x) * KAPPA, y: p2.y + (p.y - p2.y) * KAPPA } });
  }
  return { closed: true, nodes };
}

/** An elliptical arc as cubic Béziers (≤ 90° each), from angle a0 to a1 (radians, either way round). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): PathNode[] {
  const segments = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (a: number) => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  const nodes: PathNode[] = [at(a0)];
  for (let i = 0; i < segments; i++) {
    const s = a0 + step * i;
    const e = s + step;
    const p0 = at(s);
    const p1 = at(e);
    nodes[nodes.length - 1] = { ...nodes[nodes.length - 1], out: { x: p0.x - k * rx * Math.sin(s), y: p0.y + k * ry * Math.cos(s) } };
    nodes.push({ ...p1, in: { x: p1.x + k * rx * Math.sin(e), y: p1.y - k * ry * Math.cos(e) } });
  }
  return nodes;
}

const ellipse = (cx: number, cy: number, rx: number, ry: number, reverse = false): SubPath => {
  const nodes = reverse ? arc(cx, cy, rx, ry, 0, -Math.PI * 2) : arc(cx, cy, rx, ry, 0, Math.PI * 2);
  // The last node repeats the first: carry its incoming handle to the first and drop it.
  const last = nodes.pop()!;
  nodes[0] = { ...nodes[0], in: last.in };
  return { closed: true, nodes };
};

/** Points of a regular shape around the center, starting at the top. */
const around = (count: number, radius: (i: number) => number): Corner[] =>
  Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (i / count) * Math.PI * 2;
    return { x: Math.cos(a) * radius(i), y: Math.sin(a) * radius(i) };
  });

/** Points sampled along the paths (anchors and curves), for bounds. */
function samples(paths: readonly SubPath[]): Point[] {
  const out: Point[] = [];
  for (const p of paths) {
    const n = p.nodes.length;
    for (let i = 0; i < n; i++) {
      const a = p.nodes[i];
      out.push(a);
      if (!p.closed && i === n - 1) break;
      const b = p.nodes[(i + 1) % n];
      if (!a.out && !b.in) continue;
      const c1 = a.out ?? a;
      const c2 = b.in ?? b;
      for (let t = 0.125; t < 1; t += 0.125) {
        const u = 1 - t;
        out.push({ x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y });
      }
    }
  }
  return out;
}

export function pathBounds(paths: readonly SubPath[]) {
  const pts = samples(paths);
  if (!pts.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Applies `f` to every anchor and handle. */
export function mapPaths(paths: readonly SubPath[], f: (p: Point) => Point): SubPath[] {
  return paths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...f(n), ...(n.in ? { in: f(n.in) } : {}), ...(n.out ? { out: f(n.out) } : {}) })) }));
}

/** Scales paths to fill the unit box. */
export function fitUnit(paths: readonly SubPath[]): SubPath[] {
  const b = pathBounds(paths);
  const sx = b.width > 1e-9 ? 1 / b.width : 1;
  const sy = b.height > 1e-9 ? 1 / b.height : 1;
  return mapPaths(paths, (p) => ({ x: b.width > 1e-9 ? (p.x - b.x) * sx : 0.5, y: b.height > 1e-9 ? (p.y - b.y) * sy : 0.5 }));
}

/**
 * The shape's paths in the unit box for a box of proportions `aspect` (width / height).
 * Shapes that keep their proportions (stars, polygons, hearts) still stretch to fill the
 * box, as a designer drags them.
 */
export function shapePaths(shape: SmartShape, aspect = 1): SubPath[] {
  const W = Math.max(0.01, aspect);
  const H = 1;
  const short = Math.min(W, H);
  const radius = Math.max(0, Math.min(1, shape.round)) * 0.5 * short;
  const ratio = Math.max(0.02, Math.min(0.98, shape.ratio));
  const unit = (paths: SubPath[]) => mapPaths(paths, (p) => ({ x: p.x / W, y: p.y / H }));
  switch (shape.kind) {
    case "rectangle":
      return unit([roundPolygon([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], radius)]);
    case "ellipse":
      return [ellipse(0.5, 0.5, 0.5, 0.5)];
    case "polygon": {
      const n = Math.round(Math.max(3, Math.min(12, shape.points)));
      return fitUnit([roundPolygon(around(n, () => 1), radius ? shape.round * 0.5 : 0)]);
    }
    case "star":
    case "burst": {
      const n = Math.round(Math.max(3, Math.min(48, shape.points)));
      return fitUnit([roundPolygon(around(n * 2, (i) => (i % 2 ? ratio : 1)), shape.round * 0.25)]);
    }
    case "heart":
      return [
        {
          closed: true,
          nodes: [
            { x: 0.5, y: 1, in: { x: 0.8, y: 0.76 }, out: { x: 0.2, y: 0.76 } },
            { x: 0, y: 0.31, in: { x: 0, y: 0.54 }, out: { x: 0, y: 0.12 } },
            { x: 0.28, y: 0, in: { x: 0.13, y: 0 }, out: { x: 0.4, y: 0 } },
            { x: 0.5, y: 0.17, in: { x: 0.47, y: 0.07 }, out: { x: 0.53, y: 0.07 } },
            { x: 0.72, y: 0, in: { x: 0.6, y: 0 }, out: { x: 0.87, y: 0 } },
            { x: 1, y: 0.31, in: { x: 1, y: 0.12 }, out: { x: 1, y: 0.54 } },
          ],
        },
      ];
    case "arrow":
    case "double-arrow": {
      const t = ratio / 2;
      const head = Math.min(W * (shape.kind === "arrow" ? 0.5 : 0.35), 0.6);
      const right: Corner[] = [
        { x: W - head, y: 0.5 - t },
        { x: W - head, y: 0 },
        { x: W, y: 0.5, r: 0.3 },
        { x: W - head, y: 1 },
        { x: W - head, y: 0.5 + t },
      ];
      const left: Corner[] =
        shape.kind === "arrow"
          ? [
              { x: 0, y: 0.5 + t },
              { x: 0, y: 0.5 - t },
            ]
          : [
              { x: head, y: 0.5 + t },
              { x: head, y: 1 },
              { x: 0, y: 0.5, r: 0.3 },
              { x: head, y: 0 },
              { x: head, y: 0.5 - t },
            ];
      return unit([roundPolygon([...right, ...left], radius)]);
    }
    case "chevron": {
      const d = Math.min(W * 0.45, 0.5) * (0.4 + ratio * 1.2);
      return unit([roundPolygon([{ x: 0, y: 0 }, { x: W - d, y: 0 }, { x: W, y: 0.5 }, { x: W - d, y: 1 }, { x: 0, y: 1 }, { x: d, y: 0.5 }], radius)]);
    }
    case "speech": {
      const b = 0.78;
      const tail = Math.min(0.22 * W, 0.3);
      const tx = Math.max(0.04 * W, Math.min(W - tail - 0.04 * W, ratio * W));
      const r = Math.min(radius * 1.6, b / 2);
      return unit([
        roundPolygon(
          [
            { x: 0, y: 0 },
            { x: W, y: 0 },
            { x: W, y: b },
            { x: tx + tail, y: b, r: 0 },
            { x: tx + tail * 0.1, y: H, r: 0.08 },
            { x: tx, y: b, r: 0 },
            { x: 0, y: b },
          ],
          r,
        ),
      ]);
    }
    case "ring":
      return [ellipse(0.5, 0.5, 0.5, 0.5), ellipse(0.5, 0.5, 0.5 * ratio, 0.5 * ratio, true)];
    case "cross": {
      const tw = (ratio * short) / 2;
      const cx = W / 2;
      const cy = H / 2;
      return unit([
        roundPolygon(
          [
            { x: cx - tw, y: 0 },
            { x: cx + tw, y: 0 },
            { x: cx + tw, y: cy - tw },
            { x: W, y: cy - tw },
            { x: W, y: cy + tw },
            { x: cx + tw, y: cy + tw },
            { x: cx + tw, y: H },
            { x: cx - tw, y: H },
            { x: cx - tw, y: cy + tw },
            { x: 0, y: cy + tw },
            { x: 0, y: cy - tw },
            { x: cx - tw, y: cy - tw },
          ],
          radius,
        ),
      ]);
    }
    case "crescent": {
      // Unit circles: the outer one at 0 and a bite of the same size moved right by d.
      const d = 0.25 + ratio * 1.2;
      const half = Math.acos(d / 2);
      const outer = arc(0, 0, 1, 1, half, Math.PI * 2 - half);
      const inner = arc(d, 0, 1, 1, Math.PI + half, Math.PI - half);
      // The inner arc starts where the outer ends: merge those two nodes into a corner.
      const end = outer.pop()!;
      const nodes = [...outer, { x: end.x, y: end.y, in: end.in, out: inner[0].out }, ...inner.slice(1)];
      const last = nodes.pop()!;
      nodes[0] = { ...nodes[0], in: last.in };
      return fitUnit([{ closed: true, nodes }]);
    }
    case "teardrop":
      return [
        {
          closed: true,
          nodes: [
            { x: 0.5, y: 0, in: { x: 0.32, y: 0.24 }, out: { x: 0.68, y: 0.24 } },
            { x: 1, y: 0.64, in: { x: 1, y: 0.43 }, out: { x: 1, y: 0.84 } },
            { x: 0.5, y: 1, in: { x: 0.78, y: 1 }, out: { x: 0.22, y: 1 } },
            { x: 0, y: 0.64, in: { x: 0, y: 0.84 }, out: { x: 0, y: 0.43 } },
          ],
        },
      ];
    case "cloud": {
      const n = Math.round(Math.max(5, Math.min(14, shape.points)));
      const pts = around(n, () => 1).map((p) => ({ x: p.x, y: p.y * 0.62 }));
      const bulge = 0.35 + ratio * 0.9;
      const nodes: PathNode[] = pts.map((p) => ({ x: p.x, y: p.y }));
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        // Outward normal (the points go clockwise on screen, y down).
        const nx = (b.y - a.y) / len;
        const ny = -(b.x - a.x) / len;
        // A puff: a quadratic bulge through q, as a cubic, pushed a little rounder.
        const q = { x: mx + nx * len * bulge, y: my + ny * len * bulge };
        const k = (2 / 3) * 1.3;
        nodes[i] = { ...nodes[i], out: { x: a.x + (q.x - a.x) * k, y: a.y + (q.y - a.y) * k } };
        const j = (i + 1) % n;
        nodes[j] = { ...nodes[j], in: { x: b.x + (q.x - b.x) * k, y: b.y + (q.y - b.y) * k } };
      }
      return fitUnit([{ closed: true, nodes }]);
    }
    case "line":
      return [{ closed: false, nodes: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }];
  }
}

/** Traces paths in the unit box onto a canvas path scaled to `w × h`, inset by `inset` px. */
export function tracePaths(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | Path2D, paths: readonly SubPath[], w: number, h: number, inset = 0) {
  const sx = Math.max(0, w - 2 * inset);
  const sy = Math.max(0, h - 2 * inset);
  const X = (p: Point) => inset + p.x * sx;
  const Y = (p: Point) => inset + p.y * sy;
  for (const sub of paths) {
    const nodes = sub.nodes;
    if (!nodes.length) continue;
    ctx.moveTo(X(nodes[0]), Y(nodes[0]));
    const count = sub.closed ? nodes.length : nodes.length - 1;
    for (let i = 0; i < count; i++) {
      const a = nodes[i];
      const b = nodes[(i + 1) % nodes.length];
      if (a.out || b.in) {
        const c1 = a.out ?? a;
        const c2 = b.in ?? b;
        ctx.bezierCurveTo(X(c1), Y(c1), X(c2), Y(c2), X(b), Y(b));
      } else ctx.lineTo(X(b), Y(b));
    }
    if (sub.closed) ctx.closePath();
  }
}

/** SVG path data for paths in the unit box scaled to `w × h`. */
export function pathData(paths: readonly SubPath[], w: number, h: number, inset = 0): string {
  const parts: string[] = [];
  const f = (v: number) => String(Math.round(v * 100) / 100);
  const sx = Math.max(0, w - 2 * inset);
  const sy = Math.max(0, h - 2 * inset);
  const P = (p: Point) => `${f(inset + p.x * sx)} ${f(inset + p.y * sy)}`;
  for (const sub of paths) {
    const nodes = sub.nodes;
    if (!nodes.length) continue;
    parts.push(`M${P(nodes[0])}`);
    const count = sub.closed ? nodes.length : nodes.length - 1;
    for (let i = 0; i < count; i++) {
      const a = nodes[i];
      const b = nodes[(i + 1) % nodes.length];
      parts.push(a.out || b.in ? `C${P(a.out ?? a)} ${P(b.in ?? b)} ${P(b)}` : `L${P(b)}`);
    }
    if (sub.closed) parts.push("Z");
  }
  return parts.join("");
}
