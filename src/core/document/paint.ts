import type { BrushKind, PaintFill, PaintLayer, PaintOp, PaintStroke } from "./model";

/**
 * Paint layers: brush strokes and bucket fills kept as data and drawn with Canvas2D at
 * whatever resolution the view or export needs. Pure helpers here (no DOM beyond the
 * 2D context handed in): stroke drawing, flood fill, smoothing and shape recognition.
 */

export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export const BRUSHES: readonly { kind: BrushKind; label: string; size: number; opacity: number; hardness: number; note: string }[] = [
  { kind: "round", label: "Round", size: 0.012, opacity: 1, hardness: 1, note: "Solid ink, thicker with pen pressure" },
  { kind: "soft", label: "Soft", size: 0.05, opacity: 0.8, hardness: 0.2, note: "Airbrush with a soft edge" },
  { kind: "marker", label: "Marker", size: 0.02, opacity: 0.55, hardness: 1, note: "See-through; overlaps darken like a felt pen" },
  { kind: "pencil", label: "Pencil", size: 0.004, opacity: 0.9, hardness: 1, note: "Thin and grainy" },
  { kind: "spray", label: "Spray", size: 0.06, opacity: 1, hardness: 1, note: "Spray-can speckles" },
  { kind: "calligraphy", label: "Calligraphy", size: 0.018, opacity: 1, hardness: 1, note: "A flat nib at 45°: thick and thin strokes" },
  { kind: "eraser", label: "Eraser", size: 0.03, opacity: 1, hardness: 1, note: "Rubs out strokes and fills on this layer" },
];

/** Deterministic random numbers (mulberry32): textured brushes look the same every time they are drawn. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points along a stroke (px), resampled every `spacing` px with pressure interpolated. */
export function resample(points: readonly number[], w: number, h: number, spacing: number): { x: number; y: number; p: number }[] {
  const out: { x: number; y: number; p: number }[] = [];
  const n = Math.floor(points.length / 3);
  if (!n) return out;
  let px = points[0] * w;
  let py = points[1] * h;
  let pp = points[2];
  out.push({ x: px, y: py, p: pp });
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const x = points[i * 3] * w;
    const y = points[i * 3 + 1] * h;
    const p = points[i * 3 + 2];
    const len = Math.hypot(x - px, y - py);
    let d = spacing - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: px + (x - px) * t, y: py + (y - py) * t, p: pp + (p - pp) * t });
      d += spacing;
    }
    carry = len - (d - spacing);
    px = x;
    py = y;
    pp = p;
  }
  // Always end where the pointer ended.
  const last = out[out.length - 1];
  if (n > 1 && (last.x !== px || last.y !== py)) out.push({ x: px, y: py, p: pp });
  return out;
}

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A soft round dab (white, alpha falling off past `hardness`), cached per hardness. */
const sprites = new Map<number, OffscreenCanvas>();
function softSprite(hardness: number, color: string): OffscreenCanvas {
  const key = Math.round(hardness * 20);
  let base = sprites.get(key);
  if (!base) {
    base = new OffscreenCanvas(64, 64);
    const g = base.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(Math.min(0.99, key / 20), "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    sprites.set(key, base);
  }
  // Tinted copy (small, made per stroke).
  const tinted = new OffscreenCanvas(64, 64);
  const t = tinted.getContext("2d")!;
  t.drawImage(base, 0, 0);
  t.globalCompositeOperation = "source-in";
  t.fillStyle = color;
  t.fillRect(0, 0, 64, 64);
  return tinted;
}

/**
 * Draws one stroke. Dabs go onto `scratch` at full strength, which is then laid onto
 * `ctx` once at the stroke's opacity, so a see-through stroke doesn't darken where it
 * overlaps itself (markers multiply, erasers cut out).
 */
export function drawStroke(ctx: Ctx2D, scratch: Ctx2D, s: PaintStroke, w: number, h: number) {
  const radius = Math.max(0.25, (s.size * w) / 2);
  const pressure = (p: number) => 0.25 + 0.75 * Math.max(0, Math.min(1, p));
  const spacing = s.brush === "spray" ? radius * 0.5 : s.brush === "soft" ? Math.max(0.5, radius * 0.15) : Math.max(0.4, radius * 0.18);
  const dabs = resample(s.points, w, h, spacing);
  if (!dabs.length) return;
  const sw = scratch.canvas.width;
  const sh = scratch.canvas.height;
  scratch.save();
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.clearRect(0, 0, sw, sh);
  scratch.restore();
  scratch.save();
  scratch.fillStyle = s.brush === "eraser" ? "#000000" : s.color;
  const random = rng(s.seed);
  switch (s.brush) {
    case "soft": {
      const sprite = softSprite(s.hardness, s.color);
      for (const d of dabs) {
        const r = radius * pressure(d.p);
        scratch.globalAlpha = 0.35;
        scratch.drawImage(sprite, d.x - r, d.y - r, r * 2, r * 2);
      }
      break;
    }
    case "pencil":
      for (const d of dabs) {
        const r = radius * pressure(d.p);
        // Grain: a few specks around the line at varying strength.
        for (let k = 0; k < 3; k++) {
          scratch.globalAlpha = 0.35 + random() * 0.6;
          const a = random() * Math.PI * 2;
          const o = random() * r * 0.6;
          scratch.beginPath();
          scratch.arc(d.x + Math.cos(a) * o, d.y + Math.sin(a) * o, Math.max(0.35, r * (0.45 + random() * 0.4)), 0, Math.PI * 2);
          scratch.fill();
        }
      }
      break;
    case "spray":
      for (const d of dabs) {
        const r = radius * pressure(d.p);
        const count = Math.max(4, Math.round(r * 0.9));
        const dot = Math.max(0.5, r * 0.035);
        for (let k = 0; k < count; k++) {
          // Denser in the middle.
          const a = random() * Math.PI * 2;
          const o = Math.sqrt(random()) * r * (0.6 + random() * 0.4);
          scratch.globalAlpha = 0.5 + random() * 0.5;
          scratch.beginPath();
          scratch.arc(d.x + Math.cos(a) * o, d.y + Math.sin(a) * o, dot, 0, Math.PI * 2);
          scratch.fill();
        }
      }
      break;
    case "calligraphy":
      for (const d of dabs) {
        const r = radius * pressure(d.p);
        scratch.beginPath();
        scratch.ellipse(d.x, d.y, r, Math.max(0.5, r * 0.22), -Math.PI / 4, 0, Math.PI * 2);
        scratch.fill();
      }
      break;
    default:
      // Round, marker, eraser: solid round dabs.
      for (const d of dabs) {
        scratch.beginPath();
        scratch.arc(d.x, d.y, radius * pressure(d.p), 0, Math.PI * 2);
        scratch.fill();
      }
  }
  scratch.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = s.opacity;
  ctx.globalCompositeOperation = s.brush === "eraser" ? "destination-out" : s.brush === "marker" ? "multiply" : "source-over";
  ctx.drawImage(scratch.canvas, 0, 0);
  ctx.restore();
}

/**
 * Bucket fill on `img` (RGBA, straight alpha) from pixel (x, y): the connected region of
 * pixels within `tolerance` of the start colour takes `color` at `opacity`. A one-pixel
 * ring around it is filled underneath what is there, so the fill tucks in below
 * anti-aliased edges without a light halo. Returns the number of pixels filled.
 */
export function floodFill(img: { width: number; height: number; data: Uint8ClampedArray }, x0: number, y0: number, color: string, opacity: number, tolerance: number): number {
  const { width: w, height: h, data } = img;
  const sx = Math.floor(x0);
  const sy = Math.floor(y0);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;
  const start = (sy * w + sx) * 4;
  const [r0, g0, b0, a0] = [data[start], data[start + 1], data[start + 2], data[start + 3]];
  const tol = Math.max(0, Math.min(1, tolerance)) * 255 * 2;
  const similar = (i: number) => {
    const a = data[i + 3];
    // Compare premultiplied colours, so every fully transparent pixel matches every other.
    const dr = Math.abs((data[i] * a - r0 * a0) / 255);
    const dg = Math.abs((data[i + 1] * a - g0 * a0) / 255);
    const db = Math.abs((data[i + 2] * a - b0 * a0) / 255);
    return Math.max(dr, dg, db) + Math.abs(a - a0) <= tol;
  };
  const mask = new Uint8Array(w * h);
  const stack = [sx, sy];
  let filled = 0;
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    while (x >= 0 && !mask[y * w + x] && similar((y * w + x) * 4)) x--;
    x++;
    let up = false;
    let down = false;
    for (; x < w && !mask[y * w + x] && similar((y * w + x) * 4); x++) {
      mask[y * w + x] = 1;
      filled++;
      if (y > 0) {
        const m = !mask[(y - 1) * w + x] && similar(((y - 1) * w + x) * 4);
        if (m && !up) stack.push(x, y - 1);
        up = m;
      }
      if (y < h - 1) {
        const m = !mask[(y + 1) * w + x] && similar(((y + 1) * w + x) * 4);
        if (m && !down) stack.push(x, y + 1);
        down = m;
      }
    }
  }
  const [fr, fg, fb] = hexRgb(color);
  const fa = Math.max(0, Math.min(1, opacity));
  const over = (i: number, under: boolean) => {
    const da = data[i + 3] / 255;
    // Source over (core) or destination over (ring), straight alpha.
    const [ta, ba] = under ? [da, fa] : [fa, da];
    const [tr, tg, tb] = under ? [data[i], data[i + 1], data[i + 2]] : [fr, fg, fb];
    const [br, bg, bb] = under ? [fr, fg, fb] : [data[i], data[i + 1], data[i + 2]];
    const oa = ta + ba * (1 - ta);
    if (oa <= 0) return;
    data[i] = (tr * ta + br * ba * (1 - ta)) / oa;
    data[i + 1] = (tg * ta + bg * ba * (1 - ta)) / oa;
    data[i + 2] = (tb * ta + bb * ba * (1 - ta)) / oa;
    data[i + 3] = oa * 255;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mask[k]) {
        over(k * 4, false);
        continue;
      }
      // The ring: next to the region (4-neighbours).
      if ((x > 0 && mask[k - 1]) || (x < w - 1 && mask[k + 1]) || (y > 0 && mask[k - w]) || (y < h - 1 && mask[k + w])) over(k * 4, true);
    }
  return filled;
}

/** Draws every op of a paint layer, in order, into a w × h context (and its same-sized scratch). */
export function drawOps(ctx: Ctx2D, scratch: Ctx2D, ops: readonly PaintOp[], w: number, h: number) {
  for (const op of ops) {
    if (op.type === "stroke") drawStroke(ctx, scratch, op, w, h);
    else applyFill(ctx, op, w, h);
  }
}

export function applyFill(ctx: Ctx2D, op: PaintFill, w: number, h: number) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  floodFill(img, op.x * W, op.y * H, op.color, op.opacity, op.tolerance);
  ctx.putImageData(img, 0, 0);
  void w;
  void h;
}

// ─── Input: smoothing and shapes ─────────────────────────────────────────────

/**
 * Streamline: each new point moves only part of the way from the last smoothed point,
 * which irons out shaky hands. `amount` 0 (raw) .. 1 (very smooth).
 */
export function streamline(prev: { x: number; y: number } | null, x: number, y: number, amount: number) {
  if (!prev) return { x, y };
  const k = 1 - Math.max(0, Math.min(0.95, amount * 0.9));
  return { x: prev.x + (x - prev.x) * k, y: prev.y + (y - prev.y) * k };
}

type Pt = { x: number; y: number };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
function segDist(p: Pt, a: Pt, b: Pt) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (!l2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

/** Ramer–Douglas–Peucker: the points that matter for a polyline, within `epsilon`. */
export function simplify(points: readonly Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return [...points];
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segDist(points[i], points[0], points[points.length - 1]);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}

/** Evenly spaced points along a closed or open polyline. */
function densify(corners: readonly Pt[], closed: boolean, step: number): Pt[] {
  const out: Pt[] = [];
  const n = corners.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const steps = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 0; k < steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
  }
  out.push(closed ? { ...corners[0] } : { ...corners[n - 1] });
  return out;
}

export type Recognized = { kind: "line" | "ellipse" | "triangle" | "rectangle" | "polygon"; points: Pt[] };

/**
 * The shape a hand-drawn stroke was meant to be (the predictive brush: hold at the end of
 * a stroke to straighten it): a line, an ellipse, or a polygon of 3–6 corners, as points
 * along the clean shape. Null when it is none of those (a scribble stays as drawn).
 */
export function recognize(points: readonly Pt[]): Recognized | null {
  if (points.length < 6) return null;
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
  if (length < 8) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY);
  const step = Math.max(1, length / 120);

  // A line: nothing strays far from the chord.
  const chord = dist(first, last);
  if (chord > 0.85 * length) {
    const worst = Math.max(...points.map((p) => segDist(p, first, last)));
    if (worst < Math.max(2, 0.06 * chord)) return { kind: "line", points: densify([first, last], false, step) };
  }
  // Closed shapes end near where they began.
  if (chord > 0.2 * length || size < 6) return null;

  // Polygon: few corners explain the outline well.
  const loop = [...points, first];
  const corners = simplify(loop, size * 0.07).slice(0, -1);
  // Corners that are really the same point (the start and end overlap) merge.
  const merged = corners.filter((c, i) => i === 0 || dist(c, corners[i - 1]) > size * 0.12);
  if (merged.length > 2 && dist(merged[0], merged[merged.length - 1]) < size * 0.12) merged.pop();
  const polyError = (() => {
    let e = 0;
    for (const p of points) {
      let best = Infinity;
      for (let i = 0; i < merged.length; i++) best = Math.min(best, segDist(p, merged[i], merged[(i + 1) % merged.length]));
      e += best;
    }
    return e / points.length / size;
  })();

  // Ellipse: centred in the bounds, radii from them.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(1, (maxX - minX) / 2);
  const ry = Math.max(1, (maxY - minY) / 2);
  const ellipseError =
    points.reduce((e, p) => {
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      return e + Math.abs(d - 1) * Math.min(rx, ry);
    }, 0) /
    points.length /
    size;

  if (merged.length >= 3 && merged.length <= 6 && polyError < 0.035 && polyError < ellipseError) {
    let shape = merged;
    let kind: Recognized["kind"] = merged.length === 3 ? "triangle" : "polygon";
    if (merged.length === 4) {
      // Four corners near a box's: an upright rectangle.
      const boxy = merged.every((c) => (Math.abs(c.x - minX) < size * 0.15 || Math.abs(c.x - maxX) < size * 0.15) && (Math.abs(c.y - minY) < size * 0.15 || Math.abs(c.y - maxY) < size * 0.15));
      if (boxy) {
        shape = [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];
        // Keep the drawing direction.
        const area = merged.reduce((a, p, i) => a + p.x * merged[(i + 1) % 4].y - merged[(i + 1) % 4].x * p.y, 0);
        if (area < 0) shape.reverse();
        kind = "rectangle";
      }
    }
    return { kind, points: densify(shape, true, step) };
  }
  if (ellipseError < 0.06) {
    const n = Math.max(24, Math.round((Math.PI * (rx + ry)) / step));
    // Start where the stroke started, going the same way round.
    const a0 = Math.atan2((first.y - cy) / ry, (first.x - cx) / rx);
    const area = points.reduce((a, p, i) => (i ? a + points[i - 1].x * p.y - p.x * points[i - 1].y : a), 0);
    const dir = area >= 0 ? 1 : -1;
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (dir * i * Math.PI * 2) / n;
      out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
    return { kind: "ellipse", points: out };
  }
  return null;
}

/** Empty layer check (nothing drawn yet). */
export const isBlank = (layer: PaintLayer) => layer.ops.length === 0;

const extents = new WeakMap<readonly PaintOp[], { x0: number; y0: number; x1: number; y1: number } | null>();
/**
 * What a paint layer covers, in its unit box (strokes with their brush radius; a fill
 * may cover anything, so it counts as the whole box). Null when nothing is drawn.
 */
export function paintExtent(ops: readonly PaintOp[]) {
  if (extents.has(ops)) return extents.get(ops)!;
  let e: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const op of ops) {
    if (op.type === "fill") {
      e = { x0: 0, y0: 0, x1: 1, y1: 1 };
      break;
    }
    if (op.brush === "eraser") continue;
    const r = op.size / 2;
    for (let i = 0; i + 2 < op.points.length; i += 3) {
      const x = op.points[i];
      const y = op.points[i + 1];
      e = e ? { x0: Math.min(e.x0, x - r), y0: Math.min(e.y0, y - r), x1: Math.max(e.x1, x + r), y1: Math.max(e.y1, y + r) } : { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    }
  }
  extents.set(ops, e);
  return e;
}
