import type { CollageInfo, CompositeDocument, GroupLayer, Layer, SlotLayer } from "./model";
import { canvasTransform, groupLayer, slotLayer } from "./operations";
import { smartShape } from "./shapes";

/** Collage layouts: cells as x, y, width, height in the unit square (no gaps). */
export type CollageLayout = { readonly id: string; readonly label: string; readonly cells: readonly (readonly [number, number, number, number])[] };

const grid = (cols: number, rows: number): [number, number, number, number][] =>
  Array.from({ length: cols * rows }, (_, i) => [(i % cols) / cols, Math.floor(i / cols) / rows, 1 / cols, 1 / rows]);

export const COLLAGE_LAYOUTS: readonly CollageLayout[] = [
  { id: "1", label: "One photo", cells: [[0, 0, 1, 1]] },
  { id: "2-cols", label: "Side by side", cells: grid(2, 1) },
  { id: "2-rows", label: "One above the other", cells: grid(1, 2) },
  { id: "3-left", label: "Big left, two right", cells: [[0, 0, 0.6, 1], [0.6, 0, 0.4, 0.5], [0.6, 0.5, 0.4, 0.5]] },
  { id: "3-top", label: "Big top, two below", cells: [[0, 0, 1, 0.6], [0, 0.6, 0.5, 0.4], [0.5, 0.6, 0.5, 0.4]] },
  { id: "3-cols", label: "Three columns", cells: grid(3, 1) },
  { id: "3-rows", label: "Three rows", cells: grid(1, 3) },
  { id: "4-grid", label: "Four squares", cells: grid(2, 2) },
  { id: "4-top", label: "Big top, three below", cells: [[0, 0, 1, 0.62], [0, 0.62, 1 / 3, 0.38], [1 / 3, 0.62, 1 / 3, 0.38], [2 / 3, 0.62, 1 / 3, 0.38]] },
  { id: "4-left", label: "Big left, three right", cells: [[0, 0, 0.62, 1], [0.62, 0, 0.38, 1 / 3], [0.62, 1 / 3, 0.38, 1 / 3], [0.62, 2 / 3, 0.38, 1 / 3]] },
  { id: "5-mosaic", label: "Two over three", cells: [[0, 0, 0.5, 0.55], [0.5, 0, 0.5, 0.55], [0, 0.55, 1 / 3, 0.45], [1 / 3, 0.55, 1 / 3, 0.45], [2 / 3, 0.55, 1 / 3, 0.45]] },
  { id: "5-center", label: "One in the middle", cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0.25, 0.25, 0.5, 0.5]] },
  { id: "6-grid", label: "Six (3 × 2)", cells: grid(3, 2) },
  { id: "6-tall", label: "Six (2 × 3)", cells: grid(2, 3) },
  { id: "8-grid", label: "Eight (2 × 4)", cells: grid(2, 4) },
  { id: "9-grid", label: "Nine (3 × 3)", cells: grid(3, 3) },
];

export const layoutById = (id: string) => COLLAGE_LAYOUTS.find((l) => l.id === id) ?? COLLAGE_LAYOUTS[0];
export const layoutsFor = (count: number) => COLLAGE_LAYOUTS.filter((l) => l.cells.length === count);
/** A good first layout for `count` photos (the grids for 6 and 9 suit most canvases). */
export const defaultLayout = (count: number) => layoutsFor(Math.max(1, Math.min(9, count)))[0] ?? COLLAGE_LAYOUTS[COLLAGE_LAYOUTS.length - 1];

/**
 * Cell rectangles (canvas px) of a layout in `area`, `gap` px apart and from the edges.
 * Shared edges get half a gap each, so every gap is the same.
 */
export function collageCells(layout: CollageLayout, area: CollageInfo["area"], gap: number) {
  const iw = Math.max(1, area.width - 2 * gap);
  const ih = Math.max(1, area.height - 2 * gap);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  return layout.cells.map(([cx, cy, cw, ch]) => {
    const x0 = area.x + gap + cx * iw + (near(cx, 0) ? 0 : gap / 2);
    const y0 = area.y + gap + cy * ih + (near(cy, 0) ? 0 : gap / 2);
    const x1 = area.x + gap + (cx + cw) * iw - (near(cx + cw, 1) ? 0 : gap / 2);
    const y1 = area.y + gap + (cy + ch) * ih - (near(cy + ch, 1) ? 0 : gap / 2);
    return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  });
}

/** The frames of a collage placed by its info (photos, fit and styles kept, in order). */
function placeFrames(frames: readonly SlotLayer[], info: CollageInfo): SlotLayer[] {
  const layout = layoutById(info.layout);
  const gap = info.spacing * Math.min(info.area.width, info.area.height);
  const cells = collageCells(layout, info.area, gap);
  return frames.slice(0, cells.length).map((f, i) => {
    const c = cells[i];
    return {
      ...f,
      transform: { ...f.transform, x: c.x + c.width / 2, y: c.y + c.height / 2, width: c.width, height: c.height, rotation: 0, corners: undefined },
      frame: { ...smartShape("rectangle"), round: Math.max(0, Math.min(1, info.radius)) },
    };
  });
}

/** A collage of empty frames (or frames holding `photos`, in order) over `area` (default: the canvas). */
export function buildCollage(doc: Pick<CompositeDocument, "width" | "height">, layoutId: string, options: { spacing?: number; radius?: number; photos?: readonly string[]; area?: CollageInfo["area"]; placeholder?: string } = {}): GroupLayer {
  const layout = layoutById(layoutId);
  const info: CollageInfo = { layout: layout.id, spacing: options.spacing ?? 0.02, radius: options.radius ?? 0, area: options.area ?? { x: 0, y: 0, width: doc.width, height: doc.height } };
  const frames = layout.cells.map((_, i) => ({ ...slotLayer(doc), name: `Photo ${i + 1}`, assetId: options.photos?.[i] ?? null, ...(options.placeholder ? { placeholder: options.placeholder } : {}) }));
  const group = groupLayer(doc as CompositeDocument, placeFrames(frames, info), "Collage");
  return { ...group, transform: canvasTransform(doc), collage: info };
}

/**
 * The collage with new settings. Frames keep their photos in order; a layout with more
 * cells adds empty frames, one with fewer moves the extra photos' frames out (they are
 * dropped only if empty).
 */
export function relayout(group: GroupLayer, patch: Partial<Omit<CollageInfo, "area">>): GroupLayer {
  if (!group.collage) return group;
  const info = { ...group.collage, ...patch };
  const layout = layoutById(info.layout);
  const frames = group.children.filter((c): c is SlotLayer => c.kind === "slot");
  const others = group.children.filter((c) => c.kind !== "slot");
  // Photos first, so a smaller layout keeps them; then empty frames.
  const ordered = [...frames.filter((f) => f.assetId), ...frames.filter((f) => !f.assetId)];
  const kept = ordered.slice(0, layout.cells.length);
  while (kept.length < layout.cells.length) kept.push({ ...slotLayer({ width: info.area.width, height: info.area.height }), name: `Photo ${kept.length + 1}` });
  // Restore the frames' original order among those kept (so photos stay where they were).
  const order = new Map(frames.map((f, i) => [f.id, i]));
  kept.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  return { ...group, collage: info, children: [...placeFrames(kept, info), ...others] as Layer[] };
}

/** The photos of a collage moved one frame on (shuffle). */
export function rotatePhotos(group: GroupLayer): GroupLayer {
  const frames = group.children.filter((c): c is SlotLayer => c.kind === "slot");
  if (frames.length < 2) return group;
  const photos = frames.map((f) => f.assetId);
  photos.unshift(photos.pop()!);
  let i = 0;
  return { ...group, children: group.children.map((c) => (c.kind === "slot" ? { ...c, assetId: photos[i++], fit: { zoom: 1, x: 0, y: 0 } } : c)) };
}
