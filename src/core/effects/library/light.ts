import { fx } from "../glsl";
import type { EffectDef } from "../types";

const fluted = /* glsl */ `${fx}
uniform float p_width;
uniform float p_strength;
uniform int p_shape;
uniform float p_frost;
uniform float p_dispersion;
uniform float p_highlight;
uniform float p_angle;
/** Surface normal (xy) of the glass and a 0..1 coordinate across the current rib. */
vec2 normalAt(vec2 p, float w, out float across) {
  vec2 c = uSize * 0.5;
  vec2 q = rot(radians(p_angle)) * (p - c);
  if (p_shape == 0) { float x = fract(q.x / w) * 2.0 - 1.0; across = x; return vec2(x, 0.0); }
  if (p_shape == 1) { vec2 f = fract(q / w) * 2.0 - 1.0; across = max(abs(f.x), abs(f.y)); return f * 0.8; }
  if (p_shape == 2) { float r = length(q); float x = fract(r / w) * 2.0 - 1.0; across = x; return normalize(q + 1e-4) * x; }
  float r = length(q);
  float wave = sin(r / w * TAU) * exp(-r / (w * 14.0));
  across = wave;
  return normalize(q + 1e-4) * wave * 0.8;
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float w = max(3.0, p_width * uUnit);
  float across;
  vec2 n = normalAt(p, w, across);
  mat2 back = transpose(rot(radians(p_angle)));
  // Each rib magnifies a narrow slice of what is behind it.
  vec2 offset = back * (-n * p_strength * w * 0.35);
  float lod = p_frost * 5.0;
  vec3 col;
  col.r = srcLod(p + offset * (1.0 + p_dispersion), lod).r;
  col.g = srcLod(p + offset, lod).g;
  col.b = srcLod(p + offset * (1.0 - p_dispersion), lod).b;
  // Specular streak and darker rib edges (more glass to look through at a grazing angle).
  float spec = pow(max(0.0, 1.0 - abs(across - 0.35) * 3.0), 3.0) * p_highlight;
  float edge = smoothstep(0.75, 1.0, abs(across));
  col = col * (1.0 - 0.25 * edge) + spec * 0.35;
  emit(col, src(p).a);
}`;

const glowBright = /* glsl */ `${fx}
uniform float p_threshold;
void main() {
  vec4 c = src(gl_FragCoord.xy);
  vec3 b = max(c.rgb - p_threshold, 0.0) / max(1.0 - p_threshold, 0.05);
  outColor = vec4(b * c.a, 1.0);
}`;

const glow = /* glsl */ `${fx}
uniform sampler2D uSmall;
uniform sampler2D uLarge;
uniform float p_intensity;
uniform vec3 p_tint;
uniform float p_soften;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / uSize;
  vec4 s = src(p);
  vec3 base = mix(s.rgb, srcLod(p, 2.5).rgb, p_soften * 0.5);
  vec3 g = texture(uSmall, uv).rgb * 0.6 * mix(vec3(1.0), p_tint, 0.4) + texture(uLarge, uv).rgb * p_tint * 1.4;
  vec3 col = 1.0 - (1.0 - base) * (1.0 - clamp(g * p_intensity, 0.0, 1.0));
  emit(col, s.a);
}`;

const prism = /* glsl */ `${fx}
uniform float p_dispersion;
uniform float p_leak;
uniform float p_leakAngle;
uniform float p_cx;
uniform float p_cy;
vec3 spectrum(float t) { return clamp(vec3(1.5 - abs(4.0 * t - 1.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 3.0)) - 0.5, 0.0, 1.0); }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 c = vec2(p_cx, p_cy) * uSize;
  vec2 d = p - c;
  float r = length(d) / length(uSize * 0.5);
  vec3 acc = vec3(0.0);
  vec3 weight = vec3(0.0);
  // Eight wavelengths, each scaled a little differently away from the center.
  for (int i = 0; i < 8; i++) {
    float t = (float(i) + 0.5) / 8.0;
    vec3 w = spectrum(t);
    float k = (t - 0.5) * p_dispersion * uUnit * r * 2.0;
    acc += src(c + d * (1.0 + k / max(length(d), 1.0))).rgb * w;
    weight += w;
  }
  vec3 col = acc / weight;
  vec2 dir = vec2(cos(radians(p_leakAngle)), sin(radians(p_leakAngle)));
  float band = dot(p / uSize - 0.5, dir) * 2.0;
  vec3 leak = spectrum(sat01(band * 1.4 + 0.9)) * smoothstep(0.4, 0.0, abs(band + 0.4)) * p_leak;
  col = 1.0 - (1.0 - col) * (1.0 - leak * 0.8);
  emit(col, src(p).a);
}`;

export const lightEffects: EffectDef[] = [
  {
    id: "fluted-glass",
    name: "Fluted Glass",
    category: "Light & glass",
    description: "The photo seen through reeded, block or rippled glass.",
    params: [
      {
        key: "shape",
        label: "Glass",
        type: "select",
        options: [
          { value: "flutes", label: "Reeded" },
          { value: "blocks", label: "Glass blocks" },
          { value: "rings", label: "Rings" },
          { value: "ripple", label: "Ripple" },
        ],
        default: "flutes",
      },
      { key: "width", label: "Rib width", type: "number", min: 4, max: 200, step: 1, default: 40 },
      { key: "strength", label: "Refraction", type: "number", min: 0, max: 3, step: 0.01, default: 1 },
      { key: "angle", label: "Angle", type: "number", min: -90, max: 90, step: 1, default: 0 },
      { key: "frost", label: "Frost", type: "number", min: 0, max: 1, step: 0.01, default: 0.15 },
      { key: "dispersion", label: "Dispersion", type: "number", min: 0, max: 0.2, step: 0.005, default: 0.04 },
      { key: "highlight", label: "Highlights", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    render: (ctx, u) => ctx.pass("fx-fluted", fluted, u),
  },
  {
    id: "glow",
    name: "Halation Glow",
    category: "Light & glass",
    description: "Highlights bloom with the warm halo of film halation.",
    params: [
      { key: "threshold", label: "Threshold", type: "number", min: 0, max: 0.95, step: 0.01, default: 0.45 },
      { key: "radius", label: "Radius", type: "number", min: 2, max: 150, step: 1, default: 30 },
      { key: "intensity", label: "Intensity", type: "number", min: 0, max: 3, step: 0.01, default: 1.4 },
      { key: "soften", label: "Soften", type: "number", min: 0, max: 1, step: 0.01, default: 0.2 },
      { key: "tint", label: "Halo color", type: "color", default: "#ff6a3d" },
    ],
    render(ctx, u, params) {
      const bright = ctx.pass("fx-glow-bright", glowBright, u);
      const r = Number(params.radius) * ctx.unit;
      const small = ctx.blur(bright, Math.max(1, r * 0.2));
      const large = ctx.blur(bright, Math.max(1, r));
      ctx.release(bright);
      const out = ctx.pass("fx-glow", glow, u, { uSmall: small, uLarge: large });
      ctx.release(small);
      ctx.release(large);
      return out;
    },
  },
  {
    id: "prism",
    name: "Prism",
    category: "Light & glass",
    description: "Spectral fringes and a rainbow light leak, as if shot through a prism.",
    params: [
      { key: "dispersion", label: "Dispersion", type: "number", min: 0, max: 60, step: 0.5, default: 14 },
      { key: "leak", label: "Rainbow leak", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "leakAngle", label: "Leak angle", type: "number", min: 0, max: 360, step: 1, default: 35 },
      { key: "cx", label: "Center X", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "cy", label: "Center Y", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    render: (ctx, u) => ctx.pass("fx-prism", prism, u),
  },
];
