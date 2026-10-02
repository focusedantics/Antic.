import { fx, glyphs } from "../glsl";
import type { EffectDef } from "../types";

/**
 * Character sets for ASCII. Each is sorted by ink coverage when the atlas is
 * drawn, so order here does not matter. The values of the original five
 * ("standard", "simple", "binary", "hex", "dots") never change: saved documents use them.
 */
export const CHARSETS = {
  standard: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks: " ░▒▓█▖▗▘▝▚▞▙▛▜▟▀▄▌▐",
  binary: " 01",
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$░▒▓█ÆÑØŒ",
  simple: " .:-=+*#%@",
  alphabetic: " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  numeric: " 0123456789",
  math: " -+×÷=≠≈<>≤≥±∑∏∫√∞∂∆πθλμ",
  symbols: " .·,:;!?*+=~^#%&@$§¶©®•◆●■▲",
  hex: " 0123456789ABCDEF",
  dots: " .·:∙•●",
} as const;

/** The characters an ASCII layer draws with: a named set, or the custom text (with a blank added so dark areas stay empty). */
export function asciiCharset(set: unknown, custom: unknown): string {
  if (set === "custom") {
    const chars = [...new Set([...String(custom ?? "")].filter((c) => c !== "\n" && c !== "\t"))].join("");
    return chars.length ? (chars.includes(" ") ? chars : ` ${chars}`) : CHARSETS.standard;
  }
  return CHARSETS[set as keyof typeof CHARSETS] ?? CHARSETS.standard;
}

const inkModes = [
  { value: "original", label: "Photo colors" },
  { value: "mono", label: "White" },
  { value: "green", label: "Terminal green" },
  { value: "amber", label: "Amber" },
  { value: "custom", label: "Custom" },
] as const;

const inkGlsl = /* glsl */ `
vec3 inkColor(int mode, vec3 photo, vec3 custom) {
  if (mode == 0) return clamp(photo / max(max(photo.r, max(photo.g, photo.b)), 0.35), 0.0, 1.0);
  if (mode == 1) return vec3(0.94);
  if (mode == 2) return vec3(0.25, 1.0, 0.45);
  if (mode == 3) return vec3(1.0, 0.7, 0.18);
  return custom;
}`;

const ascii = /* glsl */ `${fx}${glyphs}${inkGlsl}
uniform float p_cell;
uniform float p_contrast;
uniform int p_color;
uniform vec3 p_ink;
uniform vec3 p_background;
uniform int p_invert;
void main() {
  float ch = max(3.0, p_cell * uUnit);
  vec2 cs = vec2(ch * 0.625, ch);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / cs);
  vec2 center = (cell + 0.5) * cs;
  vec4 s = srcAvg(center, ch * 0.8);
  float l = leveled(luma(s.rgb), p_contrast);
  if (p_invert == 1) l = 1.0 - l;
  float idx = min(uGlyphCount - 1.0, floor(l * uGlyphCount));
  float cov = glyph(idx, (p - cell * cs) / cs, cs);
  vec3 ink = inkColor(p_color, s.rgb, p_ink);
  emit(mix(p_background, ink, cov), s.a);
}`;

const rain = /* glsl */ `${fx}${glyphs}
uniform float p_cell;
uniform float p_density;
uniform float p_tail;
uniform float p_image;
uniform vec3 p_ink;
uniform vec3 p_background;
uniform float p_speed;
void main() {
  float ch = max(4.0, p_cell * uUnit);
  vec2 cs = vec2(ch * 0.7, ch);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / cs);
  vec4 s = srcAvg((cell + 0.5) * cs, ch);
  float l = leveled(luma(s.rgb), 2.0);
  // Up to three streams per column; a stream lights the cells above its head.
  float rows = uSize.y / cs.y;
  float trail = 0.0;
  float head = 0.0;
  for (int k = 0; k < 3; k++) {
    vec2 key = vec2(cell.x, float(k) * 13.7);
    if (hash(key + 3.1) > p_density) continue;
    // Streams fall a whole screen (plus trail) per cycle, so the animation loops.
    float h = floor(fract(hash(key) + uPhase * p_speed * (1.0 + floor(hash(key + 5.0) * 2.0))) * (rows + p_tail));
    float d = h - cell.y;
    if (d >= 0.0 && d < p_tail) {
      trail = max(trail, 1.0 - d / p_tail);
      if (d < 1.0) head = 1.0;
    }
  }
  // Glyphs change per cell; some are mirrored like a film-set terminal.
  // Some glyphs keep changing while the rain falls.
  float idx = floor(frameHash(cell * 1.37 + 0.5, hash(cell + 2.0) > 0.8 ? 10.0 : 0.0) * uGlyphCount);
  vec2 local = (p - cell * cs) / cs;
  local = (local - 0.5) * 1.15 + 0.5;
  if (hash(cell + 9.0) > 0.5) local.x = 1.0 - local.x;
  float cov = glyph(idx, local, cs);
  // The photo glows faintly everywhere; the streams light it up.
  float lit = mix(0.12 + 0.88 * trail, l * (0.6 + 0.9 * trail), p_image);
  vec3 c = p_ink * lit;
  c = mix(c, vec3(0.9, 1.0, 0.92), head * 0.85);
  emit(mix(p_background, c, cov), s.a);
}`;

const mosaic = /* glsl */ `${fx}${glyphs}${inkGlsl}
uniform float p_cell;
uniform int p_scale;
uniform int p_color;
uniform vec3 p_ink;
uniform vec3 p_background;
void main() {
  float ch = max(4.0, p_cell * uUnit);
  vec2 cs = vec2(ch * 0.625, ch);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / cs);
  vec4 s = srcAvg((cell + 0.5) * cs, ch);
  float cols = ceil(uSize.x / cs.x);
  float idx = mod(cell.y * cols + cell.x, uGlyphCount);
  vec2 local = (p - cell * cs) / cs;
  float l = leveled(luma(s.rgb), 1.4);
  if (p_scale == 1) local = (local - 0.5) / mix(0.25, 1.3, sqrt(l)) + 0.5;
  else local = (local - 0.5) * 0.9 + 0.5;
  float cov = glyph(idx, local, cs);
  emit(mix(p_background, inkColor(p_color, s.rgb, p_ink), cov), s.a);
}`;

const braille = /* glsl */ `${fx}
uniform float p_pitch;
uniform float p_threshold;
uniform int p_dither;
uniform int p_colored;
uniform vec3 p_ink;
uniform vec3 p_background;
void main() {
  float pitch = max(2.0, p_pitch * uUnit);
  vec2 cellSize = vec2(2.6, 4.6) * pitch;
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / cellSize);
  vec2 local = p - cell * cellSize - 0.3 * pitch;
  vec2 ij = clamp(floor(local / pitch), vec2(0.0), vec2(1.0, 3.0));
  vec2 center = cell * cellSize + 0.3 * pitch + (ij + 0.5) * pitch;
  vec4 s = srcAvg(center, pitch);
  float t = p_threshold;
  if (p_dither == 1) t += (bayer(ij + cell * vec2(2.0, 4.0), 2) - 0.5) * 0.5;
  float on = leveled(luma(s.rgb), 1.5) > t ? 1.0 : 0.0;
  float dot = cover(length(p - center) - pitch * 0.34) * on;
  vec3 ink = p_colored == 1 ? clamp(s.rgb * 1.25, 0.0, 1.0) : p_ink;
  emit(mix(p_background, ink, dot), s.a);
}`;

export const typeEffects: EffectDef[] = [
  {
    id: "ascii",
    name: "ASCII",
    category: "Type & code",
    description: "Rebuilds the photo from characters chosen by brightness.",
    params: [
      { key: "cell", label: "Size", type: "number", min: 4, max: 60, step: 0.5, default: 12 },
      {
        key: "charset",
        label: "Characters",
        type: "select",
        options: [
          { value: "standard", label: "Standard" },
          { value: "blocks", label: "Blocks" },
          { value: "binary", label: "Binary" },
          { value: "detailed", label: "Detailed" },
          { value: "simple", label: "Minimal" },
          { value: "alphabetic", label: "Alphabetic" },
          { value: "numeric", label: "Numeric" },
          { value: "math", label: "Math" },
          { value: "symbols", label: "Symbols" },
          { value: "hex", label: "Hex" },
          { value: "dots", label: "Dots" },
          { value: "custom", label: "Custom" },
        ],
        default: "standard",
      },
      { key: "chars", label: "Custom characters", type: "text", maxLength: 96, default: " .:-=+*#%@", showIf: { key: "charset", equals: "custom" } },
      { key: "color", label: "Ink", type: "select", options: inkModes, default: "original" },
      { key: "ink", label: "Custom ink", type: "color", default: "#f2efe6" },
      { key: "background", label: "Background", type: "color", default: "#0b0b0c" },
      { key: "contrast", label: "Contrast", type: "number", min: 0.5, max: 3, step: 0.05, default: 1.5 },
      { key: "invert", label: "Light background", type: "toggle", default: false },
    ],
    // New ASCII layers start with a soft glow and a little grain; older documents keep both off.
    initial: { post_bloom: true, post_grain: true },
    render(ctx, u, params) {
      const g = ctx.glyphs(asciiCharset(params.charset, params.chars), true);
      return ctx.pass("fx-ascii", ascii, { ...u, ...g.uniforms }, { uGlyphs: g.texture });
    },
  },
  {
    id: "code-rain",
    name: "Code Rain",
    category: "Type & code",
    animated: true,
    description: "Falling columns of glyphs lit by the image.",
    params: [
      { key: "cell", label: "Size", type: "number", min: 5, max: 60, step: 0.5, default: 14 },
      { key: "density", label: "Streams", type: "number", min: 0, max: 1, step: 0.01, default: 0.85 },
      { key: "tail", label: "Trail length", type: "number", min: 3, max: 80, step: 1, default: 26 },
      { key: "image", label: "Image strength", type: "number", min: 0, max: 1, step: 0.01, default: 0.85 },
      { key: "ink", label: "Ink", type: "color", default: "#3dff72" },
      { key: "background", label: "Background", type: "color", default: "#020603" },
      { key: "speed", label: "Speed", type: "number", min: 0, max: 6, step: 1, default: 1 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 7 },
    ],
    render(ctx, u) {
      const g = ctx.glyphs("0123456789ABCDEFZ:=*+<>|ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ", false);
      return ctx.pass("fx-rain", rain, { ...u, ...g.uniforms }, { uGlyphs: g.texture });
    },
  },
  {
    id: "type-mosaic",
    name: "Type Mosaic",
    category: "Type & code",
    description: "Your words repeated across the frame, colored and sized by the photo.",
    params: [
      { key: "text", label: "Text", type: "text", maxLength: 64, default: "FOCUSED" },
      { key: "cell", label: "Size", type: "number", min: 4, max: 80, step: 0.5, default: 16 },
      { key: "scale", label: "Size by brightness", type: "toggle", default: true },
      { key: "color", label: "Ink", type: "select", options: inkModes, default: "original" },
      { key: "ink", label: "Custom ink", type: "color", default: "#ffffff" },
      { key: "background", label: "Background", type: "color", default: "#0a0a0a" },
    ],
    render(ctx, u, params) {
      const text = String(params.text || "FOCUSED").replace(/\s+/g, " ");
      const g = ctx.glyphs(text || "A", false);
      return ctx.pass("fx-type-mosaic", mosaic, { ...u, ...g.uniforms }, { uGlyphs: g.texture });
    },
  },
  {
    id: "braille",
    name: "Braille Dots",
    category: "Type & code",
    description: "Six-by-eight dot cells, like text-mode Braille art.",
    params: [
      { key: "pitch", label: "Dot pitch", type: "number", min: 2, max: 24, step: 0.25, default: 5 },
      { key: "threshold", label: "Threshold", type: "number", min: 0.1, max: 0.9, step: 0.01, default: 0.5 },
      { key: "dither", label: "Dither", type: "toggle", default: true },
      { key: "colored", label: "Photo colors", type: "toggle", default: false },
      { key: "ink", label: "Ink", type: "color", default: "#f4f1e8" },
      { key: "background", label: "Background", type: "color", default: "#111214" },
    ],
    render: (ctx, u) => ctx.pass("fx-braille", braille, u),
  },
];
