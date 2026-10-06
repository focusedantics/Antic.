import type { CompositeDocument, Layer, PaintOp } from "./model";
import { moveTransform } from "./operations";

/**
 * Carousels: one wide canvas cut into equal slides, side by side. Anything placed across
 * a slide edge continues onto the next slide, so panoramas are seamless when the slides
 * are swiped. Adding, removing and moving slides changes the canvas width and shifts the
 * layers after the change; layers that cover the whole canvas (backgrounds, fills,
 * adjustments, effects) stretch with it.
 */
export const MAX_SLIDES = 20;
export const slideCount = (doc: Pick<CompositeDocument, "carousel">) => doc.carousel?.slides ?? 1;
export const slideWidth = (doc: Pick<CompositeDocument, "width" | "carousel">) => doc.width / slideCount(doc);
/** The slide a canvas x falls in. */
export const slideAt = (doc: Pick<CompositeDocument, "width" | "carousel">, x: number) => Math.max(0, Math.min(slideCount(doc) - 1, Math.floor(x / slideWidth(doc))));

/** Covers the whole canvas (and so stretches with it rather than moving). */
function spansCanvas(l: Layer, width: number, height: number): boolean {
  if (l.kind === "fill" || l.kind === "adjustment" || l.kind === "effect" || l.kind === "group") return true;
  if (l.kind === "image" || l.kind === "slot" || l.kind === "text") return false;
  const t = l.transform;
  return !t.corners && t.rotation === 0 && Math.abs(t.x - width / 2) < 1 && Math.abs(t.width - width) < 1 && Math.abs(t.y - height / 2) < 1 && Math.abs(t.height - height) < 1;
}

/**
 * The layer tree on a canvas changed from `oldWidth` to `newWidth`: `move(x)` says how far
 * a layer centred at x moves (null: removed). Canvas-wide layers are refitted; drawings
 * keep their strokes where they were.
 */
function remap(layers: readonly Layer[], oldWidth: number, newWidth: number, height: number, move: (x: number, l: Layer) => number | null): Layer[] {
  return layers.flatMap((l): Layer[] => {
    if (spansCanvas(l, oldWidth, height)) {
      const t = { ...l.transform, x: newWidth / 2, width: newWidth };
      if (l.kind === "group") {
        const area = l.collage?.area;
        const shift = area ? move(area.x + area.width / 2, l) : 0;
        if (shift === null && area) return [];
        return [{ ...l, transform: t, children: remap(l.children, oldWidth, newWidth, height, move), ...(l.collage && area ? { collage: { ...l.collage, area: { ...area, x: area.x + (shift ?? 0) } } } : {}) }];
      }
      if (l.kind === "paint") {
        // Strokes are stored in the box; keep them where they were on the canvas (moving each with its slide).
        const ops = l.ops.flatMap((op): PaintOp[] => {
          if (op.type === "fill") {
            const x = op.x * oldWidth;
            const d = move(x, l);
            return d === null ? [] : [{ ...op, x: (x + d) / newWidth }];
          }
          const first = op.points[0] * oldWidth;
          const d = move(first, l);
          if (d === null) return [];
          const points = op.points.map((v, i) => (i % 3 === 0 ? (v * oldWidth + d) / newWidth : v));
          return [{ ...op, points, size: (op.size * oldWidth) / newWidth }];
        });
        return [{ ...l, transform: t, ops }];
      }
      return [{ ...l, transform: t }];
    }
    const d = move(l.transform.x, l);
    if (d === null) return [];
    return [d ? { ...l, transform: moveTransform(l.transform, d, 0) } : l];
  });
}

const withWidth = (doc: CompositeDocument, slides: number, layers: Layer[]): CompositeDocument => {
  const sw = slideWidth(doc);
  const { carousel: _c, ...rest } = doc;
  return { ...rest, width: Math.round(sw * slides), layers, ...(slides >= 2 ? { carousel: { slides } } : {}) };
};

/** Adds `count` empty slides before slide `at` (0 = the front, slideCount = the end). */
export function insertSlides(doc: CompositeDocument, at: number, count = 1): CompositeDocument {
  const n = slideCount(doc);
  const add = Math.max(0, Math.min(count, MAX_SLIDES - n));
  if (!add) return doc;
  const sw = slideWidth(doc);
  const edge = Math.max(0, Math.min(n, at)) * sw;
  const newWidth = Math.round(sw * (n + add));
  return withWidth(doc, n + add, remap(doc.layers, doc.width, newWidth, doc.height, (x) => (x >= edge ? add * sw : 0)));
}

/** A layer moved sideways by `dx` (a group with its children and collage area). */
export function shiftLayer(l: Layer, dx: number): Layer {
  return l.kind === "group"
    ? { ...l, transform: moveTransform(l.transform, dx, 0), children: l.children.map((c) => shiftLayer(c, dx)), ...(l.collage ? { collage: { ...l.collage, area: { ...l.collage.area, x: l.collage.area.x + dx } } } : {}) }
    : { ...l, transform: moveTransform(l.transform, dx, 0) };
}

/**
 * Adds `count` slides before slide `at` holding `layers`, which are laid out for a canvas
 * `count` slides wide at this design's slide size (a template's pages). A single design
 * becomes a carousel. The new layers go above the design's own, but under canvas-wide
 * adjustments and effects at the top, so those still reach the new slides.
 */
export function insertSlidesWith(doc: CompositeDocument, at: number, count: number, layers: readonly Layer[]): CompositeDocument {
  const n = slideCount(doc);
  if (count < 1 || n + count > MAX_SLIDES) return doc;
  const where = Math.max(0, Math.min(n, at));
  const widened = insertSlides(doc, where, count);
  const placed = layers.map((l) => shiftLayer(l, where * slideWidth(doc)));
  let i = widened.layers.length;
  while (i > 0 && (widened.layers[i - 1].kind === "adjustment" || widened.layers[i - 1].kind === "effect")) i--;
  return { ...widened, layers: [...widened.layers.slice(0, i), ...placed, ...widened.layers.slice(i)] };
}

/** Removes slide `index`: layers centred on it go, the slides after it move left. */
export function removeSlide(doc: CompositeDocument, index: number): CompositeDocument {
  const n = slideCount(doc);
  if (n < 2) return doc;
  const sw = slideWidth(doc);
  const from = index * sw;
  const to = from + sw;
  const newWidth = Math.round(sw * (n - 1));
  return withWidth(doc, n - 1, remap(doc.layers, doc.width, newWidth, doc.height, (x) => (x >= to ? -sw : x >= from ? null : 0)));
}

/** A copy of slide `index` inserted after it (layers centred on it are duplicated). */
export function duplicateSlide(doc: CompositeDocument, index: number, freshId: () => string): CompositeDocument {
  const n = slideCount(doc);
  if (n >= MAX_SLIDES) return doc;
  const sw = slideWidth(doc);
  const from = index * sw;
  const to = from + sw;
  const inside = (l: Layer) => !spansCanvas(l, doc.width, doc.height) && l.transform.x >= from && l.transform.x < to;
  const copies = collect(doc.layers, inside).map((l) => renew({ ...l, transform: moveTransform(l.transform, sw, 0) }, freshId));
  const opened = insertSlides(doc, index + 1);
  return { ...opened, layers: [...opened.layers, ...copies] };
}

/** Top-level layers (and children of canvas-wide groups) matching `test`. */
function collect(layers: readonly Layer[], test: (l: Layer) => boolean): Layer[] {
  return layers.flatMap((l) => (l.kind === "group" && !l.collage ? collect(l.children, test) : test(l) ? [l] : []));
}
const renew = (l: Layer, freshId: () => string): Layer => ({ ...l, id: freshId(), ...(l.kind === "group" ? { children: l.children.map((c) => renew(c, freshId)) } : {}) }) as Layer;

/** Moves slide `from` to position `to`: its layers travel with it, the slides between shift over. */
export function moveSlide(doc: CompositeDocument, from: number, to: number): CompositeDocument {
  const n = slideCount(doc);
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return doc;
  const sw = slideWidth(doc);
  return withWidth(
    doc,
    n,
    remap(doc.layers, doc.width, doc.width, doc.height, (x) => {
      const s = Math.max(0, Math.min(n - 1, Math.floor(x / sw)));
      if (s === from) return (to - from) * sw;
      if (from < to && s > from && s <= to) return -sw;
      if (from > to && s >= to && s < from) return sw;
      return 0;
    }),
  );
}

/** Turns a single design into a carousel of `slides` slides (the design is the first slide). */
export function makeCarousel(doc: CompositeDocument, slides: number): CompositeDocument {
  if (doc.carousel) return doc;
  return insertSlides({ ...doc }, 1, Math.max(1, Math.min(MAX_SLIDES, slides) - 1));
}

/**
 * Slides `from` .. `from + count - 1` as a document of their own (for export and
 * previews): the same layers shifted, so neighbouring slides meet pixel for pixel.
 */
export function sliceDocument(doc: CompositeDocument, from: number, count = 1): CompositeDocument {
  const sw = slideWidth(doc);
  const { carousel: _c, ...rest } = doc;
  return { ...rest, width: Math.round(sw * count), layers: doc.layers.map((l) => shiftLayer(l, -from * sw)), ...(count >= 2 ? { carousel: { slides: count } } : {}) };
}
