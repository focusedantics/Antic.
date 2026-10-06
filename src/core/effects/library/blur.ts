import type { Target } from "@/core/gpu/gl";
import { fx } from "../glsl";
import type { EffectContext, EffectDef } from "../types";

/**
 * Blurs. Everything here works on premultiplied colour, so soft edges and
 * transparent areas blur without dark fringes, and reads past the image's edge
 * repeat the edge pixel (the texture clamps), so borders don't darken.
 */

/** Samples the blurred texture at full size (a large blur is computed at a fraction of it). */
const resample = /* glsl */ `${fx}
uniform sampler2D uBlur;
void main() { outColor = texture(uBlur, vUv); }`;

/**
 * One box pass of a directional, zoom or spin blur: TAPS samples spread over `uSpan`
 * (pixels for a line, a scale range for zoom, radians for spin) centred on the pixel.
 * Two passes, the second over 1/TAPS of the first's span, fill the gaps between taps,
 * so a long blur is smooth without a sample per pixel of its length.
 */
const TAPS = 40;
const sweep = /* glsl */ `${fx}
uniform int uMode;      // 0 line, 1 zoom, 2 spin
uniform float uSpan;
uniform vec2 uDir;      // line direction
uniform vec2 uCenter;   // zoom and spin centre, pixels
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${TAPS}; i++) {
    float t = (float(i) + 0.5) / ${TAPS}.0 - 0.5;
    vec2 q;
    if (uMode == 0) q = p + uDir * (t * uSpan);
    else if (uMode == 1) q = uCenter + (p - uCenter) * (1.0 + t * uSpan);
    else q = uCenter + rot(t * uSpan) * (p - uCenter);
    sum += textureLod(uInput, q / uSize, 0.0);
  }
  outColor = sum / ${TAPS}.0;
}`;

/** Disc ("lens") blur on a golden-angle spiral; the mip level fills between taps; bright spots bloom into discs. */
const LENS_TAPS = 96;
const lens = /* glsl */ `${fx}
uniform float uRadius;
uniform float p_highlights;
void main() {
  vec2 p = gl_FragCoord.xy;
  float lod = log2(max(1.0, uRadius * 1.8 / sqrt(${LENS_TAPS}.0)));
  vec3 col = vec3(0.0);
  float weights = 0.0;
  float alpha = 0.0;
  for (int i = 0; i < ${LENS_TAPS}; i++) {
    float r = sqrt((float(i) + 0.5) / ${LENS_TAPS}.0) * uRadius;
    float a = float(i) * 2.39996323;
    vec4 c = textureLod(uInput, (p + vec2(cos(a), sin(a)) * r) / uSize, clamp(lod, 0.0, uMaxLod));
    vec3 straight = c.a > 1e-4 ? c.rgb / c.a : vec3(0.0);
    // Highlights weigh more, as light does through a lens.
    float w = c.a * (1.0 + p_highlights * 12.0 * pow(max(luma(straight) - 0.55, 0.0) / 0.45, 3.0));
    col += straight * w;
    weights += w;
    alpha += c.a;
  }
  alpha /= ${LENS_TAPS}.0;
  outColor = vec4((weights > 1e-5 ? col / weights : vec3(0.0)) * alpha, alpha);
}`;

/** Tilt-shift: sharp inside a band (or circle), blurring smoothly to the full amount outside it. */
const tilt = /* glsl */ `${fx}
uniform sampler2D uHalf;
uniform sampler2D uFull;
uniform float p_shape;
uniform float p_x;
uniform float p_y;
uniform float p_angle;
uniform float p_size;
uniform float p_feather;
void main() {
  vec2 p = gl_FragCoord.xy;
  float longSide = max(uSize.x, uSize.y);
  vec2 c = vec2(p_x, p_y) * 0.01 * uSize;
  float a = radians(p_angle);
  float d = p_shape < 0.5 ? abs(dot(p - c, vec2(-sin(a), cos(a)))) : length(p - c);
  float inner = p_size * 0.005 * longSide;
  float t = smoothstep(inner, inner + max(p_feather * 0.01 * longSide, 1.0), d);
  vec4 sharp = textureLod(uInput, vUv, 0.0);
  vec4 half_ = texture(uHalf, vUv);
  vec4 full = texture(uFull, vUv);
  outColor = t < 0.5 ? mix(sharp, half_, t * 2.0) : mix(half_, full, t * 2.0 - 1.0);
}`;

/** A full-size Gaussian blur of the input (sigma in working pixels). */
function gaussian(ctx: EffectContext, sigma: number): Target {
  const small = ctx.blur(ctx.input, Math.max(0, sigma));
  const out = ctx.pass("fx-blur-resample", resample, {}, { uBlur: small });
  ctx.release(small);
  return out;
}

/** Two box passes of the sweep shader (see `sweep`). */
function swept(ctx: EffectContext, mode: number, span: number, extra: Record<string, number | number[]>): Target {
  const first = ctx.pass("fx-blur-sweep", sweep, { uMode: mode, uSpan: span, ...extra });
  const out = ctx.pass("fx-blur-sweep", sweep, { uMode: mode, uSpan: span / TAPS, ...extra }, { uInput: first });
  ctx.release(first);
  return out;
}

const centre = [
  { key: "x", label: "Centre across", short: "Across", type: "number", min: 0, max: 100, step: 1, default: 50 },
  { key: "y", label: "Centre down", short: "Down", type: "number", min: 0, max: 100, step: 1, default: 50 },
] as const;

export const blurEffects: EffectDef[] = [
  {
    id: "blur",
    name: "Gaussian Blur",
    category: "Blur",
    description: "An even, soft blur. Clip it to a layer to blur just that layer.",
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 0.5, default: 10 }],
    render: (ctx, _u, params) => gaussian(ctx, Number(params.amount) * ctx.unit),
  },
  {
    id: "lens-blur",
    name: "Lens Blur",
    category: "Blur",
    description: "The round, creamy blur of a wide-open lens; highlights bloom into discs.",
    params: [
      { key: "radius", label: "Radius", type: "number", min: 0, max: 100, step: 0.5, default: 18 },
      { key: "highlights", label: "Bright highlights", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
    ],
    render: (ctx, u, params) => ctx.pass("fx-lens-blur", lens, { ...u, uRadius: Number(params.radius) * ctx.unit }),
  },
  {
    id: "motion-blur",
    name: "Motion Blur",
    category: "Blur",
    description: "Streaks along one direction, like a moving camera or subject.",
    params: [
      { key: "distance", label: "Distance", type: "number", min: 0, max: 300, step: 1, default: 60 },
      { key: "angle", label: "Angle", type: "number", min: -180, max: 180, step: 1, default: 0 },
    ],
    render(ctx, _u, params) {
      // Angles turn counter-clockwise from the right; rows run down the image.
      const a = (Number(params.angle) * Math.PI) / 180;
      return swept(ctx, 0, Number(params.distance) * ctx.unit, { uDir: [Math.cos(a), -Math.sin(a)], uCenter: [0, 0] });
    },
  },
  {
    id: "zoom-blur",
    name: "Zoom Blur",
    category: "Blur",
    description: "Rushes out from a centre point, like zooming during the exposure.",
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, default: 25 }, ...centre],
    render: (ctx, _u, params) =>
      swept(ctx, 1, Number(params.amount) / 100, { uDir: [1, 0], uCenter: [(Number(params.x) / 100) * ctx.width, (Number(params.y) / 100) * ctx.height] }),
  },
  {
    id: "spin-blur",
    name: "Spin Blur",
    category: "Blur",
    description: "Turns around a centre point, like a spinning wheel.",
    params: [{ key: "angle", label: "Angle", type: "number", min: 0, max: 90, step: 0.5, default: 12 }, ...centre],
    render: (ctx, _u, params) =>
      swept(ctx, 2, (Number(params.angle) * Math.PI) / 180, { uDir: [1, 0], uCenter: [(Number(params.x) / 100) * ctx.width, (Number(params.y) / 100) * ctx.height] }),
  },
  {
    id: "tilt-shift",
    name: "Tilt-Shift",
    category: "Blur",
    description: "Keeps a band (or a circle) sharp and blurs the rest: the miniature look.",
    params: [
      {
        key: "shape",
        label: "Sharp area",
        type: "select",
        options: [
          { value: "band", label: "Band" },
          { value: "circle", label: "Circle" },
        ],
        default: "band",
      },
      { key: "amount", label: "Blur", type: "number", min: 0, max: 100, step: 0.5, default: 16 },
      { key: "size", label: "Sharp size", type: "number", min: 0, max: 100, step: 1, default: 20 },
      { key: "feather", label: "Transition", type: "number", min: 0, max: 100, step: 1, default: 25 },
      { ...centre[0], label: "Position across", short: "Across" },
      { ...centre[1], label: "Position down", short: "Down", default: 55 },
      { key: "angle", label: "Angle", type: "number", min: -90, max: 90, step: 1, default: 0, showIf: { key: "shape", equals: "band" } },
    ],
    render(ctx, u, params) {
      const sigma = Number(params.amount) * ctx.unit;
      const half = ctx.blur(ctx.input, sigma / 2);
      const full = ctx.blur(ctx.input, sigma);
      const out = ctx.pass("fx-tilt-shift", tilt, u, { uHalf: half, uFull: full });
      ctx.release(half);
      ctx.release(full);
      return out;
    },
  },
];
