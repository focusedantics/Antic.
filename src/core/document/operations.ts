import { defaultBasic, defaultColorGrading, defaultColorMixer, defaultToneCurve } from "@/core/develop/defaults";
import { homography } from "@/core/develop/geometry";
import { sanitizeRecipe } from "@/core/develop/operations";
import { effectById, newEffect, sanitizeEffect } from "@/core/effects/registry";
import { createId } from "@/lib/id";
import { clamp, invert3, type Mat3, type Point } from "@/lib/math";
import {
  BLEND_MODES,
  type BlendMode,
  type CompositeDocument,
  type Gradient,
  type GroupLayer,
  type Layer,
  type LayerCrop,
  type LayerMask,
  type ShapeStyle,
  type TextStyle,
  type Transform,
} from "./model";

// ─── Factories ────────────────────────────────────────────────────────────

export function createDocument(width: number, height: number, name = "Untitled", background: string | null = "#ffffff"): CompositeDocument {
  return { version: 1, id: createId("doc"), name, width, height, background, layers: [], guides: [], createdAt: Date.now() };
}

export const fullCrop: LayerCrop = { left: 0, top: 0, right: 1, bottom: 1 };

function base(name: string, transform: Transform) {
  return {
    id: createId("layer"),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    fillOpacity: 1,
    blend: "normal" as BlendMode,
    clip: false,
    transform,
    crop: fullCrop,
    mask: null,
  };
}

export const canvasTransform = (doc: Pick<CompositeDocument, "width" | "height">): Transform => ({
  x: doc.width / 2,
  y: doc.height / 2,
  width: doc.width,
  height: doc.height,
  rotation: 0,
  flipX: false,
  flipY: false,
});

/** Fits content of `w × h` inside the canvas (optionally covering it), centered. */
export function fitTransform(doc: Pick<CompositeDocument, "width" | "height">, w: number, h: number, cover = false): Transform {
  const s = cover ? Math.max(doc.width / w, doc.height / h) : Math.min(doc.width / w, doc.height / h, 1);
  return { ...canvasTransform(doc), width: w * s, height: h * s };
}

export const imageLayer = (doc: CompositeDocument, assetId: string, name: string, w: number, h: number, cover = false): Layer => ({
  ...base(name, fitTransform(doc, w, h, cover)),
  kind: "image",
  assetId,
  develop: "asset",
});

export const fillLayer = (doc: CompositeDocument, color = "#1e3a5f"): Layer => ({ ...base("Color Fill", canvasTransform(doc)), kind: "fill", color });

export const defaultGradient: Gradient = {
  type: "linear",
  angle: 90,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  reverse: false,
  stops: [
    { offset: 0, color: "#000000", opacity: 1 },
    { offset: 1, color: "#000000", opacity: 0 },
  ],
};

export const gradientLayer = (doc: CompositeDocument, gradient = defaultGradient): Layer => ({
  ...base("Gradient", canvasTransform(doc)),
  kind: "gradient",
  gradient,
});

export const defaultText: TextStyle = {
  text: "Your text",
  font: "Inter, system-ui, sans-serif",
  size: 96,
  weight: 700,
  italic: false,
  color: "#ffffff",
  align: "center",
  lineHeight: 1.15,
  letterSpacing: 0,
};

export function textLayer(doc: CompositeDocument, style: Partial<TextStyle> = {}): Layer {
  const s = { ...defaultText, size: Math.round(Math.min(doc.width, doc.height) / 10), ...style };
  const width = Math.min(doc.width * 0.8, s.text.length * s.size * 0.62 + s.size);
  return { ...base(s.text.slice(0, 32) || "Text", { ...canvasTransform(doc), width, height: s.size * s.lineHeight * 1.25 }), kind: "text", style: s };
}

export const defaultShape: ShapeStyle = { shape: "rectangle", fill: "#d9a441", fillOpacity: 1, stroke: "#000000", strokeWidth: 0, radius: 0 };

export const shapeLayer = (doc: CompositeDocument, shape: ShapeStyle["shape"]): Layer => {
  const size = Math.min(doc.width, doc.height) * 0.35;
  return { ...base(shape === "ellipse" ? "Ellipse" : "Rectangle", { ...canvasTransform(doc), width: size, height: size }), kind: "shape", style: { ...defaultShape, shape } };
};

export const adjustmentLayer = (doc: CompositeDocument): Layer => ({
  ...base("Adjustment", canvasTransform(doc)),
  kind: "adjustment",
  adjustment: { basic: defaultBasic, toneCurve: defaultToneCurve, colorMixer: defaultColorMixer, colorGrading: defaultColorGrading, profile: "color" },
});

export function effectLayer(doc: CompositeDocument, effectId: string): Layer | null {
  const effect = newEffect(effectId);
  if (!effect) return null;
  return { ...base(effectById(effectId)!.name, canvasTransform(doc)), kind: "effect", effect };
}

export const groupLayer = (doc: CompositeDocument, children: Layer[] = [], name = "Group"): GroupLayer => ({
  ...base(name, canvasTransform(doc)),
  kind: "group",
  children,
  expanded: true,
});

export const emptyMask = (): LayerMask => ({ enabled: true, invert: false, density: 1, components: [] });

// ─── Tree operations ─────────────────────────────────────────────────────

export type Location = { parent: GroupLayer | null; list: readonly Layer[]; index: number; layer: Layer };

export function locate(layers: readonly Layer[], id: string, parent: GroupLayer | null = null): Location | null {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.id === id) return { parent, list: layers, index: i, layer };
    if (layer.kind === "group") {
      const found = locate(layer.children, id, layer);
      if (found) return found;
    }
  }
  return null;
}

export const findLayer = (doc: CompositeDocument, id: string) => locate(doc.layers, id)?.layer ?? null;

/** Every layer, depth first, bottom to top. */
export function flatten(layers: readonly Layer[]): Layer[] {
  return layers.flatMap((l) => (l.kind === "group" ? [l, ...flatten(l.children)] : [l]));
}

function mapTree(layers: readonly Layer[], fn: (l: Layer) => Layer | null): Layer[] {
  const out: Layer[] = [];
  for (const layer of layers) {
    const mapped = fn(layer);
    if (!mapped) continue;
    out.push(mapped.kind === "group" ? { ...mapped, children: mapTree(mapped.children, fn) } : mapped);
  }
  return out;
}

export function updateLayer(doc: CompositeDocument, id: string, change: (l: Layer) => Layer): CompositeDocument {
  return { ...doc, layers: mapTree(doc.layers, (l) => (l.id === id ? change(l) : l)) };
}

export function updateLayers(doc: CompositeDocument, ids: readonly string[], change: (l: Layer) => Layer): CompositeDocument {
  const set = new Set(ids);
  return { ...doc, layers: mapTree(doc.layers, (l) => (set.has(l.id) ? change(l) : l)) };
}

export function removeLayers(doc: CompositeDocument, ids: readonly string[]): CompositeDocument {
  const set = new Set(ids);
  return { ...doc, layers: mapTree(doc.layers, (l) => (set.has(l.id) ? null : l)) };
}

/** Inserts `layer` above `aboveId` (same parent), or at the top of the document. */
export function insertLayer(doc: CompositeDocument, layer: Layer, aboveId?: string | null): CompositeDocument {
  if (!aboveId) return { ...doc, layers: [...doc.layers, layer] };
  const loc = locate(doc.layers, aboveId);
  if (!loc) return { ...doc, layers: [...doc.layers, layer] };
  const insert = (list: readonly Layer[]) => [...list.slice(0, loc.index + 1), layer, ...list.slice(loc.index + 1)];
  if (!loc.parent) return { ...doc, layers: insert(doc.layers) };
  return updateLayer(doc, loc.parent.id, (g) => ({ ...(g as GroupLayer), children: insert((g as GroupLayer).children) }));
}

/**
 * Moves a layer to `index` within `parentId`'s children (null = document root),
 * index counted bottom-first after removal.
 */
export function moveLayer(doc: CompositeDocument, id: string, parentId: string | null, index: number): CompositeDocument {
  const loc = locate(doc.layers, id);
  if (!loc) return doc;
  // A group cannot move into itself.
  if (parentId && (parentId === id || (loc.layer.kind === "group" && locate(loc.layer.children, parentId)))) return doc;
  const without = removeLayers(doc, [id]);
  const place = (list: readonly Layer[]) => {
    const i = clamp(index, 0, list.length);
    return [...list.slice(0, i), loc.layer, ...list.slice(i)];
  };
  if (!parentId) return { ...without, layers: place(without.layers) };
  return updateLayer(without, parentId, (g) => ({ ...(g as GroupLayer), children: place((g as GroupLayer).children) }));
}

/** Moves a layer one step up (+1) or down (-1) within its parent. */
export function nudgeLayer(doc: CompositeDocument, id: string, delta: number): CompositeDocument {
  const loc = locate(doc.layers, id);
  if (!loc) return doc;
  return moveLayer(doc, id, loc.parent?.id ?? null, loc.index + delta);
}

export function duplicateLayer(doc: CompositeDocument, id: string): { doc: CompositeDocument; id: string | null } {
  const layer = findLayer(doc, id);
  if (!layer) return { doc, id: null };
  const clone = (l: Layer): Layer =>
    l.kind === "group"
      ? { ...l, id: createId("layer"), children: l.children.map(clone) }
      : { ...l, id: createId("layer"), mask: l.mask ? { ...l.mask, components: l.mask.components.map((c) => ({ ...c, id: createId("mc") })) } : null };
  const copy = { ...clone(layer), name: `${layer.name} copy` };
  return { doc: insertLayer(doc, copy, id), id: copy.id };
}

/** Groups sibling layers (in their current order) at the position of the topmost one. */
export function groupLayers(doc: CompositeDocument, ids: readonly string[]): { doc: CompositeDocument; id: string | null } {
  const locs = ids.map((id) => locate(doc.layers, id)).filter((l): l is Location => !!l);
  if (!locs.length) return { doc, id: null };
  const parentId = locs[0].parent?.id ?? null;
  const siblings = locs.filter((l) => (l.parent?.id ?? null) === parentId).sort((a, b) => a.index - b.index);
  const group = groupLayer(doc, siblings.map((l) => l.layer));
  // Remove the originals first (the group holds them now), then put the group where the topmost was.
  const without = removeLayers(doc, siblings.map((l) => l.layer.id));
  const index = siblings[siblings.length - 1].index - (siblings.length - 1);
  const place = (list: readonly Layer[]) => [...list.slice(0, index), group, ...list.slice(index)];
  const next = parentId
    ? updateLayer(without, parentId, (g) => ({ ...(g as GroupLayer), children: place((g as GroupLayer).children) }))
    : { ...without, layers: place(without.layers) };
  return { doc: next, id: group.id };
}

export function ungroup(doc: CompositeDocument, id: string): CompositeDocument {
  const loc = locate(doc.layers, id);
  if (!loc || loc.layer.kind !== "group") return doc;
  const children = loc.layer.children;
  const replace = (list: readonly Layer[]) => [...list.slice(0, loc.index), ...children, ...list.slice(loc.index + 1)];
  if (!loc.parent) return { ...doc, layers: replace(doc.layers) };
  return updateLayer(doc, loc.parent.id, (g) => ({ ...(g as GroupLayer), children: replace((g as GroupLayer).children) }));
}

// ─── Geometry ────────────────────────────────────────────────────────────

/** Corners of the transformed (uncropped) content in canvas pixels: TL, TR, BR, BL. */
export function contentCorners(t: Transform): [Point, Point, Point, Point] {
  if (t.corners) return [...t.corners] as [Point, Point, Point, Point];
  const rad = (t.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const hw = t.width / 2;
  const hh = t.height / 2;
  return ([
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const).map(([x, y]) => ({ x: t.x + x * c - y * s, y: t.y + x * s + y * c })) as [Point, Point, Point, Point];
}

/** Content uv (0..1, before crop, after flips) → canvas px homography. */
export function contentToCanvas(t: Transform): Mat3 {
  const [a, b, c, d] = contentCorners(t);
  const uv = [
    [t.flipX ? 1 : 0, t.flipY ? 1 : 0],
    [t.flipX ? 0 : 1, t.flipY ? 1 : 0],
    [t.flipX ? 0 : 1, t.flipY ? 0 : 1],
    [t.flipX ? 1 : 0, t.flipY ? 0 : 1],
  ];
  return homography(uv, [
    [a.x, a.y],
    [b.x, b.y],
    [c.x, c.y],
    [d.x, d.y],
  ]);
}

export const canvasToContent = (t: Transform) => invert3(contentToCanvas(t));

/** Axis-aligned bounds of the visible (cropped) content, canvas pixels. */
export function layerBounds(layer: Layer): { x: number; y: number; width: number; height: number } {
  const m = contentToCanvas(layer.transform);
  const { left, top, right, bottom } = layer.crop;
  const pts = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map(([u, v]) => {
    const w = m[6] * u + m[7] * v + m[8];
    return { x: (m[0] * u + m[1] * v + m[2]) / w, y: (m[3] * u + m[4] * v + m[5]) / w };
  });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/**
 * `doc` with everything painted above a point hidden: above layer `id` (it stays
 * visible) or, when `hideSelf`, from `id` up. With no id the whole document shows.
 * Used to preview what an effect placed there would receive as input.
 */
export function layersBelow(doc: CompositeDocument, id: string | null, hideSelf = false): CompositeDocument {
  if (!id) return doc;
  let reached = false;
  const walk = (layers: readonly Layer[]): Layer[] =>
    layers.map((l) => {
      if (reached) return l.visible ? { ...l, visible: false } : l;
      if (l.id === id) {
        reached = true;
        return hideSelf ? { ...l, visible: false } : l;
      }
      return l.kind === "group" ? { ...l, children: walk(l.children) } : l;
    });
  return { ...doc, layers: walk(doc.layers) };
}

/** Is canvas point `p` inside the layer's visible quad? */
export function hitTest(layer: Layer, p: Point): boolean {
  if (layer.kind === "fill" || layer.kind === "adjustment" || layer.kind === "effect") return true;
  const m = canvasToContent(layer.transform);
  const w = m[6] * p.x + m[7] * p.y + m[8];
  const u = (m[0] * p.x + m[1] * p.y + m[2]) / w;
  const v = (m[3] * p.x + m[4] * p.y + m[5]) / w;
  return u >= layer.crop.left && u <= layer.crop.right && v >= layer.crop.top && v <= layer.crop.bottom;
}

/** Translates a layer, including a perspective quad. */
export function moveTransform(t: Transform, dx: number, dy: number): Transform {
  return { ...t, x: t.x + dx, y: t.y + dy, corners: t.corners?.map((c) => ({ x: c.x + dx, y: c.y + dy })) as Transform["corners"] };
}

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Aligns layers to each other's bounds, or to the canvas when one layer is selected. */
export function align(doc: CompositeDocument, ids: readonly string[], to: Alignment): CompositeDocument {
  const layers = ids.map((id) => findLayer(doc, id)).filter((l): l is Layer => !!l);
  if (!layers.length) return doc;
  const bounds = layers.map(layerBounds);
  const target =
    layers.length === 1
      ? { x: 0, y: 0, width: doc.width, height: doc.height }
      : (() => {
          const x = Math.min(...bounds.map((b) => b.x));
          const y = Math.min(...bounds.map((b) => b.y));
          return { x, y, width: Math.max(...bounds.map((b) => b.x + b.width)) - x, height: Math.max(...bounds.map((b) => b.y + b.height)) - y };
        })();
  let next = doc;
  layers.forEach((layer, i) => {
    const b = bounds[i];
    let dx = 0;
    let dy = 0;
    if (to === "left") dx = target.x - b.x;
    if (to === "center") dx = target.x + target.width / 2 - (b.x + b.width / 2);
    if (to === "right") dx = target.x + target.width - (b.x + b.width);
    if (to === "top") dy = target.y - b.y;
    if (to === "middle") dy = target.y + target.height / 2 - (b.y + b.height / 2);
    if (to === "bottom") dy = target.y + target.height - (b.y + b.height);
    next = updateLayer(next, layer.id, (l) => ({ ...l, transform: moveTransform(l.transform, dx, dy) }));
  });
  return next;
}

/** Spaces three or more layers evenly between the outermost ones. */
export function distribute(doc: CompositeDocument, ids: readonly string[], axis: "x" | "y"): CompositeDocument {
  const items = ids
    .map((id) => findLayer(doc, id))
    .filter((l): l is Layer => !!l)
    .map((layer) => ({ layer, b: layerBounds(layer) }))
    .sort((a, b) => (axis === "x" ? a.b.x + a.b.width / 2 - (b.b.x + b.b.width / 2) : a.b.y + a.b.height / 2 - (b.b.y + b.b.height / 2)));
  if (items.length < 3) return doc;
  const center = (b: { x: number; y: number; width: number; height: number }) => (axis === "x" ? b.x + b.width / 2 : b.y + b.height / 2);
  const first = center(items[0].b);
  const last = center(items[items.length - 1].b);
  let next = doc;
  items.forEach(({ layer, b }, i) => {
    const want = first + ((last - first) * i) / (items.length - 1);
    const d = want - center(b);
    next = updateLayer(next, layer.id, (l) => ({ ...l, transform: moveTransform(l.transform, axis === "x" ? d : 0, axis === "y" ? d : 0) }));
  });
  return next;
}

// ─── Sanitizing ──────────────────────────────────────────────────────────

type U = Record<string, unknown> | undefined;
const obj = (v: unknown): U => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback);
const str = (v: unknown, fallback: string, max = 200) => (typeof v === "string" ? v.slice(0, max) : fallback);
const color = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
const blendIds = new Set(BLEND_MODES.map((b) => b.id));

function sanitizeTransform(v: unknown, doc: { width: number; height: number }): Transform {
  const t = obj(v);
  const corners = Array.isArray(t?.corners) && t.corners.length === 4 ? (t.corners.map((c) => ({ x: num(obj(c)?.x, 0), y: num(obj(c)?.y, 0) })) as unknown as Transform["corners"]) : undefined;
  return {
    x: num(t?.x, doc.width / 2),
    y: num(t?.y, doc.height / 2),
    width: num(t?.width, doc.width, 0.01),
    height: num(t?.height, doc.height, 0.01),
    rotation: num(t?.rotation, 0, -3600, 3600),
    flipX: t?.flipX === true,
    flipY: t?.flipY === true,
    corners,
  };
}

function sanitizeLayer(v: unknown, doc: { width: number; height: number }, depth = 0): Layer | null {
  const l = obj(v);
  if (!l || depth > 32) return null;
  const c = obj(l.crop);
  const left = num(c?.left, 0, 0, 1);
  const top = num(c?.top, 0, 0, 1);
  const mask = obj(l.mask);
  const common = {
    id: str(l.id, createId("layer"), 64),
    name: str(l.name, "Layer", 120),
    visible: l.visible !== false,
    locked: l.locked === true,
    opacity: num(l.opacity, 1, 0, 1),
    fillOpacity: num(l.fillOpacity, 1, 0, 1),
    blend: (blendIds.has(l.blend as BlendMode) ? l.blend : "normal") as BlendMode,
    clip: l.clip === true,
    transform: sanitizeTransform(l.transform, doc),
    crop: { left, top, right: num(c?.right, 1, left + 0.001, 1), bottom: num(c?.bottom, 1, top + 0.001, 1) },
    mask: mask
      ? {
          enabled: mask.enabled !== false,
          invert: mask.invert === true,
          density: num(mask.density, 1, 0, 1),
          // Components share the develop mask schema; reuse its sanitizer through a recipe.
          components: sanitizeRecipe({ masks: [{ components: mask.components }] }, { raw: false }).masks[0]?.components ?? [],
        }
      : null,
  };
  switch (l.kind) {
    case "image":
      return { ...common, kind: "image", assetId: str(l.assetId, "", 64), develop: l.develop === "asset" || !obj(l.develop) ? "asset" : sanitizeRecipe(l.develop, { raw: false }) };
    case "fill":
      return { ...common, kind: "fill", color: color(l.color, "#000000") };
    case "gradient": {
      const g = obj(l.gradient);
      const stops = (Array.isArray(g?.stops) ? g.stops : [])
        .map((s) => obj(s))
        .filter((s): s is Record<string, unknown> => !!s)
        .map((s) => ({ offset: num(s.offset, 0, 0, 1), color: color(s.color, "#000000"), opacity: num(s.opacity, 1, 0, 1) }))
        .sort((a, b) => a.offset - b.offset)
        .slice(0, 16);
      return {
        ...common,
        kind: "gradient",
        gradient: {
          type: g?.type === "radial" ? "radial" : "linear",
          angle: num(g?.angle, 90, -360, 360),
          scale: num(g?.scale, 1, 0.05, 5),
          offsetX: num(g?.offsetX, 0, -2, 2),
          offsetY: num(g?.offsetY, 0, -2, 2),
          reverse: g?.reverse === true,
          stops: stops.length >= 2 ? stops : defaultGradient.stops,
        },
      };
    }
    case "text": {
      const s = obj(l.style);
      return {
        ...common,
        kind: "text",
        style: {
          text: str(s?.text, "Text", 5000),
          font: str(s?.font, defaultText.font, 200),
          size: num(s?.size, 96, 1, 5000),
          weight: num(s?.weight, 400, 100, 900),
          italic: s?.italic === true,
          color: color(s?.color, "#ffffff"),
          align: s?.align === "left" || s?.align === "right" ? s.align : "center",
          lineHeight: num(s?.lineHeight, 1.15, 0.5, 4),
          letterSpacing: num(s?.letterSpacing, 0, -0.5, 2),
        },
      };
    }
    case "shape": {
      const s = obj(l.style);
      return {
        ...common,
        kind: "shape",
        style: {
          shape: s?.shape === "ellipse" ? "ellipse" : "rectangle",
          fill: color(s?.fill, "#d9a441"),
          fillOpacity: num(s?.fillOpacity, 1, 0, 1),
          stroke: color(s?.stroke, "#000000"),
          strokeWidth: num(s?.strokeWidth, 0, 0, 1000),
          radius: num(s?.radius, 0, 0, 10000),
        },
      };
    }
    case "adjustment": {
      const a = obj(l.adjustment);
      const r = sanitizeRecipe({ ...a, toneCurve: a?.toneCurve }, { raw: false });
      return { ...common, kind: "adjustment", adjustment: { basic: r.basic, toneCurve: r.toneCurve, colorMixer: r.colorMixer, colorGrading: r.colorGrading, profile: r.profile } };
    }
    case "effect": {
      const effect = sanitizeEffect(l.effect);
      return effect ? { ...common, kind: "effect", effect } : null;
    }
    case "group":
      return {
        ...common,
        kind: "group",
        expanded: l.expanded !== false,
        children: (Array.isArray(l.children) ? l.children : []).map((c) => sanitizeLayer(c, doc, depth + 1)).filter((x): x is Layer => !!x),
      };
    default:
      return null;
  }
}

export function sanitizeDocument(v: unknown): CompositeDocument {
  const d = obj(v);
  const width = Math.round(num(d?.width, 1920, 1, 30000));
  const height = Math.round(num(d?.height, 1080, 1, 30000));
  const size = { width, height };
  return {
    version: 1,
    id: str(d?.id, createId("doc"), 64),
    name: str(d?.name, "Untitled", 120),
    width,
    height,
    background: d?.background === null ? null : color(d?.background, "#ffffff"),
    layers: (Array.isArray(d?.layers) ? d.layers : []).map((l) => sanitizeLayer(l, size)).filter((l): l is Layer => !!l),
    guides: (Array.isArray(d?.guides) ? d.guides : [])
      .map((g) => obj(g))
      .filter((g): g is Record<string, unknown> => !!g)
      .map((g) => ({ id: str(g.id, createId("guide"), 64), axis: g.axis === "y" ? ("y" as const) : ("x" as const), position: num(g.position, 0) })),
    createdAt: num(d?.createdAt, Date.now()),
  };
}

