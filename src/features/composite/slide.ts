import { shiftLayer, slideAt, slideWidth } from "@/core/document/carousel";
import type { CompositeDocument, Layer } from "@/core/document/model";
import { layerBounds, locate } from "@/core/document/operations";
import { composite } from "@/core/document/session";

/**
 * Where new things go in a carousel: on the slide being worked on, sized for one slide.
 * Layers are laid out on `layoutCanvas` (one slide's width; the whole design when it has
 * one page) and then moved onto that slide with `ontoWorkingSlide`.
 */

/** The slide a glide to a slide is heading for, while it runs. */
let heading: number | null = null;
/** Called as a glide to slide `index` starts (`null` when it ends or is cut short). */
export const setHeadingSlide = (index: number | null) => {
  heading = index;
};
/** The slide a glide is heading for, while one runs. */
export const headingSlide = () => heading;

/** The slide being worked on: the one in view (or being glided to), else the selected layer's, else the one in the middle of the view. Null for a one-page design. */
export function workingSlide(doc: CompositeDocument | null = composite.getState().doc): number | null {
  if (!doc?.carousel) return null;
  const { view, selection } = composite.getState();
  if (heading !== null && !view.fit) return Math.min(heading, (doc.carousel?.slides ?? 1) - 1);
  if (!view.fit) return slideAt(doc, view.centerX * doc.width);
  const picked = selection.at(-1);
  const layer = picked ? locate(doc.layers, picked)?.layer : null;
  if (layer && layer.kind !== "group") {
    const b = layerBounds(layer);
    return slideAt(doc, b.x + b.width / 2);
  }
  return slideAt(doc, view.centerX * doc.width);
}

/** The canvas to lay a new layer out on: one slide of a carousel, or the whole design. */
export const layoutCanvas = (doc: CompositeDocument): CompositeDocument => (doc.carousel ? { ...doc, width: slideWidth(doc) } : doc);

/** Layers that cover the whole design wherever they are (fills, adjustments, effects). */
const canvasWide = (l: Layer) => l.kind === "fill" || l.kind === "adjustment" || l.kind === "effect";

/** A layer laid out on `layoutCanvas(doc)`, moved onto the working slide. */
export function ontoWorkingSlide(doc: CompositeDocument, layer: Layer, slide = workingSlide(doc)): Layer {
  if (slide === null || canvasWide(layer)) return layer;
  return shiftLayer(layer, slide * slideWidth(doc));
}
