import { fx } from "../glsl";
import type { EffectDef } from "../types";

const kaleido = /* glsl */ `${fx}
uniform float p_segments;
uniform float p_rotation;
uniform float p_zoom;
uniform float p_cx;
uniform float p_cy;
uniform float p_spin;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 c = vec2(p_cx, p_cy) * uSize;
  vec2 d = p - c;
  float r = length(d) / p_zoom;
  float a = atan(d.y, d.x) + radians(p_rotation) + TAU * uPhase * p_spin / floor(p_segments);
  float seg = TAU / floor(p_segments);
  a = mod(a, seg);
  a = min(a, seg - a);
  vec2 q = c + vec2(cos(a), sin(a)) * r;
  // Mirror at the image borders instead of clamping.
  q = abs(mod(q + uSize, 2.0 * uSize) - uSize);
  q = uSize - abs(q - uSize);
  emit(src(q).rgb, src(p).a);
}`;

const warp = /* glsl */ `${fx}
uniform float p_scale;
uniform float p_amount;
uniform float p_swirl;
uniform float p_smooth;
uniform float p_grain;
uniform float p_speed;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 u = p / (max(uSize.x, uSize.y) / p_scale);
  // Domain warping: noise displaces the lookup into more noise.
  vec2 flow = loopCircle(p_speed) * 0.6;
  vec2 q = vec2(fbm(u + 1.7 + flow), fbm(u + vec2(8.3, 2.8) - flow));
  vec2 r = vec2(fbm(u + 3.0 * q + vec2(1.7, 9.2) + p_swirl), fbm(u + 3.0 * q + vec2(8.3, 2.8) - p_swirl));
  vec2 offset = (r - 0.5) * p_amount * uUnit * 4.0;
  vec3 col = srcLod(p + offset, p_smooth).rgb;
  col += (frameHash(p, 24.0) - 0.5) * p_grain * 0.12;
  emit(col, src(p).a);
}`;

const aura = /* glsl */ `${fx}
uniform float p_blur;
uniform float p_flow;
uniform float p_saturation;
uniform float p_bands;
uniform float p_grain;
uniform float p_speed;
void main() {
  vec2 p = gl_FragCoord.xy;
  float L = max(uSize.x, uSize.y);
  vec2 u = p / L * 2.5;
  vec2 flow = loopCircle(p_speed) * 0.5;
  vec2 w = vec2(fbm(u + 3.1 + flow), fbm(u + vec2(5.2, 1.3) - flow)) - 0.5;
  vec3 col = srcLod(p + w * L * p_flow * 0.35, log2(L * p_blur * 0.15)).rgb;
  col = saturateColor(col, 1.0 + p_saturation);
  col = clamp((col - 0.5) * 1.15 + 0.5 + 0.03, 0.0, 1.0);
  if (p_bands >= 2.0) col = floor(col * p_bands + hash(p) * 0.5) / p_bands;
  col += (frameHash(p + 1.3, 24.0) - 0.5) * p_grain * 0.14;
  emit(col, src(p).a);
}`;

export const experimentalEffects: EffectDef[] = [
  {
    id: "kaleidoscope",
    name: "Kaleidoscope",
    category: "Experimental",
    animated: true,
    description: "Mirrored wedges spun around a center point.",
    params: [
      { key: "segments", label: "Segments", type: "number", min: 2, max: 24, step: 1, default: 8 },
      { key: "rotation", label: "Rotation", type: "number", min: 0, max: 360, step: 1, default: 0 },
      { key: "zoom", label: "Zoom", type: "number", min: 0.3, max: 4, step: 0.01, default: 1.2 },
      { key: "spin", label: "Turns per loop", type: "number", min: -4, max: 4, step: 1, default: 1 },
      { key: "cx", label: "Center X", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "cy", label: "Center Y", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    render: (ctx, u) => ctx.pass("fx-kaleido", kaleido, u),
  },
  {
    id: "liquid-warp",
    name: "Liquid Warp",
    category: "Experimental",
    animated: true,
    description: "The photo poured through flowing noise, like marbled ink.",
    params: [
      { key: "scale", label: "Scale", type: "number", min: 0.5, max: 12, step: 0.1, default: 3 },
      { key: "amount", label: "Amount", type: "number", min: 0, max: 200, step: 1, default: 45 },
      { key: "swirl", label: "Flow", type: "number", min: 0, max: 10, step: 0.05, default: 0 },
      { key: "smooth", label: "Softness", type: "number", min: 0, max: 5, step: 0.1, default: 0 },
      { key: "grain", label: "Grain", type: "number", min: 0, max: 1, step: 0.01, default: 0 },
      { key: "speed", label: "Flow (cycles per loop)", type: "number", min: 0, max: 6, step: 1, default: 1 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 2 },
    ],
    render: (ctx, u) => ctx.pass("fx-warp", warp, u),
  },
  {
    id: "aura",
    name: "Aura Gradient",
    category: "Light & glass",
    animated: true,
    description: "Melts the photo into a soft, grainy gradient of its own colors.",
    params: [
      { key: "blur", label: "Diffusion", type: "number", min: 0.05, max: 1, step: 0.01, default: 0.4 },
      { key: "flow", label: "Flow", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "saturation", label: "Saturation", type: "number", min: -1, max: 1.5, step: 0.01, default: 0.4 },
      { key: "bands", label: "Bands (0 = smooth)", type: "number", min: 0, max: 16, step: 1, default: 0 },
      { key: "grain", label: "Grain", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "speed", label: "Flow (cycles per loop)", type: "number", min: 0, max: 6, step: 1, default: 1 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 5 },
    ],
    render: (ctx, u) => ctx.pass("fx-aura", aura, u),
  },
];
