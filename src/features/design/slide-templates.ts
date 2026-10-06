import type { DesignAsset, TemplateData } from "@/core/design/assets";
import { assetData } from "@/core/design/assets";
import { MAX_SLIDES, slideCount, slideWidth } from "@/core/document/carousel";
import type { CompositeDocument, Layer } from "@/core/document/model";
import { canvasTransform, groupLayer, pathLayer } from "@/core/document/operations";
import { smartShape } from "@/core/document/shapes";
import { fitLayers } from "@/core/looks/look";
import { loadFonts } from "@/core/text/fonts";
import { fitTextBoxes, layerFonts } from "./insert";
import { type Template, TEMPLATES } from "./templates";

/**
 * Slides from templates: a template whose slides have the design's slide shape is laid
 * out at the design's slide size and added as new slides (a carousel template adds all
 * of its slides). The template's background becomes a rectangle behind its own slides,
 * so it does not paint over the design's other slides.
 */

/** Width ÷ height of one slide. */
const aspect = (width: number, height: number, slides = 1) => width / slides / height;
const sameShape = (a: number, b: number) => Math.abs(a / b - 1) < 0.01;

export const designSlideAspect = (doc: Pick<CompositeDocument, "width" | "height" | "carousel">) => aspect(doc.width, doc.height, slideCount(doc));

/** Built-in templates with this slide shape that still fit (a carousel holds at most MAX_SLIDES). */
export function templatesForSlides(doc: Pick<CompositeDocument, "width" | "height" | "carousel">): Template[] {
  const room = MAX_SLIDES - slideCount(doc);
  return TEMPLATES.filter((t) => (t.slides ?? 1) <= room && sameShape(aspect(t.width, t.height, t.slides), designSlideAspect(doc)));
}

/** My saved templates with this slide shape that still fit. */
export function myTemplatesForSlides(doc: Pick<CompositeDocument, "width" | "height" | "carousel">, items: readonly DesignAsset[]): DesignAsset[] {
  const room = MAX_SLIDES - slideCount(doc);
  return items.filter((a) => {
    if (a.kind !== "template") return false;
    const d = (assetData(a) as TemplateData | null)?.document;
    return !!d && slideCount(d) <= room && sameShape(designSlideAspect(d), designSlideAspect(doc));
  });
}

/** A rectangle over a whole `width × height` page, in `color`. */
function pageRect(width: number, height: number, color: string, name: string): Layer {
  const page = { width, height };
  return { ...pathLayer(page, smartShape("rectangle"), { fill: color, strokeWidth: 0 }), name, transform: canvasTransform(page) };
}

/**
 * Layers on a page that will sit beside other slides: a solid fill becomes a rectangle over
 * the page, and adjustments or effects (which reach everything below them) are kept, with
 * the page, inside a group so they only change the page.
 */
function keepToPage(layers: readonly Layer[], width: number, height: number, name: string): Layer[] {
  const boxed = layers.map((l) => (l.kind === "fill" ? { ...pageRect(width, height, l.color, l.name), opacity: l.opacity, visible: l.visible, blend: l.blend } : l));
  if (!boxed.some((l) => l.kind === "adjustment" || l.kind === "effect")) return boxed;
  return [{ ...groupLayer({ width, height } as CompositeDocument, boxed, name), expanded: false }];
}

export type SlidePages = { readonly name: string; readonly count: number; readonly layers: Layer[] };

/** A built-in template's pages at the design's slide size. */
export async function templatePages(doc: CompositeDocument, t: Template): Promise<SlidePages> {
  const count = t.slides ?? 1;
  const width = Math.round(slideWidth(doc) * count);
  const height = doc.height;
  const built = t.build({ width, height });
  await loadFonts(layerFonts(built), 3000);
  const layers = built.map(fitTextBoxes);
  const back = t.background && t.background !== doc.background ? [pageRect(width, height, t.background, `${t.name} background`)] : [];
  return { name: t.name, count, layers: keepToPage([...back, ...layers], width, height, t.name) };
}

/** One of my saved templates' pages at the design's slide size (null when it cannot be read). */
export async function myTemplatePages(doc: CompositeDocument, asset: DesignAsset): Promise<SlidePages | null> {
  const d = (assetData(asset) as TemplateData | null)?.document;
  if (!d) return null;
  const count = slideCount(d);
  const width = Math.round(slideWidth(doc) * count);
  const height = doc.height;
  const fitted = fitLayers({ width: d.width, height: d.height, items: d.layers }, width, height);
  await loadFonts(layerFonts(fitted), 3000);
  const back = d.background && d.background !== doc.background ? [pageRect(width, height, d.background, `${asset.name} background`)] : [];
  return { name: asset.name, count, layers: keepToPage([...back, ...fitted.map(fitTextBoxes)], width, height, asset.name) };
}
