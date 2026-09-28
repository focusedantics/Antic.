import { fx } from "../glsl";
import type { EffectDef } from "../types";

/** Two blurs of the input feed a difference-of-Gaussians edge detector. */
const dog = /* glsl */ `
uniform sampler2D uBlurA;
uniform sampler2D uBlurB;
float lumaOf(sampler2D t, vec2 p) { return luma(unpremul(texture(t, p / uSize)).rgb); }
/** 0..1 ink where the image is darker than its surroundings. */
float dogInk(vec2 p, float threshold, float softness) {
  float d = lumaOf(uBlurB, p) - lumaOf(uBlurA, p);
  return smoothstep(threshold, threshold + softness, d);
}
`;

const ink = /* glsl */ `${fx}${dog}
uniform float p_weight;
uniform float p_wash;
uniform float p_shading;
uniform vec3 p_ink;
uniform vec3 p_paper;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  float t = mix(0.03, 0.002, p_weight);
  float lines = dogInk(p, t, t * 1.5);
  vec3 paper = p_paper * (0.95 + 0.05 * fbm(p / (uUnit * 2.5)));
  // Optional watercolor wash from the softened photo, pooling at its edges.
  vec3 wash = unpremul(texture(uBlurB, p / uSize)).rgb;
  wash = mix(paper, saturateColor(wash, 1.2) * paper, p_wash * (0.8 + 0.4 * fbm(p / (uUnit * 12.0))));
  float l = luma(srcAvg(p, uUnit * 2.0).rgb);
  // Sparse diagonal hatching in the shadows.
  float hatch = 0.0;
  if (p_shading > 0.0) {
    float spacing = max(2.0, uUnit * 3.5);
    float v = abs(fract((p.x + p.y) / spacing) - 0.5) * spacing;
    hatch = cover(v - (1.0 - smoothstep(0.1, 0.45, l)) * spacing * 0.35) * p_shading * (1.0 - smoothstep(0.1, 0.45, l));
  }
  emit(mix(wash, p_ink, max(lines, hatch * 0.8)), s.a);
}`;

const neonPrep = /* glsl */ `${fx}
uniform float p_threshold;
uniform int p_color;
uniform vec3 p_tint;
vec2 gradient(vec2 p, float e, float lod) {
  float tl = luma(srcLod(p + vec2(-e, -e), lod).rgb), t = luma(srcLod(p + vec2(0.0, -e), lod).rgb), tr = luma(srcLod(p + vec2(e, -e), lod).rgb);
  float l = luma(srcLod(p + vec2(-e, 0.0), lod).rgb), r = luma(srcLod(p + vec2(e, 0.0), lod).rgb);
  float bl = luma(srcLod(p + vec2(-e, e), lod).rgb), b = luma(srcLod(p + vec2(0.0, e), lod).rgb), br = luma(srcLod(p + vec2(e, e), lod).rgb);
  return vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, bl + 2.0 * b + br - tl - 2.0 * t - tr);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float e = max(1.0, uUnit * 1.5);
  float lod = log2(e) + 0.5;
  vec2 g = gradient(p, e, lod);
  float mag = length(g);
  // Thin the edges: keep only ridge pixels along the gradient direction.
  vec2 n = g / max(mag, 1e-5);
  float ahead = length(gradient(p + n * e, e, lod));
  float behind = length(gradient(p - n * e, e, lod));
  float ridge = smoothstep(0.0, 0.08, mag - max(ahead, behind) * 0.97);
  float m = smoothstep(p_threshold, p_threshold * 1.6 + 0.02, mag) * ridge;
  vec3 s = src(p).rgb;
  vec3 c;
  if (p_color == 0) c = saturateColor(s, 2.2) / max(0.3, max(s.r, max(s.g, s.b)));
  else if (p_color == 1) c = hsv2rgb(vec3(atan(g.y, g.x) / TAU + 0.5, 0.85, 1.0));
  else c = p_tint;
  outColor = vec4(clamp(c, 0.0, 1.0) * m, 1.0);
}`;

const neon = /* glsl */ `${fx}
uniform sampler2D uEdges;
uniform sampler2D uGlowA;
uniform sampler2D uGlowB;
uniform float p_glow;
uniform float p_dim;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 core = texture(uEdges, uv).rgb;
  vec3 glow = texture(uGlowA, uv).rgb * 0.8 + texture(uGlowB, uv).rgb * 1.2;
  vec3 base = src(gl_FragCoord.xy).rgb * p_dim;
  vec3 col = base + core + glow * p_glow;
  // Hot cores turn white like a real tube.
  col += vec3(max(0.0, luma(core) - 0.7)) * 0.8;
  emit(col, src(gl_FragCoord.xy).a);
}`;

const contours = /* glsl */ `${fx}
uniform sampler2D uBlur;
uniform float p_levels;
uniform float p_width;
uniform int p_style;
uniform int p_index;
uniform vec3 p_ink;
uniform vec3 p_paper;
vec3 hypsometric(float t) {
  vec3 a = vec3(0.16, 0.36, 0.3), b = vec3(0.55, 0.7, 0.42), c = vec3(0.91, 0.84, 0.6), d = vec3(0.72, 0.52, 0.36), e = vec3(0.97, 0.96, 0.94);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.8) return mix(c, d, (t - 0.5) / 0.3);
  return mix(d, e, (t - 0.8) / 0.2);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 b = unpremul(texture(uBlur, p / uSize));
  float h = luma(b.rgb) * p_levels;
  float fw = max(fwidth(h), 1e-4);
  float dist = abs(fract(h + 0.5) - 0.5) / fw;
  float level = floor(h + 0.5);
  float w = p_width * max(uUnit, 0.5);
  if (p_index == 1 && mod(level, 5.0) == 0.0) w *= 2.2;
  float line = 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, dist);
  float band = floor(h) / max(p_levels - 1.0, 1.0);
  vec3 col;
  if (p_style == 0) col = mix(p_paper, p_ink, line);
  else if (p_style == 1) col = mix(hypsometric(band), vec3(0.28, 0.2, 0.14), line * 0.85);
  else if (p_style == 2) col = mix(vec3(0.02, 0.02, 0.05), hsv2rgb(vec3(0.55 + band * 0.45, 0.8, 1.0)), line);
  else col = mix(b.rgb * 0.35, saturateColor(b.rgb, 1.4) * 1.3 + 0.1, line);
  emit(col, src(p).a);
}`;

const blueprint = /* glsl */ `${fx}${dog}
uniform float p_grid;
uniform float p_weight;
uniform float p_fill;
uniform vec3 p_paper;
void main() {
  vec2 p = gl_FragCoord.xy;
  float g = max(4.0, p_grid * uUnit);
  vec2 f = abs(fract(p / g + 0.5) - 0.5) * g;
  vec2 F = abs(fract(p / (g * 5.0) + 0.5) - 0.5) * g * 5.0;
  float minor = cover(min(f.x, f.y) - 0.35);
  float major = cover(min(F.x, F.y) - 0.8);
  float t = mix(0.03, 0.002, p_weight);
  float lines = dogInk(p, t, t * 1.5);
  float l = luma(srcAvg(p, uUnit * 3.0).rgb);
  vec3 col = p_paper * (0.92 + 0.08 * fbm(p / (uUnit * 20.0)));
  col = mix(col, vec3(0.85, 0.92, 1.0), minor * 0.12 + major * 0.25);
  col = mix(col, vec3(0.9, 0.95, 1.0), (1.0 - l) * p_fill * 0.25);
  col = mix(col, vec3(0.96, 0.98, 1.0), lines);
  emit(col, src(p).a);
}`;

const pencil = /* glsl */ `${fx}${dog}
uniform float p_spacing;
uniform float p_angle;
uniform int p_outline;
uniform vec3 p_ink;
uniform vec3 p_paper;
float hatch(vec2 p, float angle, float spacing, float amount, float salt) {
  vec2 n = vec2(-sin(angle), cos(angle));
  float wobble = (vnoise(p / (spacing * 8.0) + salt) - 0.5) * spacing * 0.8;
  float y = (dot(p, n) + wobble) / spacing;
  float v = abs(fract(y) - 0.5) * spacing;
  // Strokes vary in pressure along their length.
  float pressure = 0.55 + 0.45 * vnoise(vec2(dot(p, vec2(n.y, -n.x)) / (spacing * 6.0), floor(y) + salt));
  return cover(v - spacing * 0.18) * amount * pressure;
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float spacing = max(2.0, p_spacing * uUnit);
  float l = luma(srcAvg(p, spacing).rgb);
  float a = radians(p_angle);
  float tone = 0.0;
  tone = max(tone, hatch(p, a, spacing, smoothstep(0.85, 0.65, l), 1.0));
  tone = max(tone, hatch(p, a + 1.5708, spacing, smoothstep(0.6, 0.42, l), 2.0));
  tone = max(tone, hatch(p, a + 0.7854, spacing * 0.8, smoothstep(0.4, 0.22, l), 3.0));
  tone = max(tone, hatch(p, a - 0.7854, spacing * 0.7, smoothstep(0.22, 0.05, l), 4.0));
  if (p_outline == 1) tone = max(tone, dogInk(p, 0.006, 0.012) * 0.9);
  float grain = fbm(p / max(uUnit * 0.6, 0.6));
  vec3 paper = p_paper * (0.94 + 0.06 * grain);
  // Graphite catches on the paper tooth.
  emit(mix(paper, p_ink, tone * (0.65 + 0.35 * grain)), src(p).a);
}`;

function withDog(ctx: Parameters<EffectDef["render"]>[0], detail: number) {
  const s = Math.max(0.5, detail * ctx.unit);
  return { a: ctx.blur(ctx.input, s), b: ctx.blur(ctx.input, s * 1.6) };
}

export const edgeEffects: EffectDef[] = [
  {
    id: "ink",
    name: "Ink Drawing",
    category: "Edges & outlines",
    description: "Pen outlines on paper, with an optional watercolor wash.",
    params: [
      { key: "detail", label: "Line size", type: "number", min: 0.4, max: 8, step: 0.1, default: 1.4 },
      { key: "weight", label: "Line amount", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: "wash", label: "Watercolor", type: "number", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "shading", label: "Hatching", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "ink", label: "Ink", type: "color", default: "#1a1a22" },
      { key: "paper", label: "Paper", type: "color", default: "#f6f2e8" },
    ],
    render(ctx, u, params) {
      const { a, b } = withDog(ctx, Number(params.detail));
      const out = ctx.pass("fx-ink", ink, u, { uBlurA: a, uBlurB: b });
      ctx.release(a);
      ctx.release(b);
      return out;
    },
  },
  {
    id: "neon",
    name: "Neon Edges",
    category: "Edges & outlines",
    description: "Edges traced as glowing tubes of light.",
    params: [
      { key: "threshold", label: "Threshold", type: "number", min: 0.02, max: 1, step: 0.01, default: 0.4 },
      { key: "glow", label: "Glow", type: "number", min: 0, max: 3, step: 0.05, default: 0.8 },
      { key: "radius", label: "Glow size", type: "number", min: 1, max: 40, step: 0.5, default: 8 },
      {
        key: "color",
        label: "Color",
        type: "select",
        options: [
          { value: "photo", label: "Photo colors" },
          { value: "rainbow", label: "Rainbow by direction" },
          { value: "tint", label: "Single color" },
        ],
        default: "photo",
      },
      { key: "tint", label: "Tube color", type: "color", default: "#39d7ff" },
      { key: "dim", label: "Photo underneath", type: "number", min: 0, max: 0.6, step: 0.01, default: 0.04 },
    ],
    render(ctx, u, params) {
      const edges = ctx.pass("fx-neon-prep", neonPrep, u);
      const r = Number(params.radius) * ctx.unit;
      const ga = ctx.blur(edges, Math.max(1, r * 0.35));
      const gb = ctx.blur(edges, Math.max(1, r));
      const out = ctx.pass("fx-neon", neon, u, { uEdges: edges, uGlowA: ga, uGlowB: gb });
      ctx.release(edges);
      ctx.release(ga);
      ctx.release(gb);
      return out;
    },
  },
  {
    id: "contours",
    name: "Topographic",
    category: "Edges & outlines",
    description: "Brightness read as elevation and drawn as contour lines.",
    params: [
      { key: "levels", label: "Contours", type: "number", min: 4, max: 80, step: 1, default: 26 },
      { key: "smooth", label: "Smoothness", type: "number", min: 1, max: 40, step: 0.5, default: 6 },
      { key: "width", label: "Line width", type: "number", min: 0.3, max: 5, step: 0.05, default: 1 },
      {
        key: "style",
        label: "Style",
        type: "select",
        options: [
          { value: "ink", label: "Ink on paper" },
          { value: "map", label: "Relief map" },
          { value: "neon", label: "Neon" },
          { value: "photo", label: "Photo colors" },
        ],
        default: "ink",
      },
      { key: "index", label: "Index lines", type: "toggle", default: true },
      { key: "ink", label: "Ink", type: "color", default: "#3a2a1c" },
      { key: "paper", label: "Paper", type: "color", default: "#f1ebdc" },
    ],
    render(ctx, u, params) {
      const blur = ctx.blur(ctx.input, Math.max(0.5, Number(params.smooth) * ctx.unit));
      const out = ctx.pass("fx-contours", contours, u, { uBlur: blur });
      ctx.release(blur);
      return out;
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    category: "Edges & outlines",
    description: "White linework on drafting blue with a measured grid.",
    params: [
      { key: "grid", label: "Grid", type: "number", min: 5, max: 80, step: 1, default: 20 },
      { key: "detail", label: "Line size", type: "number", min: 0.4, max: 8, step: 0.1, default: 1.2 },
      { key: "weight", label: "Line amount", type: "number", min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: "fill", label: "Shading", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "paper", label: "Paper", type: "color", default: "#1c4a8a" },
    ],
    render(ctx, u, params) {
      const { a, b } = withDog(ctx, Number(params.detail));
      const out = ctx.pass("fx-blueprint", blueprint, u, { uBlurA: a, uBlurB: b });
      ctx.release(a);
      ctx.release(b);
      return out;
    },
  },
  {
    id: "pencil",
    name: "Pencil Hatching",
    category: "Edges & outlines",
    description: "Layered graphite hatching that darkens with the shadows.",
    params: [
      { key: "spacing", label: "Stroke spacing", type: "number", min: 1.5, max: 20, step: 0.25, default: 4 },
      { key: "angle", label: "Angle", type: "number", min: -90, max: 90, step: 1, default: 40 },
      { key: "outline", label: "Outlines", type: "toggle", default: true },
      { key: "ink", label: "Graphite", type: "color", default: "#2b2b30" },
      { key: "paper", label: "Paper", type: "color", default: "#f4f1ea" },
    ],
    render(ctx, u) {
      const { a, b } = withDog(ctx, 1.2);
      const out = ctx.pass("fx-pencil", pencil, u, { uBlurA: a, uBlurB: b });
      ctx.release(a);
      ctx.release(b);
      return out;
    },
  },
];
