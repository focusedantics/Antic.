import type { Layer, TextLayer } from "@/core/document/model";
import { flatten, insertLayer } from "@/core/document/operations";
import { composite, editDocument } from "@/core/document/session";
import { fontShorthand, shownText } from "@/core/text/draw";
import { loadFonts } from "@/core/text/fonts";

/**
 * Widens text boxes that are too narrow for their text in its real font (boxes are
 * written by hand in elements and templates; a box narrower than the text would clip it).
 * Boxes grow around their centre and never shrink.
 */
export function fitTextBoxes(layer: Layer): Layer {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
  const fit = (l: Layer): Layer => {
    if (l.kind === "group") return { ...l, children: l.children.map(fit) };
    if (l.kind !== "text" || l.transform.corners) return l;
    const s = l.style;
    ctx.font = fontShorthand(s);
    const lines = shownText(s).split("\n");
    const width = Math.max(...lines.map((t) => ctx.measureText(t).width + s.letterSpacing * s.size * Math.max(0, [...t].length - 1)));
    const pad = s.highlight ? s.highlight.padding * s.size * 2 : 0;
    const need = width * 1.04 + pad + s.size * 0.1;
    const height = s.size * s.lineHeight * (lines.length - 1) + s.size * 1.25 + pad;
    return need > l.transform.width || height > l.transform.height
      ? ({ ...l, transform: { ...l.transform, width: Math.max(l.transform.width, need), height: Math.max(l.transform.height, height) } } as TextLayer)
      : l;
  };
  return fit(layer);
}

/** Every font a layer tree uses. */
export const layerFonts = (layers: readonly Layer[]) => flatten(layers).flatMap((l) => (l.kind === "text" ? [fontShorthand(l.style)] : []));

/** Adds a ready-made element above the selection (fonts loaded first so its text fits) and selects it. */
export async function insertElement(layer: Layer, label: string) {
  await loadFonts(layerFonts([layer]), 3000);
  const fitted = fitTextBoxes(layer);
  const { selection } = composite.getState();
  editDocument(label, (d) => insertLayer(d, fitted, selection.at(-1)));
  composite.setState({ selection: [fitted.id], tool: "move" });
}

