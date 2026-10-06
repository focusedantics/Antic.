import type { CompositeDocument, GroupLayer, Layer, LayerFx, PathLayer, PathNode, PathStyle, SlotLayer, SmartShape, SubPath, TextLayer, TextStyle } from "@/core/document/model";
import { canvasTransform, groupLayer, pathLayer, slotLayer, textLayer } from "@/core/document/operations";
import { fitUnit, pathBounds, smartShape } from "@/core/document/shapes";
import type { Point } from "@/lib/math";

/**
 * Builds layers in a local frame: `w × h` units mapped onto the canvas at a scale and
 * position, so elements and templates are written once and fit any canvas size.
 */
export type Kit = {
  readonly doc: Pick<CompositeDocument, "width" | "height">;
  /** Canvas px per unit. */
  readonly s: number;
  /** Canvas position of the frame's top-left. */
  readonly ox: number;
  readonly oy: number;
};

/** A `w × h`-unit frame filling `share` of the canvas (by its tighter side), centred. */
export function kit(doc: Pick<CompositeDocument, "width" | "height">, w: number, h: number, share = 1): Kit {
  const s = Math.min(doc.width / w, doc.height / h) * share;
  return { doc, s, ox: (doc.width - w * s) / 2, oy: (doc.height - h * s) / 2 };
}

/** A frame stretched over the whole canvas: x and y scale separately (backgrounds, layouts). */
export function fullKit(doc: Pick<CompositeDocument, "width" | "height">, w: number, h: number): Kit & { sx: number; sy: number } {
  return { doc, s: Math.min(doc.width / w, doc.height / h), ox: 0, oy: 0, sx: doc.width / w, sy: doc.height / h };
}

const box = (k: Kit, x: number, y: number, w: number, h: number) => ({ ...canvasTransform(k.doc), x: k.ox + (x + w / 2) * k.s, y: k.oy + (y + h / 2) * k.s, width: Math.max(1, w * k.s), height: Math.max(1, h * k.s) });

/** A smart shape in the box x, y, w, h (units). */
export function shape(k: Kit, x: number, y: number, w: number, h: number, sh: SmartShape | SmartShape["kind"], style: Partial<PathStyle> = {}, extra: Partial<PathLayer> = {}): PathLayer {
  const s = typeof sh === "string" ? smartShape(sh) : sh;
  const l = pathLayer(k.doc, s, scaleStyle(k, style));
  return { ...l, transform: box(k, x, y, w, h), ...extra };
}

const scaleStyle = (k: Kit, style: Partial<PathStyle>): Partial<PathStyle> => (style.strokeWidth !== undefined ? { ...style, strokeWidth: style.strokeWidth * k.s } : style);

/** A path through points (units), corners only unless nodes carry handles; its box fits it. */
export function path(k: Kit, subpaths: readonly { closed: boolean; nodes: readonly (Point | PathNode)[] }[], style: Partial<PathStyle> = {}, name = "Path", extra: Partial<PathLayer> = {}): PathLayer {
  const subs: SubPath[] = subpaths.map((s) => ({ closed: s.closed, nodes: s.nodes as PathNode[] }));
  const b = pathBounds(subs);
  const st = scaleStyle(k, style);
  const inset = st.stroke && (st.strokeWidth ?? 0) > 0 ? (st.strokeWidth ?? 0) / 2 / k.s : 0;
  const l = pathLayer(k.doc, smartShape("rectangle"), st);
  return {
    ...l,
    name,
    shape: null,
    paths: fitUnit(subs),
    transform: box(k, b.x - inset, b.y - inset, b.width + inset * 2, b.height + inset * 2),
    ...extra,
  };
}

/** Text centred in the box (units); `size` in units. */
export function text(k: Kit, x: number, y: number, w: number, h: number, value: string, style: Partial<TextStyle> & { size: number }, extra: Partial<TextLayer> = {}): TextLayer {
  const t = textLayer(k.doc as CompositeDocument, { ...style, text: value, size: style.size * k.s }) as TextLayer;
  return { ...t, transform: box(k, x, y, w, h), ...extra };
}

export function frame(k: Kit, x: number, y: number, w: number, h: number, sh: SmartShape | SmartShape["kind"] = "rectangle", extra: Partial<SlotLayer> = {}): SlotLayer {
  return { ...slotLayer(k.doc, typeof sh === "string" ? smartShape(sh) : sh, box(k, x, y, w, h)), ...extra };
}

export function group(k: Kit, name: string, children: Layer[]): GroupLayer {
  return { ...groupLayer(k.doc as CompositeDocument, children, name), expanded: false };
}

/** Layer styles with sizes in units. */
export function fx(k: Kit, f: LayerFx): LayerFx {
  return {
    ...(f.shadow ? { shadow: { ...f.shadow, distance: f.shadow.distance * k.s, blur: f.shadow.blur * k.s } } : {}),
    ...(f.glow ? { glow: { ...f.glow, blur: f.glow.blur * k.s } } : {}),
    ...(f.outline ? { outline: { ...f.outline, width: f.outline.width * k.s } } : {}),
    ...(f.blur ? { blur: f.blur * k.s } : {}),
  };
}

/** Points along a function, for hand-drawn-looking open paths. */
export const trace = (count: number, f: (t: number) => Point): Point[] => Array.from({ length: count + 1 }, (_, i) => f(i / count));
