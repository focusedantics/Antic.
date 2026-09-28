import { fx, glyphs } from "../glsl";
import type { EffectDef } from "../types";

/** Characters available to HUD text, in atlas order. */
export const HUD_CHARS = "0123456789.:%-+ TRKOBJRECIDPLN°C";
const index = (c: string) => HUD_CHARS.indexOf(c);

const hudText = /* glsl */ `
/** Draws a string of atlas indices (-1 terminates) at \`origin\` with glyph height h. */
float text(vec2 p, vec2 origin, float h, float chars[12]) {
  vec2 cs = vec2(h * 0.625, h);
  vec2 local = (p - origin) / cs;
  if (local.y < 0.0 || local.y > 1.0 || local.x < 0.0 || local.x >= 12.0) return 0.0;
  int i = int(floor(local.x));
  float idx = chars[i];
  if (idx < 0.0) return 0.0;
  return glyph(idx, vec2(fract(local.x), local.y), cs);
}
float digit(float value, float place) { return mod(floor(value / place), 10.0); }
`;

const tracking = /* glsl */ `${fx}${glyphs}${hudText}
uniform float p_cell;
uniform float p_sensitivity;
uniform int p_color;
uniform float p_scan;
uniform int p_labels;
uniform int p_grid;
vec3 tint(int mode) { return mode == 0 ? vec3(0.35, 1.0, 0.5) : mode == 1 ? vec3(1.0, 0.72, 0.2) : mode == 2 ? vec3(0.4, 0.85, 1.0) : vec3(1.0); }
float box(vec2 p, vec2 lo, vec2 hi, float w) {
  // Corner brackets only, like a detector overlay.
  vec2 c = (lo + hi) * 0.5;
  vec2 h = (hi - lo) * 0.5;
  vec2 d = abs(p - c) - h;
  float outline = abs(max(d.x, d.y)) - w * 0.5;
  vec2 fromCorner = h - abs(p - c);
  float arm = min(h.x, h.y) * 0.35;
  float nearCorner = (fromCorner.x < arm && fromCorner.y < arm) ? 1.0 : 0.0;
  return cover(outline) * nearCorner;
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  vec3 ink = tint(p_color);
  float l = luma(s.rgb);
  vec3 col = p_color == 3 ? s.rgb * 0.8 : ink * (0.08 + 0.75 * l);
  col *= 1.0 - p_scan * 0.35 * (0.5 + 0.5 * cos(p.y / max(1.5, uUnit * 2.0) * TAU));
  float w = max(1.0, uUnit * 1.2);
  float overlay = 0.0;
  // Candidate boxes on a coarse grid; detail (fine vs. coarse average) decides which fire.
  float cell = max(16.0, p_cell * uUnit);
  vec2 id = floor(p / cell);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 k = id + vec2(float(x), float(y));
      vec2 center = (k + 0.5) * cell + (hash2(k) - 0.5) * cell * 0.3;
      float detail = length(srcAvg(center, cell * 0.2).rgb - srcAvg(center, cell * 1.5).rgb) * 3.0;
      detail += abs(luma(srcAvg(center, cell * 0.5).rgb) - luma(srcAvg(center + cell * 0.3, cell * 0.5).rgb)) * 2.0;
      if (detail < 1.0 - p_sensitivity || hash(k + 17.0) > 0.55) continue;
      vec2 half_ = cell * vec2(0.35 + 0.35 * hash(k + 3.0), 0.3 + 0.35 * hash(k + 4.0));
      overlay = max(overlay, box(p, center - half_, center + half_, w));
      if (p_labels == 1) {
        float h = max(6.0, uUnit * 9.0);
        float conf = floor(clamp(0.55 + detail * 0.3, 0.0, 0.99) * 100.0);
        float chars[12] = float[12](${index("T")}.0, ${index("R")}.0, ${index("K")}.0, ${index(" ")}.0, digit(conf, 10.0), digit(conf, 1.0), ${index("%")}.0, -1.0, -1.0, -1.0, -1.0, -1.0);
        vec2 origin = center - half_ - vec2(0.0, h * 1.25);
        vec2 barLo = origin - vec2(w, h * 0.12);
        vec2 barHi = origin + vec2(h * 0.625 * 7.0 + w, h * 1.1);
        if (all(greaterThan(p, barLo)) && all(lessThan(p, barHi))) {
          col = mix(col, ink * 0.9, 0.85);
          overlay = max(overlay, 0.0);
          col = mix(col, vec3(0.02), text(p, origin, h, chars));
        }
      }
    }
  // Center reticle and edge ticks.
  vec2 c = uSize * 0.5;
  float R = min(uSize.x, uSize.y) * 0.06;
  float ret = cover(abs(length(p - c) - R) - w * 0.5);
  vec2 dc = abs(p - c);
  ret = max(ret, cover(dc.x - w * 0.5) * step(R * 0.5, dc.y) * step(dc.y, R * 1.6));
  ret = max(ret, cover(dc.y - w * 0.5) * step(R * 0.5, dc.x) * step(dc.x, R * 1.6));
  overlay = max(overlay, ret);
  if (p_grid == 1) {
    float g = min(uSize.x, uSize.y) / 12.0;
    vec2 f = abs(fract(p / g + 0.5) - 0.5) * g;
    float tick = cover(min(f.x, f.y) - w * 0.4) * (step(p.y, g * 0.3) + step(uSize.y - g * 0.3, p.y) + step(p.x, g * 0.3) + step(uSize.x - g * 0.3, p.x));
    overlay = max(overlay, min(tick, 1.0) * 0.8);
    overlay = max(overlay, cover(min(f.x, f.y) - w * 0.25) * 0.12);
  }
  // REC indicator and running counter in the top-left corner.
  float h = max(7.0, uUnit * 14.0);
  vec2 o = vec2(h * 1.2, h * 1.0);
  float dot = cover(length(p - (o + vec2(h * 0.4, h * 0.5))) - h * 0.32);
  col = mix(col, vec3(1.0, 0.15, 0.1), dot);
  float frame = floor(uSeed * 137.0 + 1042.0);
  float rec[12] = float[12](${index("R")}.0, ${index("E")}.0, ${index("C")}.0, ${index(" ")}.0, ${index("0")}.0, digit(frame, 1000.0), ${index(":")}.0, digit(frame, 100.0), digit(frame, 10.0), ${index(":")}.0, digit(frame, 1.0), ${index("0")}.0);
  overlay = max(overlay, text(p, o + vec2(h * 1.1, 0.0), h, rec));
  col = mix(col, ink, overlay);
  emit(col, max(s.a, overlay));
}`;

const thermal = /* glsl */ `${fx}${glyphs}${hudText}
uniform int p_palette;
uniform float p_smooth;
uniform float p_contrast;
uniform int p_hud;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (p_palette == 0) {
    // Iron: black, violet, red, orange, yellow, white.
    vec3 c0 = vec3(0.0, 0.0, 0.05), c1 = vec3(0.3, 0.0, 0.5), c2 = vec3(0.8, 0.05, 0.3), c3 = vec3(0.98, 0.45, 0.0), c4 = vec3(1.0, 0.85, 0.1), c5 = vec3(1.0, 1.0, 0.9);
    if (t < 0.2) return mix(c0, c1, t / 0.2);
    if (t < 0.45) return mix(c1, c2, (t - 0.2) / 0.25);
    if (t < 0.7) return mix(c2, c3, (t - 0.45) / 0.25);
    if (t < 0.9) return mix(c3, c4, (t - 0.7) / 0.2);
    return mix(c4, c5, (t - 0.9) / 0.1);
  }
  if (p_palette == 1) return hsv2rgb(vec3(0.7 * (1.0 - t), 0.95, 0.35 + 0.65 * smoothstep(0.0, 0.3, t)));
  if (p_palette == 2) return vec3(t);
  return vec3(1.0 - t);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = srcLod(p, log2(max(1.0, p_smooth * uUnit)));
  float heat = sat01((luma(s.rgb) - 0.5) * p_contrast + 0.5);
  heat = sat01(heat + (vnoise(p / (uUnit * 40.0)) - 0.5) * 0.06);
  vec3 col = ramp(heat);
  if (p_hud == 1) {
    float w = max(1.0, uUnit * 1.2);
    vec2 c = uSize * 0.5;
    vec2 d = abs(p - c);
    float R = min(uSize.x, uSize.y) * 0.03;
    float cross_ = cover(d.x - w * 0.5) * step(d.y, R) + cover(d.y - w * 0.5) * step(d.x, R);
    col = mix(col, vec3(1.0), min(cross_, 1.0));
    // Temperature scale on the right edge.
    float bw = uSize.x * 0.018;
    float bx = uSize.x - bw * 2.5;
    float top = uSize.y * 0.2;
    float bottom = uSize.y * 0.8;
    if (p.x > bx && p.x < bx + bw && p.y > top && p.y < bottom) col = ramp(1.0 - (p.y - top) / (bottom - top));
    float h = max(7.0, uUnit * 14.0);
    float t = 18.0 + luma(srcAvg(c, R).rgb) * 22.0;
    float t10 = floor(t * 10.0);
    float reading[12] = float[12](digit(t10, 100.0), digit(t10, 10.0), ${index(".")}.0, digit(t10, 1.0), ${index("°")}.0, ${index("C")}.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0);
    col = mix(col, vec3(1.0), text(p, c + vec2(R * 1.6, -h * 1.4), h, reading));
    float hi[12] = float[12](${index("4")}.0, ${index("0")}.0, ${index("°")}.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0);
    float lo[12] = float[12](${index("1")}.0, ${index("8")}.0, ${index("°")}.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0);
    col = mix(col, vec3(1.0), text(p, vec2(bx - h * 1.9, top - h * 0.5), h * 0.8, hi));
    col = mix(col, vec3(1.0), text(p, vec2(bx - h * 1.9, bottom - h * 0.5), h * 0.8, lo));
  }
  emit(col, s.a);
}`;

const nightVision = /* glsl */ `${fx}
uniform float p_gain;
uniform float p_noise;
uniform int p_mask;
uniform float p_bloom;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  float l = luma(s.rgb) * p_gain;
  l += luma(srcLod(p, 4.0).rgb) * p_bloom * 0.6;
  l += (hash(p) - 0.5) * p_noise * 0.35 + (vnoise(p / (uUnit * 3.0)) - 0.5) * p_noise * 0.15;
  l *= 0.9 + 0.1 * cos(p.y / max(1.5, uUnit * 2.0) * TAU);
  vec3 col = vec3(0.1, 1.0, 0.25) * pow(max(l, 0.0), 0.9);
  col += vec3(0.6, 1.0, 0.6) * max(0.0, l - 0.85);
  vec2 c = uSize * 0.5;
  float R = min(uSize.x, uSize.y) * 0.5;
  float m = 1.0;
  if (p_mask == 1) m = smoothstep(R, R * 0.92, length(p - c));
  else if (p_mask == 2) {
    float r2 = R * 0.95;
    float off = min(uSize.x * 0.22, r2 * 0.75);
    m = max(smoothstep(r2, r2 * 0.92, length(p - c - vec2(off, 0.0))), smoothstep(r2, r2 * 0.92, length(p - c + vec2(off, 0.0))));
  }
  col *= m * (1.0 - 0.45 * dot((p - c) / R, (p - c) / R));
  emit(col, s.a);
}`;

const colorModes = [
  { value: "green", label: "Green" },
  { value: "amber", label: "Amber" },
  { value: "cyan", label: "Cyan" },
  { value: "photo", label: "Photo colors" },
] as const;

export const interfaceEffects: EffectDef[] = [
  {
    id: "tracking",
    name: "Tracking HUD",
    category: "Tracking & interface",
    description: "Detector brackets lock onto detailed areas, with labels and a REC counter.",
    params: [
      { key: "cell", label: "Box size", type: "number", min: 30, max: 400, step: 1, default: 130 },
      { key: "sensitivity", label: "Sensitivity", type: "number", min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: "color", label: "Color", type: "select", options: colorModes, default: "green" },
      { key: "scan", label: "Scanlines", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "labels", label: "Labels", type: "toggle", default: true },
      { key: "grid", label: "Grid", type: "toggle", default: true },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 3 },
    ],
    render(ctx, u) {
      const g = ctx.glyphs(HUD_CHARS, false);
      return ctx.pass("fx-tracking", tracking, { ...u, ...g.uniforms }, { uGlyphs: g.texture });
    },
  },
  {
    id: "thermal",
    name: "Thermal Camera",
    category: "Tracking & interface",
    description: "Brightness as heat, in iron, rainbow or white-hot palettes.",
    params: [
      {
        key: "palette",
        label: "Palette",
        type: "select",
        options: [
          { value: "iron", label: "Iron" },
          { value: "rainbow", label: "Rainbow" },
          { value: "white", label: "White hot" },
          { value: "black", label: "Black hot" },
        ],
        default: "iron",
      },
      { key: "smooth", label: "Softness", type: "number", min: 0, max: 30, step: 0.5, default: 4 },
      { key: "contrast", label: "Contrast", type: "number", min: 0.5, max: 3, step: 0.05, default: 1.3 },
      { key: "hud", label: "Readout", type: "toggle", default: true },
    ],
    render(ctx, u) {
      const g = ctx.glyphs(HUD_CHARS, false);
      return ctx.pass("fx-thermal", thermal, { ...u, ...g.uniforms }, { uGlyphs: g.texture });
    },
  },
  {
    id: "night-vision",
    name: "Night Vision",
    category: "Tracking & interface",
    description: "Green phosphor intensifier with grain and a scope mask.",
    params: [
      { key: "gain", label: "Gain", type: "number", min: 0.5, max: 4, step: 0.05, default: 1.6 },
      { key: "noise", label: "Noise", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "bloom", label: "Bloom", type: "number", min: 0, max: 1.5, step: 0.01, default: 0.5 },
      {
        key: "mask",
        label: "Scope",
        type: "select",
        options: [
          { value: "none", label: "None" },
          { value: "circle", label: "Monocular" },
          { value: "binocular", label: "Binocular" },
        ],
        default: "binocular",
      },
    ],
    render: (ctx, u) => ctx.pass("fx-night", nightVision, u),
  },
];
