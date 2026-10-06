import { defaultBasic, defaultColorGrading, defaultColorMixer, defaultToneCurve } from "@/core/develop/defaults";
import { homography } from "@/core/develop/geometry";
import { sanitizeRecipe } from "@/core/develop/operations";
import { effectById, newEffect, sanitizeEffect } from "@/core/effects/registry";
import { ANIMATION_LIMITS, DEFAULT_ANIMATION } from "./animation";
import { createId } from "@/lib/id";
import { mapPaths, pathBounds, SMART_SHAPES, shapePaths, smartShape } from "./shapes";
import { paintExtent } from "./paint";
import { clamp, invert3, type Mat3, type Point } from "@/lib/math";
import {
  BLEND_MODES,
  type BlendMode,
  type CompositeDocument,
  type DocAnimation,
  type Gradient,
  type GroupLayer,
  type Layer,
  type LayerCrop,
  type LayerFx,
  type LayerMask,
  type BrushKind,
  type PaintLayer,
  type PaintOp,
  type PathLayer,
  type PathNode,
  type PathStyle,
  type ShapeStyle,
  type SlotLayer,
  type SmartShape,
  type SmartShapeKind,
  type SubPath,
  type TextMotionKind,
  type TextStyle,
  type Transform,
} from "./model";

// ─── Factories ────────────────────────────────────────────────────────────

export function createDocument(width: number, height: number, name = "Untitled", background: string | null = "#ffffff", purpose?: "design"): CompositeDocument {
  return { version: 1, id: createId("doc"), name, width, height, background, layers: [], guides: [], ...(purpose ? { purpose } : {}), createdAt: Date.now() };
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

export const TEXT_MOTIONS: readonly { id: TextMotionKind; label: string; repeats: boolean }[] = [
  { id: "none", label: "None (still)", repeats: false },
  { id: "typewriter", label: "Typewriter", repeats: false },
  { id: "pop-in", label: "Pop in, letter by letter", repeats: false },
  { id: "wave", label: "Wave", repeats: true },
  { id: "bounce", label: "Bounce", repeats: true },
  { id: "rainbow", label: "Rainbow", repeats: true },
  { id: "pulse", label: "Pulse", repeats: true },
  { id: "flicker", label: "Neon flicker", repeats: false },
  { id: "glitch", label: "Glitch", repeats: false },
];

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

export const defaultPathStyle: PathStyle = {
  fill: "#d9a441",
  fillOpacity: 1,
  stroke: null,
  strokeOpacity: 1,
  strokeWidth: 0,
  dash: [],
  cap: "round",
  join: "round",
  fillRule: "nonzero",
};

/** Box proportions (width / height) a shape starts with. */
const SHAPE_ASPECT: Partial<Record<SmartShapeKind, number>> = { arrow: 1.7, "double-arrow": 2, chevron: 0.8, speech: 1.3, cloud: 1.5, crescent: 0.75, teardrop: 0.8, line: 1 };

/** A smart shape (star, heart, arrow…) centred on the canvas. */
export function pathLayer(doc: Pick<CompositeDocument, "width" | "height">, shape: SmartShape, style: Partial<PathStyle> = {}): PathLayer {
  const size = Math.min(doc.width, doc.height) * 0.4;
  const aspect = SHAPE_ASPECT[shape.kind] ?? 1;
  const line = shape.kind === "line";
  const strokeWidth = line ? Math.max(2, Math.round(Math.min(doc.width, doc.height) * 0.012)) : 0;
  const width = line ? size * 1.5 : aspect >= 1 ? size * aspect : size;
  const height = line ? strokeWidth * 2 : aspect >= 1 ? size : size / aspect;
  const label = SMART_SHAPES.find((s) => s.kind === shape.kind)?.label ?? "Shape";
  return {
    ...base(label, { ...canvasTransform(doc), width, height }),
    kind: "path",
    shape,
    paths: [],
    style: { ...defaultPathStyle, ...(line ? { fill: null, stroke: "#111111", strokeWidth } : {}), ...style },
  };
}

/** The paths a path layer draws, in its unit box. */
export const layerPaths = (layer: PathLayer): SubPath[] =>
  layer.shape ? shapePaths(layer.shape, layer.transform.width / Math.max(1e-6, layer.transform.height)) : (layer.paths as SubPath[]);

/** Freezes a smart shape into nodes the pen can edit. */
export const toEditablePath = (layer: PathLayer): PathLayer => (layer.shape ? { ...layer, shape: null, paths: layerPaths(layer) } : layer);

/** An empty drawing over the whole canvas. */
export const paintLayer = (doc: Pick<CompositeDocument, "width" | "height">, name = "Drawing"): PaintLayer => ({ ...base(name, canvasTransform(doc)), kind: "paint", ops: [] });

/** Half the stroke: paths are drawn this far inside their box so the stroke fits. */
export const pathInset = (layer: PathLayer) => (layer.style.stroke !== null && layer.style.strokeWidth > 0 ? layer.style.strokeWidth / 2 : 0);

/** A path point (unit box) → canvas px, the way the compositor draws it. */
export function pathPointToCanvas(layer: PathLayer, p: Point): Point {
  const t = layer.transform;
  const i = pathInset(layer);
  const u = (i + p.x * Math.max(0, t.width - 2 * i)) / t.width;
  const v = (i + p.y * Math.max(0, t.height - 2 * i)) / t.height;
  return applyMat(contentToCanvas(t), { x: u, y: v });
}

/** Canvas px → a path point (unit box) of this layer. */
export function canvasToPathPoint(layer: PathLayer, c: Point): Point {
  const t = layer.transform;
  const i = pathInset(layer);
  const uv = applyMat(canvasToContent(t), c);
  return { x: (uv.x * t.width - i) / Math.max(1e-6, t.width - 2 * i), y: (uv.y * t.height - i) / Math.max(1e-6, t.height - 2 * i) };
}

const applyMat = (m: Mat3, p: Point): Point => {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
};

/**
 * Fits a drawn path's box to its nodes again after editing (points may have left the box
 * or the drawing shrunk), keeping every point where it is on the canvas.
 */
export function refitPath(layer: PathLayer): PathLayer {
  if (layer.shape || layer.transform.corners || !layer.paths.length) return layer;
  const b = pathBounds(layer.paths);
  const near = (a: number, c: number) => Math.abs(a - c) < 1e-4;
  if (near(b.x, 0) && near(b.y, 0) && near(b.x + b.width, 1) && near(b.y + b.height, 1)) return layer;
  const t = layer.transform;
  const i = pathInset(layer);
  const iw = Math.max(0, t.width - 2 * i);
  const ih = Math.max(0, t.height - 2 * i);
  // The bounds' centre as an offset from the box centre, in the box's own (unflipped) axes.
  const cx = i + (b.x + b.width / 2) * iw - t.width / 2;
  const cy = i + (b.y + b.height / 2) * ih - t.height / 2;
  const fx = t.flipX ? -cx : cx;
  const fy = t.flipY ? -cy : cy;
  const rad = (t.rotation * Math.PI) / 180;
  const x = t.x + fx * Math.cos(rad) - fy * Math.sin(rad);
  const y = t.y + fx * Math.sin(rad) + fy * Math.cos(rad);
  const paths = mapPaths(layer.paths, (p) => ({ x: b.width > 1e-9 ? (p.x - b.x) / b.width : 0.5, y: b.height > 1e-9 ? (p.y - b.y) / b.height : 0.5 }));
  return { ...layer, paths, transform: { ...t, x, y, width: Math.max(1, b.width * iw + 2 * i), height: Math.max(1, b.height * ih + 2 * i) } };
}

/** A path layer from points in canvas px (the pen), its box fitted to them. */
export function pathFromCanvas(doc: Pick<CompositeDocument, "width" | "height">, nodes: readonly PathNode[], closed: boolean, style: Partial<PathStyle>): PathLayer {
  const base = pathLayer(doc, smartShape("rectangle"), style);
  const layer: PathLayer = { ...base, name: closed ? "Shape" : "Path", shape: null, paths: [{ closed, nodes }], transform: { ...canvasTransform(doc), x: doc.width / 2, y: doc.height / 2 } };
  // Start from a box equal to the canvas with no inset, then fit.
  const inset = pathInset(layer);
  const unit: PathLayer = { ...layer, paths: mapPaths(layer.paths, (p) => ({ x: p.x / doc.width, y: p.y / doc.height })), style: { ...layer.style, stroke: null } };
  const fitted = refitPath({ ...unit, transform: { ...unit.transform, width: doc.width, height: doc.height } });
  // Now grow the box by the stroke's inset on every side (the drawing keeps its place).
  return { ...fitted, style: layer.style, transform: { ...fitted.transform, width: fitted.transform.width + 2 * inset, height: fitted.transform.height + 2 * inset } };
}

/** A photo frame. Without a box it is a centred square 60 % of the canvas's short side. */
export function slotLayer(doc: Pick<CompositeDocument, "width" | "height">, frame: SmartShape = smartShape("rectangle"), box?: { x: number; y: number; width: number; height: number }): SlotLayer {
  const size = Math.min(doc.width, doc.height) * 0.6;
  const t = box ? { ...canvasTransform(doc), ...box } : { ...canvasTransform(doc), width: size, height: size };
  return { ...base("Photo frame", t), kind: "slot", frame, assetId: null, fit: { zoom: 1, x: 0, y: 0 }, placeholder: "#c9ccd1" };
}

/** The photo a layer shows (image layers and filled frames). */
export const layerAsset = (l: Layer): string | null => (l.kind === "image" ? l.assetId : l.kind === "slot" ? l.assetId : null);

/** Every photo a layer tree shows, once each. */
export const documentAssets = (layers: readonly Layer[], visibleOnly = false): string[] => [
  ...new Set(
    flatten(layers)
      .filter((l) => !visibleOnly || l.visible)
      .map(layerAsset)
      .filter((id): id is string => !!id),
  ),
];

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
  if (u < layer.crop.left || u > layer.crop.right || v < layer.crop.top || v > layer.crop.bottom) return false;
  // A drawing covers the canvas but is picked only where something is drawn.
  if (layer.kind === "paint") {
    const e = paintExtent(layer.ops);
    return !!e && u >= e.x0 && u <= e.x1 && v >= e.y0 && v <= e.y1;
  }
  return true;
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

function sanitizeGradient(v: unknown): Gradient {
  const g = obj(v);
  const stops = (Array.isArray(g?.stops) ? g.stops : [])
    .map((s) => obj(s))
    .filter((s): s is Record<string, unknown> => !!s)
    .map((s) => ({ offset: num(s.offset, 0, 0, 1), color: color(s.color, "#000000"), opacity: num(s.opacity, 1, 0, 1) }))
    .sort((a, b) => a.offset - b.offset)
    .slice(0, 16);
  return {
    type: g?.type === "radial" ? "radial" : "linear",
    angle: num(g?.angle, 90, -360, 360),
    scale: num(g?.scale, 1, 0.05, 5),
    offsetX: num(g?.offsetX, 0, -2, 2),
    offsetY: num(g?.offsetY, 0, -2, 2),
    reverse: g?.reverse === true,
    stops: stops.length >= 2 ? stops : defaultGradient.stops,
  };
}

const shapeKinds = new Set(SMART_SHAPES.map((s) => s.kind));
function sanitizeSmartShape(v: unknown, fallback: SmartShapeKind = "rectangle"): SmartShape {
  const s = obj(v);
  const kind = shapeKinds.has(s?.kind as SmartShapeKind) ? (s!.kind as SmartShapeKind) : fallback;
  const d = smartShape(kind);
  return { kind, points: Math.round(num(s?.points, d.points, 2, 48)), ratio: num(s?.ratio, d.ratio, 0, 1), round: num(s?.round, d.round, 0, 1) };
}

/** At most this many path nodes per layer (a pen drawing is far smaller). */
const MAX_NODES = 20000;
function sanitizePaths(v: unknown): SubPath[] {
  let budget = MAX_NODES;
  const pt = (p: unknown) => {
    const o = obj(p);
    return o ? { x: num(o.x, 0, -100, 100), y: num(o.y, 0, -100, 100) } : undefined;
  };
  return (Array.isArray(v) ? v : []).slice(0, 1000).flatMap((sub): SubPath[] => {
    const o = obj(sub);
    const nodes = (Array.isArray(o?.nodes) ? o.nodes : []).slice(0, Math.max(0, budget)).flatMap((n) => {
      const p = pt(n);
      if (!p) return [];
      const i = pt(obj(n)?.in);
      const out = pt(obj(n)?.out);
      return [{ ...p, ...(i ? { in: i } : {}), ...(out ? { out } : {}) }];
    });
    budget -= nodes.length;
    return nodes.length ? [{ closed: o?.closed === true, nodes }] : [];
  });
}

function sanitizePathStyle(v: unknown): PathStyle {
  const s = obj(v);
  const nullableColor = (c: unknown, fallback: string | null) => (c === null ? null : typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
  return {
    fill: nullableColor(s?.fill, defaultPathStyle.fill),
    fillOpacity: num(s?.fillOpacity, 1, 0, 1),
    ...(obj(s?.fillGradient) ? { fillGradient: sanitizeGradient(s?.fillGradient) } : {}),
    stroke: nullableColor(s?.stroke, null),
    strokeOpacity: num(s?.strokeOpacity, 1, 0, 1),
    ...(obj(s?.strokeGradient) ? { strokeGradient: sanitizeGradient(s?.strokeGradient) } : {}),
    strokeWidth: num(s?.strokeWidth, 0, 0, 2000),
    dash: (Array.isArray(s?.dash) ? s.dash : []).slice(0, 8).map((d) => num(d, 1, 0.01, 100)),
    cap: s?.cap === "butt" || s?.cap === "square" ? s.cap : "round",
    join: s?.join === "miter" || s?.join === "bevel" ? s.join : "round",
    fillRule: s?.fillRule === "evenodd" ? "evenodd" : "nonzero",
  };
}

const brushKinds = new Set<BrushKind>(["round", "soft", "marker", "pencil", "spray", "calligraphy", "eraser"]);
/** At most this many numbers of stroke points per layer (about 330 000 points). */
const MAX_PAINT_NUMBERS = 1_000_000;
function sanitizePaintOps(v: unknown): PaintOp[] {
  let budget = MAX_PAINT_NUMBERS;
  return (Array.isArray(v) ? v : []).slice(0, 20000).flatMap((raw): PaintOp[] => {
    const o = obj(raw);
    if (!o) return [];
    if (o.type === "fill")
      return [{ type: "fill", x: num(o.x, 0.5, -1, 2), y: num(o.y, 0.5, -1, 2), color: color(o.color, "#000000"), opacity: num(o.opacity, 1, 0, 1), tolerance: num(o.tolerance, 0.15, 0, 1) }];
    if (o.type !== "stroke" || !Array.isArray(o.points)) return [];
    const count = Math.min(Math.floor(o.points.length / 3) * 3, Math.max(0, budget - (budget % 3)));
    const points: number[] = new Array(count);
    for (let i = 0; i < count; i++) points[i] = num(o.points[i], 0, -10, 10);
    budget -= count;
    if (count < 3) return [];
    return [
      {
        type: "stroke",
        brush: brushKinds.has(o.brush as BrushKind) ? (o.brush as BrushKind) : "round",
        color: color(o.color, "#000000"),
        size: num(o.size, 0.01, 0.0001, 2),
        opacity: num(o.opacity, 1, 0, 1),
        hardness: num(o.hardness, 1, 0, 1),
        points,
        seed: Math.round(num(o.seed, 1, 0, 2 ** 31)),
        ...(typeof o.tip === "string" && o.tip ? { tip: o.tip.slice(0, 64) } : {}),
      },
    ];
  });
}

function sanitizeFx(v: unknown): LayerFx | undefined {
  const f = obj(v);
  if (!f) return undefined;
  const sh = obj(f.shadow);
  const gl = obj(f.glow);
  const ol = obj(f.outline);
  const fx: LayerFx = {
    ...(sh
      ? { shadow: { color: color(sh.color, "#000000"), opacity: num(sh.opacity, 0.5, 0, 1), angle: num(sh.angle, 90, -360, 360), distance: num(sh.distance, 10, 0, 5000), blur: num(sh.blur, 20, 0, 2000), spread: num(sh.spread, 0, 0, 1) } }
      : {}),
    ...(gl ? { glow: { color: color(gl.color, "#ffffff"), opacity: num(gl.opacity, 0.8, 0, 1), blur: num(gl.blur, 20, 0, 2000), spread: num(gl.spread, 0, 0, 1) } } : {}),
    ...(ol ? { outline: { color: color(ol.color, "#ffffff"), opacity: num(ol.opacity, 1, 0, 1), width: num(ol.width, 8, 0, 1000) } } : {}),
    ...(num(f.blur, 0, 0, 2000) > 0 ? { blur: num(f.blur, 0, 0, 2000) } : {}),
  };
  return Object.keys(fx).length ? fx : undefined;
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
    ...(sanitizeFx(l.fx) ? { fx: sanitizeFx(l.fx) } : {}),
  };
  switch (l.kind) {
    case "image":
      return { ...common, kind: "image", assetId: str(l.assetId, "", 64), develop: l.develop === "asset" || !obj(l.develop) ? "asset" : sanitizeRecipe(l.develop, { raw: false }) };
    case "fill":
      return { ...common, kind: "fill", color: color(l.color, "#000000") };
    case "gradient":
      return { ...common, kind: "gradient", gradient: sanitizeGradient(l.gradient) };
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
          ...(obj(s?.motion) && TEXT_MOTIONS.some((m) => m.id === obj(s?.motion)?.kind) && obj(s?.motion)?.kind !== "none"
            ? { motion: { kind: obj(s?.motion)!.kind as TextMotionKind, speed: Math.round(num(obj(s?.motion)!.speed, 1, 1, 4)), amount: num(obj(s?.motion)!.amount, 0.5, 0, 1) } }
            : {}),
          ...(num(s?.curve, 0, -1, 1) !== 0 ? { curve: num(s?.curve, 0, -1, 1) } : {}),
          ...(obj(s?.gradient) ? { gradient: sanitizeGradient(s?.gradient) } : {}),
          ...(s?.textCase === "upper" || s?.textCase === "lower" || s?.textCase === "title" ? { textCase: s.textCase } : {}),
          ...(s?.underline === true ? { underline: true } : {}),
          ...(s?.strike === true ? { strike: true } : {}),
          ...(obj(s?.highlight)
            ? {
                highlight: {
                  color: color(obj(s?.highlight)!.color, "#000000"),
                  opacity: num(obj(s?.highlight)!.opacity, 1, 0, 1),
                  padding: num(obj(s?.highlight)!.padding, 0.2, 0, 2),
                  radius: num(obj(s?.highlight)!.radius, 0.15, 0, 2),
                },
              }
            : {}),
        },
      };
    }
    case "path": {
      const shape = l.shape === null || l.shape === undefined ? null : sanitizeSmartShape(l.shape);
      const paths = sanitizePaths(l.paths);
      // A pen drawing with no nodes left draws nothing; keep it as an empty layer.
      return { ...common, kind: "path", shape, paths: shape ? [] : paths, style: sanitizePathStyle(l.style) };
    }
    case "paint":
      return { ...common, kind: "paint", ops: sanitizePaintOps(l.ops) };
    case "slot": {
      const f = obj(l.fit);
      return {
        ...common,
        kind: "slot",
        frame: sanitizeSmartShape(l.frame),
        assetId: typeof l.assetId === "string" && l.assetId ? l.assetId.slice(0, 64) : null,
        fit: { zoom: num(f?.zoom, 1, 1, 20), x: num(f?.x, 0, -1, 1), y: num(f?.y, 0, -1, 1) },
        placeholder: color(l.placeholder, "#c9ccd1"),
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
    case "group": {
      const c = obj(l.collage);
      const a = obj(c?.area);
      const collage = c
        ? {
            collage: {
              layout: str(c.layout, "4-grid", 40),
              spacing: num(c.spacing, 0.02, 0, 0.25),
              radius: num(c.radius, 0, 0, 1),
              area: { x: num(a?.x, 0), y: num(a?.y, 0), width: num(a?.width, doc.width, 1), height: num(a?.height, doc.height, 1) },
            },
          }
        : {};
      return {
        ...common,
        ...collage,
        kind: "group",
        expanded: l.expanded !== false,
        children: (Array.isArray(l.children) ? l.children : []).map((c) => sanitizeLayer(c, doc, depth + 1)).filter((x): x is Layer => !!x),
      };
    }
    default:
      return null;
  }
}

export function sanitizeAnimation(v: unknown): DocAnimation {
  const a = obj(v);
  return {
    duration: Math.round(num(a?.duration, DEFAULT_ANIMATION.duration, ANIMATION_LIMITS.duration[0], ANIMATION_LIMITS.duration[1]) * 10) / 10,
    fps: Math.round(num(a?.fps, DEFAULT_ANIMATION.fps, ANIMATION_LIMITS.fps[0], ANIMATION_LIMITS.fps[1])),
  };
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
    ...(obj(d?.animation) ? { animation: sanitizeAnimation(d?.animation) } : {}),
    ...(d?.purpose === "design" ? { purpose: "design" as const } : {}),
    ...(obj(d?.carousel) && num(obj(d?.carousel)!.slides, 1) >= 2 ? { carousel: { slides: Math.round(num(obj(d?.carousel)!.slides, 2, 2, 20)) } } : {}),
    ...(typeof d?.folder === "string" && d.folder.trim() ? { folder: d.folder.split("/").map((p) => p.trim()).filter(Boolean).join("/").slice(0, 80) } : {}),
    createdAt: num(d?.createdAt, Date.now()),
  };
}

