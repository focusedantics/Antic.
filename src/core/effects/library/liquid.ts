import { fx } from "../glsl";
import type { EffectDef } from "../types";

/*
 * Liquid glass and liquid metal. Original shaders written for Focused; the looks
 * were inspired by liquid-glass-js (dashersw, MIT: edge refraction, rim light,
 * frosted blur), liquid-logo (collidingScopes, MIT: flowing metal over a shape)
 * and shadergradient (ruucm, MIT: noise-driven colour flow). No code was copied.
 */

/**
 * Glass shading shared by the glass effects. The including shader defines
 * `float sceneC(vec2 p, out vec2 center)`: a signed distance in pixels (negative
 * inside the glass) and the point the glass magnifies around.
 */
const glassCore = /* glsl */ `
uniform float p_refraction;
uniform float p_bevel;
uniform float p_frost;
uniform float p_dispersion;
uniform float p_rim;
uniform float p_light;
uniform vec3 p_tint;
uniform float p_tintAmount;
uniform float p_shadow;
float scene(vec2 p) { vec2 c; return sceneC(p, c); }
void main() {
  vec2 p = gl_FragCoord.xy;
  float bevel = max(2.0, p_bevel * uUnit);
  vec2 center;
  float d = sceneC(p, center);
  vec4 base = src(p);
  // A soft shadow under the glass, offset away from the light.
  vec2 L = vec2(cos(radians(p_light)), -sin(radians(p_light)));
  float ds = scene(p + L * bevel * 0.45);
  float shadow = p_shadow * 0.5 * (1.0 - smoothstep(-bevel * 0.2, bevel * 1.3, ds));
  vec3 bg = base.rgb * (1.0 - shadow);
  if (d > 1.5) { emit(bg, base.a); return; }
  vec2 g = vec2(scene(p + vec2(1.0, 0.0)) - scene(p - vec2(1.0, 0.0)), scene(p + vec2(0.0, 1.0)) - scene(p - vec2(0.0, 1.0)));
  vec2 n = dot(g, g) > 1e-8 ? normalize(g) : vec2(0.0);
  // 0 at the rim, 1 once past the bevel: a rounded edge that bends light the most.
  float depth = clamp(-d / bevel, 0.0, 1.0);
  float slope = pow(1.0 - depth, 2.2);
  vec2 offset = -n * slope * bevel * 0.9 * p_refraction + (center - p) * 0.07 * p_refraction;
  float lod = p_frost * 6.0;
  vec3 col;
  col.r = srcLod(p + offset * (1.0 + p_dispersion * 3.0), lod).r;
  col.g = srcLod(p + offset, lod).g;
  col.b = srcLod(p + offset * (1.0 - p_dispersion * 3.0), lod).b;
  col = mix(col, p_tint, p_tintAmount);
  col = col * (1.0 + 0.05 * slope) + 0.03 * slope;
  // Rim light where the bevel faces the light, a fainter one opposite, and a thin bright edge.
  float facing = dot(n, L);
  float band = 1.0 - smoothstep(0.0, bevel * 0.6, -d);
  col += p_rim * band * (pow(max(-facing, 0.0), 5.0) * 0.85 + pow(max(facing, 0.0), 5.0) * 0.3);
  col += p_rim * 0.35 * exp(min(d, 0.0) / 1.4);
  float cov = cover(d);
  emit(mix(bg, col, cov), max(base.a, cov));
}`;

const sdRound = /* glsl */ `
float sdRound(vec2 q, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 k = abs(q) - b + r;
  return length(max(k, 0.0)) + min(max(k.x, k.y), 0.0) - r;
}`;

const liquidGlass = /* glsl */ `${fx}${sdRound}
uniform int p_shape;
uniform float p_size;
uniform float p_cx;
uniform float p_cy;
uniform float p_corner;
float sceneC(vec2 p, out vec2 center) {
  float s = min(uSize.x, uSize.y);
  center = vec2(p_cx, p_cy) * uSize;
  if (p_shape == 3) {
    float cell = max(8.0, p_size * s * 0.3);
    center = (floor(p / cell) + 0.5) * cell;
    vec2 b = vec2(cell * 0.42);
    return sdRound(p - center, b, b.x * p_corner);
  }
  if (p_shape == 4) {
    // A glass frame around the whole picture.
    center = p;
    vec2 h = uSize * 0.5;
    float border = max(4.0, p_size * s * 0.18);
    return max(sdRound(p - h, h + 2.0, 0.0), -sdRound(p - h, h - border, border * 2.0 * p_corner));
  }
  vec2 q = p - center;
  if (p_shape == 1) return length(q) - p_size * s * 0.5;
  if (p_shape == 2) { vec2 b = vec2(p_size * s * 0.5); return sdRound(q, b, b.x * p_corner); }
  vec2 b = vec2(1.35, 0.5) * p_size * s * 0.5;
  return sdRound(q, b, b.y * mix(0.3, 1.0, p_corner));
}
${glassCore}`;

const glassBlobs = /* glsl */ `${fx}
uniform float p_count;
uniform float p_size;
uniform float p_blend;
uniform float p_speed;
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sceneC(vec2 p, out vec2 center) {
  float s = min(uSize.x, uSize.y);
  float d = 1e9;
  // The magnifying center blends between nearby blobs, so merged drops have no seam.
  vec2 sumC = vec2(0.0);
  float sumW = 0.0;
  float k = max(1.0, p_blend * s * 0.2);
  for (int i = 0; i < 8; i++) {
    if (float(i) >= p_count) break;
    float fi = float(i);
    vec2 home = vec2(0.18 + 0.64 * hash(vec2(fi, 1.7)), 0.2 + 0.6 * hash(vec2(fi, 8.3))) * uSize;
    // Whole turns per loop (alternating directions), so the motion loops seamlessly.
    float turns = p_speed * (1.0 + mod(fi, 2.0)) * (mod(fi, 3.0) == 0.0 ? -1.0 : 1.0);
    float a = TAU * (uPhase * turns + hash(vec2(fi, 3.1)));
    vec2 pos = home + vec2(cos(a), sin(2.0 * a) * 0.6) * s * 0.12;
    float r = p_size * s * 0.5 * (0.55 + 0.6 * hash(vec2(fi, 5.9)));
    float di = length(p - pos) - r;
    float wgt = exp(-clamp(di / (k + r * 0.5), -4.0, 8.0));
    sumC += pos * wgt;
    sumW += wgt;
    d = i == 0 ? di : smin(d, di, k);
  }
  center = sumW > 0.0 ? sumC / sumW : p;
  return d;
}
${glassCore}`;

const liquidMetal = /* glsl */ `${fx}
uniform int p_metal;
uniform vec3 p_color;
uniform float p_flow;
uniform float p_scale;
uniform float p_relief;
uniform float p_smooth;
uniform float p_ripples;
uniform int p_shape;
uniform float p_threshold;
uniform float p_photo;
uniform vec3 p_background;
uniform float p_speed;
vec2 flowAt(vec2 p) {
  float sc = max(4.0, p_scale * uUnit);
  vec2 q = p / sc;
  vec2 w = vec2(loopNoise(q, 1.2, p_speed), loopNoise(q + 19.7, 1.2, p_speed)) - 0.5;
  w += 0.5 * (vec2(loopNoise(q * 2.3 + 7.1, 1.6, p_speed * 2.0), loopNoise(q * 2.3 + 31.0, 1.6, p_speed * 2.0)) - 0.5);
  return p + w * p_flow * sc * 1.6;
}
float shapeOf(float l) {
  if (p_shape == 0) return 1.0;
  float m = smoothstep(p_threshold - 0.06, p_threshold + 0.06, l);
  return p_shape == 1 ? m : 1.0 - m;
}
/** Height of the liquid surface: the (smoothed) picture, shaped and rippled. */
float heightAt(vec2 p, float soft) {
  vec2 w = flowAt(p);
  float l = luma(srcAvg(w, soft).rgb);
  float shape = shapeOf(luma(srcAvg(w, soft * 2.0).rgb));
  float h = mix(l, 0.6, 0.35) * shape + shape * 0.35;
  h += p_ripples * 0.12 * sin((l * 5.0 + loopNoise(w / max(4.0, p_scale * uUnit) * 0.7, 0.8, p_speed)) * TAU);
  return h;
}
/** A studio environment: bright sky softboxes above a dark horizon and a dim floor. */
vec3 studio(vec3 r) {
  float up = -r.y;
  vec3 sky = mix(vec3(0.55, 0.58, 0.62), vec3(0.98), smoothstep(0.0, 0.9, up));
  vec3 floorC = mix(vec3(0.05), vec3(0.22), smoothstep(-1.0, -0.1, up));
  vec3 c = mix(floorC, sky, smoothstep(-0.04, 0.06, up));
  c -= 0.45 * exp(-abs(up - 0.02) * 26.0);
  c += 0.9 * pow(max(0.0, 1.0 - abs(up - 0.55) * 4.0), 3.0) * (0.6 + 0.4 * sin(r.x * 9.0));
  c += 0.6 * pow(max(0.0, 1.0 - abs(r.x - 0.6) * 5.0), 4.0) * smoothstep(-0.2, 0.4, up);
  return max(c, 0.0);
}
vec3 metalColor(vec3 env, vec3 n, float h) {
  float lum = luma(env);
  if (p_metal == 1) return env * vec3(1.0, 0.8, 0.42) + vec3(0.12, 0.08, 0.0) * lum;
  if (p_metal == 2) return env * vec3(0.98, 0.58, 0.42);
  if (p_metal == 3) return mix(env * vec3(0.62, 0.66, 0.78), hsv2rgb(vec3(0.62 + 0.25 * n.x, 0.45, lum)), 0.35);
  if (p_metal == 4) {
    // Thin-film iridescence: hue follows the surface angle and height.
    vec3 film = hsv2rgb(vec3(fract(0.55 + n.x * 0.35 + n.y * 0.25 + h * 0.9 + uPhase * p_speed), 0.55, 1.0));
    return env * mix(vec3(1.0), film, 0.75) + 0.08 * film;
  }
  if (p_metal == 5) return env * p_color * 1.15;
  return env;
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float soft = max(1.0, p_smooth * uUnit);
  float e = soft * 0.6;
  float hx = heightAt(p + vec2(e, 0.0), soft) - heightAt(p - vec2(e, 0.0), soft);
  float hy = heightAt(p + vec2(0.0, e), soft) - heightAt(p - vec2(0.0, e), soft);
  float h = heightAt(p, soft);
  vec3 n = normalize(vec3(-hx, -hy, 0.12 / max(p_relief, 0.05)));
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  vec3 env = studio(r);
  vec3 metal = metalColor(env, n, h);
  // Brighter at grazing angles, like polished metal.
  metal += pow(1.0 - n.z, 3.0) * 0.35;
  vec2 w = flowAt(p);
  vec4 photo = srcAvg(w, 1.0);
  metal = mix(metal, metal * clamp(photo.rgb * 1.6, 0.0, 1.5), p_photo);
  float shape = shapeOf(luma(srcAvg(w, soft * 2.0).rgb));
  vec3 col = mix(p_background, metal, shape);
  emit(col, src(p).a);
}`;

const glassParams = [
  { key: "refraction", label: "Refraction", type: "number", min: 0, max: 2.5, step: 0.01, default: 1 },
  { key: "bevel", label: "Edge width", type: "number", min: 2, max: 200, step: 1, default: 45 },
  { key: "frost", label: "Frost", type: "number", min: 0, max: 1, step: 0.01, default: 0.15 },
  { key: "dispersion", label: "Color fringe", type: "number", min: 0, max: 0.3, step: 0.005, default: 0.06 },
  { key: "rim", label: "Rim light", type: "number", min: 0, max: 1.5, step: 0.01, default: 0.6 },
  { key: "light", label: "Light angle", type: "number", min: 0, max: 360, step: 1, default: 135 },
  { key: "tint", label: "Tint", type: "color", default: "#ffffff" },
  { key: "tintAmount", label: "Tint amount", type: "number", min: 0, max: 1, step: 0.01, default: 0.08 },
  { key: "shadow", label: "Shadow", type: "number", min: 0, max: 1, step: 0.01, default: 0.35 },
] as const;

export const liquidEffects: EffectDef[] = [
  {
    id: "liquid-glass",
    name: "Liquid Glass",
    category: "Light & glass",
    description: "A pane of thick, rounded glass over the photo: bent edges, frost, color fringes and a rim of light.",
    params: [
      {
        key: "shape",
        label: "Shape",
        type: "select",
        options: [
          { value: "pill", label: "Pill" },
          { value: "circle", label: "Circle" },
          { value: "square", label: "Rounded square" },
          { value: "tiles", label: "Tiles" },
          { value: "frame", label: "Frame" },
        ],
        default: "pill",
      },
      { key: "size", label: "Size", type: "number", min: 0.05, max: 1.2, step: 0.01, default: 0.55 },
      { key: "cx", label: "Center X", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "cy", label: "Center Y", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "corner", label: "Roundness", type: "number", min: 0, max: 1, step: 0.01, default: 1 },
      ...glassParams,
    ],
    render: (ctx, u) => ctx.pass("fx-liquid-glass", liquidGlass, u),
  },
  {
    id: "glass-blobs",
    name: "Glass Blobs",
    category: "Light & glass",
    animated: true,
    description: "Drops of liquid glass drift over the photo and melt into each other.",
    params: [
      { key: "count", label: "Blobs", type: "number", min: 1, max: 8, step: 1, default: 4 },
      { key: "size", label: "Size", type: "number", min: 0.05, max: 0.8, step: 0.01, default: 0.3 },
      { key: "blend", label: "Merge", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      ...glassParams,
      { key: "speed", label: "Drift (cycles per loop)", short: "Drift", type: "number", min: 0, max: 4, step: 1, default: 1 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 3 },
    ],
    render: (ctx, u) => ctx.pass("fx-glass-blobs", glassBlobs, u),
  },
  {
    id: "liquid-metal",
    name: "Liquid Metal",
    category: "Light & glass",
    animated: true,
    description: "The photo poured as flowing chrome, gold or iridescent metal that reflects a studio.",
    params: [
      {
        key: "metal",
        label: "Metal",
        type: "select",
        options: [
          { value: "chrome", label: "Chrome" },
          { value: "gold", label: "Gold" },
          { value: "copper", label: "Copper" },
          { value: "titanium", label: "Titanium" },
          { value: "iridescent", label: "Iridescent" },
          { value: "custom", label: "Custom" },
        ],
        default: "chrome",
      },
      { key: "color", label: "Custom color", type: "color", default: "#9ad0ff", showIf: { key: "metal", equals: "custom" } },
      {
        key: "shape",
        label: "Pour into",
        type: "select",
        options: [
          { value: "all", label: "Whole picture" },
          { value: "bright", label: "Bright parts" },
          { value: "dark", label: "Dark parts" },
        ],
        default: "all",
      },
      { key: "threshold", label: "Threshold", type: "number", min: 0.05, max: 0.95, step: 0.01, default: 0.5, showIf: { key: "shape", not: "all" } },
      { key: "background", label: "Background", type: "color", default: "#0b0b0c" },
      { key: "flow", label: "Flow", type: "number", min: 0, max: 2, step: 0.01, default: 0.5 },
      { key: "scale", label: "Flow scale", type: "number", min: 10, max: 600, step: 1, default: 160 },
      { key: "relief", label: "Relief", type: "number", min: 0.1, max: 4, step: 0.05, default: 1.2 },
      { key: "smooth", label: "Smoothness", type: "number", min: 1, max: 60, step: 0.5, default: 10 },
      { key: "ripples", label: "Ripples", type: "number", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "photo", label: "Photo colors", type: "number", min: 0, max: 1, step: 0.01, default: 0 },
      { key: "speed", label: "Flow (cycles per loop)", short: "Speed", type: "number", min: 0, max: 4, step: 1, default: 1 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 4 },
    ],
    initial: { post_bloom: true, post_threshold: 0.6, post_intensity: 0.8 },
    render: (ctx, u) => ctx.pass("fx-liquid-metal", liquidMetal, u),
  },
];
