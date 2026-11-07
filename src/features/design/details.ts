import type { CompositeDocument, Layer, TextLayer, TextStyle } from "@/core/document/model";
import { flatten } from "@/core/document/operations";

/**
 * The fill-in details of a design: its labelled text layers (`TextLayer.field`), one entry
 * per label in reading order (top to bottom, then left to right). Layers sharing a label
 * (a title and its shadow copies) change together.
 */
export type DetailField = { readonly label: string; readonly value: string; readonly ids: readonly string[] };

export function detailFields(doc: Pick<CompositeDocument, "layers"> | null): DetailField[] {
  if (!doc) return [];
  const byLabel = new Map<string, TextLayer[]>();
  for (const l of flatten(doc.layers)) if (l.kind === "text" && l.field) byLabel.set(l.field, [...(byLabel.get(l.field) ?? []), l]);
  const fields = [...byLabel].map(([label, layers]) => {
    // The topmost layer of the label is the one people see; copies sit under it.
    const main = layers[layers.length - 1];
    return { label, value: main.style.text, ids: layers.map((l) => l.id), y: main.transform.y, x: main.transform.x };
  });
  fields.sort((a, b) => a.y - b.y || a.x - b.x);
  return fields.map(({ label, value, ids }) => ({ label, value, ids }));
}

/** How wide a style's widest line is, in canvas px (letter spacing included). */
export type Measure = (style: TextStyle) => number;

/**
 * A field layer with new words: the size drops so the words fit the box's width (and its
 * height, for more lines), and comes back up to the designed size as they get shorter.
 */
export function fillField(layer: TextLayer, value: string, measure: Measure): TextLayer {
  const designed = layer.fieldSize ?? layer.style.size;
  const at = { ...layer.style, text: value, size: designed };
  const width = measure(at);
  const lines = value.split("\n").length;
  const room = layer.transform.width * 0.98;
  // Lines take size × line height each (and a little more for the last), as text boxes are fitted.
  const fitsHeight = layer.transform.height / (layer.style.lineHeight * (lines - 1) + 1.25);
  const size = Math.max(1, Math.min(designed, fitsHeight, width > room ? designed * (room / width) : designed));
  return { ...layer, fieldSize: designed, style: { ...layer.style, text: value, size: Math.round(size * 100) / 100 } };
}

/** Fills one detail in: every layer with that label gets the words. */
export function fillDetail(doc: CompositeDocument, label: string, value: string, measure: Measure): CompositeDocument {
  const fill = (layers: readonly Layer[]): Layer[] =>
    layers.map((l) => (l.kind === "group" ? { ...l, children: fill(l.children) } : l.kind === "text" && l.field === label ? fillField(l, value, measure) : l));
  return { ...doc, layers: fill(doc.layers) };
}
