import { fx } from "../glsl";
import type { EffectDef } from "../types";

const cmyk = /* glsl */ `${fx}
uniform float p_size;
uniform float p_angle;
uniform float p_density;
uniform float p_misregister;
uniform vec3 p_paper;
float screen(vec2 p, float angle, float cell, int channel) {
  mat2 r = rot(radians(angle));
  vec2 q = r * p / cell;
  vec2 c = floor(q) + 0.5;
  float best = 0.0;
  // Dots grow past their cell in the shadows, so look at the neighbors too.
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 cc = c + vec2(float(x), float(y));
      vec2 center = transpose(r) * (cc * cell);
      vec3 rgb = srcAvg(center, cell).rgb;
      // Partial black generation keeps color in the shadows.
      float k = (1.0 - max(rgb.r, max(rgb.g, rgb.b))) * 0.7;
      float v;
      if (channel == 3) v = k;
      else v = k >= 0.999 ? 0.0 : (1.0 - rgb[channel] - k) / (1.0 - k);
      v = sat01(v * p_density);
      // Dot area tracks ink coverage; the last few percent close the gaps between dots.
      float radius = cell * sqrt(v / PI) * mix(1.0, 1.25, v * v);
      best = max(best, cover(length(q - cc) * cell - radius));
    }
  return best;
}
void main() {
  float cell = max(2.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  float shift = p_misregister * uUnit;
  float c = screen(p + vec2(shift, 0.0), 15.0 + p_angle, cell, 0);
  float m = screen(p + vec2(0.0, shift), 75.0 + p_angle, cell, 1);
  float y = screen(p - vec2(shift * 0.5), 0.0 + p_angle, cell, 2);
  float k = screen(p, 45.0 + p_angle, cell, 3);
  vec3 col = p_paper;
  col *= mix(vec3(1.0), vec3(0.0, 0.64, 0.9), c);
  col *= mix(vec3(1.0), vec3(0.92, 0.05, 0.55), m);
  col *= mix(vec3(1.0), vec3(1.0, 0.92, 0.05), y);
  col *= mix(vec3(1.0), vec3(0.13), k);
  emit(col, src(p).a);
}`;

const mono = /* glsl */ `${fx}
uniform float p_size;
uniform float p_angle;
uniform int p_shape;
uniform float p_contrast;
uniform int p_invert;
uniform vec3 p_ink;
uniform vec3 p_paper;
float shapeAt(vec2 q, vec2 cc, float cell, float d) {
  vec2 o = (q - cc) * cell;
  if (p_shape == 0) return length(o) - cell * sqrt(d / PI) * mix(1.0, 1.25, d * d);
  if (p_shape == 1) return max(abs(o.x), abs(o.y)) - sqrt(d) * 0.5 * cell;
  if (p_shape == 2) return (abs(o.x) + abs(o.y)) * 0.7071 - sqrt(d) * 0.5 * cell;
  if (p_shape == 3) return abs(o.y) - d * 0.5 * cell;
  return min(abs(o.x), abs(o.y)) - d * 0.3 * cell;
}
void main() {
  float cell = max(2.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  mat2 r = rot(radians(p_angle));
  vec2 q = r * p / cell;
  vec2 c = floor(q) + 0.5;
  float ink = 0.0;
  vec4 here = src(p);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 cc = c + vec2(float(x), float(y));
      vec3 rgb = srcAvg(transpose(r) * (cc * cell), cell).rgb;
      float d = 1.0 - leveled(luma(rgb), p_contrast);
      if (p_invert == 1) d = 1.0 - d;
      ink = max(ink, cover(shapeAt(q, cc, cell, d)));
    }
  emit(mix(p_paper, p_ink, ink), here.a);
}`;

const dither = /* glsl */ `${fx}
uniform float p_pixel;
uniform int p_matrix;
uniform float p_spread;
uniform float p_contrast;
uniform vec3 uPalette[16];
uniform int uPaletteCount;
uniform int uGray;
void main() {
  float px = max(1.0, floor(p_pixel * uUnit + 0.5));
  vec2 cell = floor(gl_FragCoord.xy / px);
  vec4 s = srcAvg((cell + 0.5) * px, px);
  vec3 c = contrast(s.rgb, p_contrast);
  float t = bayer(cell, p_matrix + 1) - 0.5;
  float n = float(max(uPaletteCount - 1, 1));
  vec3 best = uPalette[0];
  if (uGray == 1) {
    float l = sat01(luma(c) + t * p_spread / n);
    float bl = 1e9;
    for (int i = 0; i < 16; i++) {
      if (i >= uPaletteCount) break;
      float d = abs(luma(uPalette[i]) - l);
      if (d < bl) { bl = d; best = uPalette[i]; }
    }
  } else {
    vec3 lab = labOf(clamp(c + t * p_spread / n, 0.0, 1.0));
    float bd = 1e9;
    for (int i = 0; i < 16; i++) {
      if (i >= uPaletteCount) break;
      vec3 d = labOf(uPalette[i]) - lab;
      float dd = dot(d, d);
      if (dd < bd) { bd = dd; best = uPalette[i]; }
    }
  }
  emit(best, s.a);
}`;

const stipple = /* glsl */ `${fx}
uniform float p_size;
uniform float p_density;
uniform int p_mode;
uniform vec3 p_ink;
uniform vec3 p_paper;
void main() {
  float r = max(0.6, p_size * uUnit);
  float g = r * 1.9;
  vec2 p = gl_FragCoord.xy;
  vec2 c = floor(p / g);
  vec3 col = p_paper;
  float a = src(p).a;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 id = c + vec2(float(x), float(y));
      vec2 center = (id + 0.15 + 0.7 * hash2(id)) * g;
      vec3 rgb = srcAvg(center, g * 2.0).rgb;
      float rr = r * (0.75 + 0.5 * hash(id + 5.0));
      if (p_mode == 0) {
        float dark = pow(1.0 - leveled(luma(rgb), 2.2), 1.5) * p_density;
        if (hash(id + 11.0) < dark) col = mix(col, p_ink, cover(length(p - center) - rr));
      } else {
        if (hash(id + 11.0) < 0.85 * p_density) col = mix(col, saturateColor(rgb, 1.25), cover(length(p - center) - rr * 1.3));
      }
    }
  emit(col, a);
}`;

const engraving = /* glsl */ `${fx}
uniform float p_spacing;
uniform float p_angle;
uniform float p_relief;
uniform int p_cross;
uniform vec3 p_ink;
uniform vec3 p_paper;
float lines(vec2 p, float angle, float spacing, float dark, float bend) {
  vec2 n = vec2(-sin(angle), cos(angle));
  float y = dot(p, n) / spacing + bend;
  float v = abs(fract(y) - 0.5) * spacing;
  return cover(v - dark * 0.5 * spacing);
}
void main() {
  float spacing = max(2.0, p_spacing * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  float l = leveled(luma(srcAvg(p, spacing * 0.8).rgb), 1.3);
  // Lines bend with the smoothed tones so they follow the forms, like a banknote engraving.
  float bend = luma(srcAvg(p, spacing * 6.0).rgb) * p_relief * 2.0;
  float dark = pow(1.0 - l, 1.1);
  float a = radians(p_angle);
  float ink = lines(p, a, spacing, dark * 0.95, bend);
  if (p_cross == 1 && dark > 0.55) ink = max(ink, lines(p, a + radians(62.0), spacing, (dark - 0.55) * 1.6, bend * 0.6));
  emit(mix(p_paper, p_ink, ink), s.a);
}`;

const riso = /* glsl */ `${fx}
uniform vec3 p_inkA;
uniform vec3 p_inkB;
uniform vec3 p_paper;
uniform float p_grain;
uniform float p_misregister;
uniform float p_contrast;
vec2 coverage(vec3 rgb) {
  // Least-squares split of the photo's density into the two inks' absorptions.
  vec3 target = 1.0 - contrast(rgb, p_contrast);
  vec3 a = 1.0 - p_inkA;
  vec3 b = 1.0 - p_inkB;
  float aa = dot(a, a), ab = dot(a, b), bb = dot(b, b);
  float at = dot(a, target), bt = dot(b, target);
  float det = aa * bb - ab * ab;
  vec2 x = abs(det) < 1e-5 ? vec2(at / max(aa, 1e-4), 0.0) : vec2(bb * at - ab * bt, aa * bt - ab * at) / det;
  return clamp(x, 0.0, 1.0);
}
float grainAt(vec2 p, float g, float salt) {
  vec2 cell = floor(p / g);
  return 0.8 * hash(cell + salt) + 0.2 * vnoise(p / (g * 9.0) + salt);
}
void main() {
  float g = max(1.0, p_grain * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 off = vec2(p_misregister, -p_misregister * 0.6) * uUnit;
  float ca = coverage(srcAvg(p, g).rgb).x;
  float cb = coverage(srcAvg(p - off, g).rgb).y;
  float inkA = step(grainAt(p, g, 1.0), ca);
  float inkB = step(grainAt(p - off, g, 7.0), cb);
  vec3 col = p_paper;
  col *= mix(vec3(1.0), p_inkA, inkA * 0.95);
  col *= mix(vec3(1.0), p_inkB, inkB * 0.95);
  col *= 0.96 + 0.04 * vnoise(p / (uUnit * 3.0));
  emit(col, src(p).a);
}`;

const hexColor = (h: string): [number, number, number] => [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
const PALETTES: Record<string, { colors: string[]; gray: boolean }> = {
  bit: { colors: ["000000", "ffffff"], gray: true },
  gameboy: { colors: ["0f380f", "306230", "8bac0f", "9bbc0f"], gray: true },
  cga: { colors: ["000000", "55ffff", "ff55ff", "ffffff"], gray: false },
  pico: {
    colors: ["000000", "1d2b53", "7e2553", "008751", "ab5236", "5f574f", "c2c3c7", "fff1e8", "ff004d", "ffa300", "ffec27", "00e436", "29adff", "83769c", "ff77a8", "ffccaa"],
    gray: false,
  },
  sepia: { colors: ["2b1d14", "6b4a2f", "b08a5e", "efe2c4"], gray: true },
  rgb: { colors: ["000000", "ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff", "ffffff"], gray: false },
};

export const halftoneEffects: EffectDef[] = [
  {
    id: "halftone-cmyk",
    name: "CMYK Print",
    category: "Halftone & dither",
    description: "Four rotated ink screens overprinted on paper.",
    params: [
      { key: "size", label: "Dot size", type: "number", min: 2, max: 50, step: 0.5, default: 8 },
      { key: "angle", label: "Screen angle", type: "number", min: 0, max: 90, step: 1, default: 0 },
      { key: "density", label: "Ink density", type: "number", min: 0.5, max: 1.6, step: 0.01, default: 1 },
      { key: "misregister", label: "Misregistration", type: "number", min: 0, max: 8, step: 0.1, default: 0.8 },
      { key: "paper", label: "Paper", type: "color", default: "#f5f1e8" },
    ],
    render: (ctx, u) => ctx.pass("fx-cmyk", cmyk, u),
  },
  {
    id: "halftone",
    name: "Halftone",
    category: "Halftone & dither",
    description: "One-ink screen of dots, squares, diamonds, lines or crosses.",
    params: [
      { key: "size", label: "Cell size", type: "number", min: 2, max: 80, step: 0.5, default: 10 },
      { key: "angle", label: "Angle", type: "number", min: 0, max: 90, step: 1, default: 45 },
      {
        key: "shape",
        label: "Shape",
        type: "select",
        options: [
          { value: "dot", label: "Dots" },
          { value: "square", label: "Squares" },
          { value: "diamond", label: "Diamonds" },
          { value: "line", label: "Lines" },
          { value: "cross", label: "Crosses" },
        ],
        default: "dot",
      },
      { key: "contrast", label: "Contrast", type: "number", min: 0.5, max: 3, step: 0.05, default: 1.2 },
      { key: "invert", label: "Invert", type: "toggle", default: false },
      { key: "ink", label: "Ink", type: "color", default: "#161616" },
      { key: "paper", label: "Paper", type: "color", default: "#f2eee4" },
    ],
    render: (ctx, u) => ctx.pass("fx-halftone", mono, u),
  },
  {
    id: "dither",
    name: "Retro Dither",
    category: "Halftone & dither",
    description: "Ordered Bayer dithering into classic console and computer palettes.",
    params: [
      { key: "pixel", label: "Pixel size", type: "number", min: 1, max: 20, step: 0.5, default: 3 },
      {
        key: "palette",
        label: "Palette",
        type: "select",
        options: [
          { value: "bit", label: "1-bit" },
          { value: "gameboy", label: "Handheld green" },
          { value: "cga", label: "CGA" },
          { value: "pico", label: "PICO-8" },
          { value: "sepia", label: "Sepia" },
          { value: "rgb", label: "8-color RGB" },
        ],
        default: "gameboy",
      },
      {
        key: "matrix",
        label: "Pattern",
        type: "select",
        options: [
          { value: "2", label: "2×2" },
          { value: "4", label: "4×4" },
          { value: "8", label: "8×8" },
        ],
        default: "4",
      },
      { key: "spread", label: "Dither strength", type: "number", min: 0, max: 2, step: 0.05, default: 1 },
      { key: "contrast", label: "Contrast", type: "number", min: 0.5, max: 2.5, step: 0.05, default: 1.1 },
    ],
    render(ctx, u, params) {
      const pal = PALETTES[params.palette as string] ?? PALETTES.bit;
      const colors = new Float32Array(48);
      pal.colors.forEach((c, i) => colors.set(hexColor(c), i * 3));
      return ctx.pass("fx-dither", dither, { ...u, uPalette: colors, uPaletteCount: pal.colors.length, uGray: pal.gray ? 1 : 0 });
    },
  },
  {
    id: "stipple",
    name: "Stipple",
    category: "Halftone & dither",
    description: "Hand-placed ink dots, or colored pointillism.",
    params: [
      { key: "size", label: "Dot size", type: "number", min: 0.5, max: 12, step: 0.1, default: 2 },
      { key: "density", label: "Density", type: "number", min: 0.3, max: 2, step: 0.05, default: 1.1 },
      {
        key: "mode",
        label: "Style",
        type: "select",
        options: [
          { value: "ink", label: "Ink stipple" },
          { value: "pointillism", label: "Pointillism" },
        ],
        default: "ink",
      },
      { key: "ink", label: "Ink", type: "color", default: "#1b1a1f" },
      { key: "paper", label: "Paper", type: "color", default: "#f3efe5" },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 3 },
    ],
    render: (ctx, u) => ctx.pass("fx-stipple", stipple, u),
  },
  {
    id: "engraving",
    name: "Engraving",
    category: "Halftone & dither",
    description: "Banknote-style line engraving that bends with the forms.",
    params: [
      { key: "spacing", label: "Line spacing", type: "number", min: 2, max: 30, step: 0.25, default: 6 },
      { key: "angle", label: "Angle", type: "number", min: -90, max: 90, step: 1, default: 25 },
      { key: "relief", label: "Relief", type: "number", min: 0, max: 4, step: 0.05, default: 1.4 },
      { key: "cross", label: "Cross-hatch shadows", type: "toggle", default: true },
      { key: "ink", label: "Ink", type: "color", default: "#1d2330" },
      { key: "paper", label: "Paper", type: "color", default: "#efe9da" },
    ],
    render: (ctx, u) => ctx.pass("fx-engraving", engraving, u),
  },
  {
    id: "risograph",
    name: "Risograph",
    category: "Halftone & dither",
    description: "Two grainy spot inks, slightly out of register.",
    params: [
      { key: "inkA", label: "Ink 1", type: "color", default: "#ff4fa3" },
      { key: "inkB", label: "Ink 2", type: "color", default: "#1f5fbf" },
      { key: "paper", label: "Paper", type: "color", default: "#f6f0e2" },
      { key: "grain", label: "Grain", type: "number", min: 0.5, max: 8, step: 0.1, default: 1.4 },
      { key: "misregister", label: "Misregistration", type: "number", min: 0, max: 12, step: 0.1, default: 2.5 },
      { key: "contrast", label: "Contrast", type: "number", min: 0.5, max: 2.5, step: 0.05, default: 1.15 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 1 },
    ],
    render: (ctx, u) => ctx.pass("fx-riso", riso, u),
  },
];
