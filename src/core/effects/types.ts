import type { Target, Texture } from "@/core/gpu/gl";

/**
 * Stylization effects (ASCII, halftone, mosaics, glass, glitch…). An effect is a
 * pure function of an image and its parameters, rendered on the GPU. Spatial
 * parameters use "units" of 1/1000 of the image's long side, so a thumbnail
 * preview and a full-resolution export show the same number of cells, dots or lines.
 */
export type EffectCategory =
  | "Light & glass"
  | "Type & code"
  | "Halftone & dither"
  | "Textile & craft"
  | "Pixel & 3D"
  | "Edges & outlines"
  | "Analog & glitch"
  | "Experimental"
  | "Tracking & interface"
  | "Motion";

export const EFFECT_CATEGORIES: EffectCategory[] = [
  "Light & glass",
  "Type & code",
  "Halftone & dither",
  "Textile & craft",
  "Pixel & 3D",
  "Edges & outlines",
  "Analog & glitch",
  "Experimental",
  "Tracking & interface",
  "Motion",
];

export type ParamDef =
  | { readonly key: string; readonly label: string; readonly type: "number"; readonly min: number; readonly max: number; readonly step?: number; readonly default: number }
  | { readonly key: string; readonly label: string; readonly type: "color"; readonly default: string }
  | { readonly key: string; readonly label: string; readonly type: "select"; readonly options: readonly { value: string; label: string }[]; readonly default: string }
  | { readonly key: string; readonly label: string; readonly type: "toggle"; readonly default: boolean }
  | { readonly key: string; readonly label: string; readonly type: "text"; readonly maxLength: number; readonly default: string };

export type ParamValue = number | string | boolean;
export type EffectParams = Readonly<Record<string, ParamValue>>;

/** Picks for the browser's first category. */
export const OUR_PICKS = "Our picks";

/** What an effect sees while rendering. */
export type EffectContext = {
  /** The image, premultiplied and display-encoded, with mipmaps (textureLod averages). */
  readonly input: Texture;
  readonly width: number;
  readonly height: number;
  /** Working pixels per unit (1/1000 of the long side). */
  readonly unit: number;
  /** Runs a full-size pass; `uInput`, `uSize`, `uUnit`, `uSeed`, `uMaxLod` are bound automatically. */
  pass(key: string, fragment: string, uniforms: Record<string, number | readonly number[] | Float32Array>, textures?: Record<string, Texture | null>): Target;
  /** Gaussian blur with sigma in working pixels. */
  blur(texture: Texture, sigma: number): Target;
  /** A glyph atlas for a character set (sorted from emptiest to densest when `sort`). Bind `uniforms` with it. */
  glyphs(charset: string, sort: boolean): { texture: Texture; uniforms: Record<string, number | number[]> };
  release(target: Target): void;
};

export type EffectDef = {
  readonly id: string;
  readonly name: string;
  readonly category: EffectCategory;
  readonly description: string;
  readonly params: readonly ParamDef[];
  /** Moves over time: seamless loops of the document's (or clip's) loop length. */
  readonly animated?: boolean;
  /** Returns a new premultiplied target of the working size. */
  render(ctx: EffectContext, uniforms: Record<string, number | number[]>, params: EffectParams): Target;
};

export type EffectInstance = { readonly id: string; readonly params: EffectParams };

const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

/** Parameter values → `p_<key>` uniforms (select → option index, toggle → 0/1, color → vec3). */
export function paramUniforms(def: EffectDef, params: EffectParams): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  for (const p of def.params) {
    const v = params[p.key] ?? p.default;
    if (p.type === "number") out[`p_${p.key}`] = typeof v === "number" ? v : p.default;
    else if (p.type === "color") out[`p_${p.key}`] = hexToRgb(typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : p.default);
    else if (p.type === "select") out[`p_${p.key}`] = Math.max(0, p.options.findIndex((o) => o.value === v));
    else if (p.type === "toggle") out[`p_${p.key}`] = v === true ? 1 : 0;
  }
  return out;
}

export function defaultParams(def: EffectDef): EffectParams {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/** Clamps and fills parameters against the definition (for untrusted documents). */
export function sanitizeParams(def: EffectDef, input: unknown): EffectParams {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, ParamValue> = {};
  for (const p of def.params) {
    const v = src[p.key];
    if (p.type === "number") out[p.key] = typeof v === "number" && Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
    else if (p.type === "color") out[p.key] = typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : p.default;
    else if (p.type === "select") out[p.key] = p.options.some((o) => o.value === v) ? (v as string) : p.default;
    else if (p.type === "toggle") out[p.key] = typeof v === "boolean" ? v : p.default;
    else out[p.key] = typeof v === "string" ? v.slice(0, p.maxLength) : p.default;
  }
  return out;
}
