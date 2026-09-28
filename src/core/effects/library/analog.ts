import { fx } from "../glsl";
import type { EffectDef } from "../types";

const crt = /* glsl */ `${fx}
uniform sampler2D uBloom;
uniform float p_curve;
uniform float p_scan;
uniform float p_mask;
uniform float p_bloom;
uniform float p_vignette;
uniform float p_pitch;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 c = uv - 0.5;
  float aspect = uSize.x / uSize.y;
  vec2 ca = c * vec2(aspect, 1.0);
  c *= 1.0 + p_curve * dot(ca, ca);
  vec2 cuv = c + 0.5;
  // Rounded screen corners outside the curved glass.
  vec2 q = abs(c) - (0.5 - 0.03);
  float corner = length(max(q * vec2(aspect, 1.0), 0.0)) - 0.03;
  float inside = clamp(-corner * uSize.y + 0.5, 0.0, 1.0);
  vec2 p = cuv * uSize;
  float pitch = max(2.0, p_pitch * uUnit);
  float shift = uUnit * 0.8 * (1.0 + p_curve * 4.0 * dot(ca, ca));
  vec3 col = vec3(src(p + vec2(shift, 0.0)).r, src(p).g, src(p - vec2(shift, 0.0)).b);
  float line = 0.5 + 0.5 * cos(p.y / pitch * TAU);
  col *= mix(1.0, 0.35 + 0.65 * line * (1.0 + 0.4 * luma(col)), p_scan);
  // Aperture grille: alternating R, G, B phosphor stripes.
  float stripe = mod(floor(p.x / max(1.0, pitch / 3.0)), 3.0);
  vec3 mask = stripe == 0.0 ? vec3(1.0, 0.45, 0.45) : stripe == 1.0 ? vec3(0.45, 1.0, 0.45) : vec3(0.45, 0.45, 1.0);
  col *= mix(vec3(1.0), mask * 1.35, p_mask);
  col += unpremul(texture(uBloom, cuv)).rgb * p_bloom * 0.6;
  col *= 1.0 - p_vignette * dot(ca, ca) * 1.6;
  emit(col * inside, 1.0);
}`;

const vhs = /* glsl */ `${fx}
uniform float p_bleed;
uniform float p_tracking;
uniform float p_jitter;
uniform float p_noise;
uniform float p_fade;
const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
void main() {
  vec2 p = gl_FragCoord.xy;
  float line = floor(p.y / max(1.0, uUnit));
  float t = uSeed * 7.13;
  // Horizontal wobble per scanline, a tracking band, and the head-switch tear at the bottom.
  float wobble = (vnoise(vec2(line * 0.05, t)) - 0.5) * p_jitter * uUnit * 6.0;
  float bandY = fract(0.63 + uSeed * 0.217) * uSize.y;
  float bandH = uSize.y * 0.06;
  float inBand = smoothstep(bandH, 0.0, abs(p.y - bandY)) * p_tracking;
  wobble += inBand * (hash(vec2(line, t)) - 0.5) * uUnit * 40.0;
  float tear = smoothstep(uSize.y * 0.965, uSize.y, p.y);
  wobble += tear * uUnit * 30.0 * (1.0 + hash(vec2(line, 3.0)));
  vec2 q = p + vec2(wobble, 0.0);
  // Tape resolution: luma is soft horizontally, chroma much softer and trailing.
  float soft = max(1.0, uUnit * 1.2);
  vec3 yiq = RGB2YIQ * ((src(q).rgb * 2.0 + src(q - vec2(soft, 0.0)).rgb + src(q + vec2(soft, 0.0)).rgb) * 0.25);
  vec2 iq = vec2(0.0);
  float bleed = max(1.0, p_bleed * uUnit);
  for (int i = 0; i < 12; i++) {
    float o = float(i) / 11.0 * bleed;
    iq += (RGB2YIQ * src(q - vec2(o, 0.0)).rgb).yz;
  }
  yiq.yz = iq / 12.0 * (1.0 - 0.3 * p_fade) + vec2(0.02, 0.01) * p_fade;
  yiq.x = yiq.x * (1.0 - 0.18 * p_fade) + 0.07 * p_fade;
  // A faint ghost of the picture a few pixels to the right.
  yiq.x += (luma(src(q - vec2(uUnit * 5.0, 0.0)).rgb) - yiq.x) * 0.12;
  vec3 col = YIQ2RGB * yiq;
  col = mix(col, col * vec3(1.05, 0.98, 0.9), p_fade);
  float grain = (hash(floor(p / max(1.0, uUnit * 0.8)) + t) - 0.5) * 0.22 * p_noise;
  float speck = step(0.9985 - inBand * 0.02, hash(vec2(floor(p.x / (uUnit * 6.0)), line + t))) * p_noise;
  col += grain + speck * 0.8 + inBand * (hash(vec2(p.x * 0.1, line)) - 0.3) * 0.3;
  col *= 0.9 + 0.1 * cos(p.y / max(1.0, uUnit * 1.5) * PI);
  emit(col, src(p).a);
}`;

const glitch = /* glsl */ `${fx}
uniform float p_intensity;
uniform float p_slice;
uniform float p_split;
uniform float p_blocks;
void main() {
  vec2 p = gl_FragCoord.xy;
  float slice = max(2.0, p_slice * uUnit);
  float row = floor(p.y / slice);
  float r1 = hash(vec2(row, 1.0));
  float r2 = hash(vec2(floor(p.y / (slice * 4.0)), 2.0));
  float shift = 0.0;
  if (r1 < p_intensity * 0.6) shift = (hash(vec2(row, 3.0)) - 0.5) * uSize.x * 0.25 * p_intensity;
  if (r2 < p_intensity * 0.25) shift += (hash(vec2(row, 4.0)) - 0.5) * uSize.x * 0.08;
  vec2 q = p + vec2(shift, 0.0);
  float split = p_split * uUnit * (shift != 0.0 ? 2.0 : 1.0);
  vec3 col = vec3(src(q + vec2(split, 0.0)).r, src(q).g, src(q - vec2(split, 0.0)).b);
  // Corrupted macroblocks: sampled from the wrong place at low resolution, sometimes channel-swapped.
  // Corrupted macroblocks, in runs along a few damaged rows: copied from the wrong place, sometimes channel-swapped.
  float bs = slice * 1.6;
  vec2 block = floor(p / bs);
  float band = hash(vec2(floor(block.y / 2.0), 21.0));
  if (band < p_blocks * 0.35 && hash(vec2(floor(block.x / 3.0), block.y) + 5.0) < 0.6) {
    vec2 jump = floor((hash2(vec2(block.y, floor(block.x / 3.0))) - 0.5) * 8.0) * bs;
    vec3 c = srcLod(p + jump, hash(block + 2.0) < 0.5 ? 0.0 : log2(bs * 0.5)).rgb;
    col = hash(block + 9.0) < 0.4 ? c.brg : c;
    if (hash(block + 13.0) < 0.12) col = 1.0 - col;
  }
  float scan = step(0.97, hash(vec2(row, 7.0))) * p_intensity;
  col = mix(col, vec3(col.g, col.b, col.r), scan);
  emit(col, src(p).a);
}`;

const streaks = /* glsl */ `${fx}
uniform float p_length;
uniform float p_threshold;
uniform int p_direction;
uniform float p_falloff;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 dir = p_direction == 0 ? vec2(0.0, 1.0) : p_direction == 1 ? vec2(0.0, -1.0) : p_direction == 2 ? vec2(1.0, 0.0) : vec2(-1.0, 0.0);
  vec4 own = src(p);
  vec3 best = own.rgb;
  float bestScore = luma(own.rgb);
  float len = p_length * uUnit;
  // Bright pixels above the threshold drip along the direction, keeping their color.
  for (int i = 1; i <= 48; i++) {
    float t = float(i) / 48.0;
    vec3 c = src(p - dir * len * t).rgb;
    float l = luma(c);
    if (l < p_threshold) continue;
    float score = l * (1.0 - t * p_falloff);
    if (score > bestScore) { bestScore = score; best = mix(c, own.rgb, t * p_falloff * 0.6); }
  }
  emit(best, own.a);
}`;

export const analogEffects: EffectDef[] = [
  {
    id: "crt",
    name: "CRT Monitor",
    category: "Analog & glitch",
    description: "Curved tube glass, scanlines, phosphor stripes and bloom.",
    params: [
      { key: "curve", label: "Curvature", type: "number", min: 0, max: 0.5, step: 0.01, default: 0.14 },
      { key: "pitch", label: "Line pitch", type: "number", min: 1.5, max: 20, step: 0.1, default: 3.5 },
      { key: "scan", label: "Scanlines", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: "mask", label: "Phosphor mask", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "bloom", label: "Bloom", type: "number", min: 0, max: 2, step: 0.01, default: 0.7 },
      { key: "vignette", label: "Vignette", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    render(ctx, u) {
      const bloom = ctx.blur(ctx.input, Math.max(1, 6 * ctx.unit));
      const out = ctx.pass("fx-crt", crt, u, { uBloom: bloom });
      ctx.release(bloom);
      return out;
    },
  },
  {
    id: "vhs",
    name: "VHS Tape",
    category: "Analog & glitch",
    description: "Smeared chroma, tracking noise and a torn head-switch line.",
    params: [
      { key: "bleed", label: "Color bleed", type: "number", min: 0, max: 40, step: 0.5, default: 14 },
      { key: "tracking", label: "Tracking noise", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
      { key: "jitter", label: "Jitter", type: "number", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "noise", label: "Noise", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "fade", label: "Tape fade", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 4 },
    ],
    render: (ctx, u) => ctx.pass("fx-vhs", vhs, u),
  },
  {
    id: "glitch",
    name: "Datamosh Glitch",
    category: "Analog & glitch",
    description: "Displaced slices, split channels and corrupted blocks.",
    params: [
      { key: "intensity", label: "Intensity", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "slice", label: "Slice height", type: "number", min: 1, max: 60, step: 0.5, default: 10 },
      { key: "split", label: "RGB split", type: "number", min: 0, max: 40, step: 0.5, default: 6 },
      { key: "blocks", label: "Block corruption", type: "number", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 12 },
    ],
    render: (ctx, u) => ctx.pass("fx-glitch", glitch, u),
  },
  {
    id: "streaks",
    name: "Light Drip",
    category: "Experimental",
    description: "Bright pixels melt into streaks, like a sorted-pixel glitch.",
    params: [
      { key: "length", label: "Length", type: "number", min: 5, max: 400, step: 1, default: 120 },
      { key: "threshold", label: "Threshold", type: "number", min: 0, max: 1, step: 0.01, default: 0.55 },
      {
        key: "direction",
        label: "Direction",
        type: "select",
        options: [
          { value: "down", label: "Down" },
          { value: "up", label: "Up" },
          { value: "right", label: "Right" },
          { value: "left", label: "Left" },
        ],
        default: "down",
      },
      { key: "falloff", label: "Falloff", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    render: (ctx, u) => ctx.pass("fx-streaks", streaks, u),
  },
];
