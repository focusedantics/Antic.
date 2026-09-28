import { fx } from "../glsl";
import type { EffectDef, ParamDef } from "../types";

/**
 * Animated overlays. Every motion is periodic in the loop (whole cycles of
 * uPhase), so exported GIFs and videos loop without a jump.
 */
const speed: ParamDef = { key: "speed", label: "Speed", type: "number", min: 1, max: 6, step: 1, default: 1 };

/** Particles on a sheared grid that falls with time; the grid repeats every `rows` cells, so it loops. */
const particles = /* glsl */ `
// Returns (coverage 0..1, particle hash) for one layer of falling particles.
vec2 particleLayer(vec2 p, float cell, float cycles, float slant, float radius, float stretch, float amount, float salt) {
  float rows = ceil(uSize.y / cell) + 2.0;
  float fall = uPhase * cycles * rows * cell;
  vec2 q = vec2(p.x - p.y * slant, p.y - fall);
  vec2 id = floor(q / cell);
  vec2 wid = vec2(id.x, mod(id.y, rows));
  float h = hash(wid + salt);
  if (h > amount) return vec2(0.0);
  vec2 center = (id + 0.2 + 0.6 * hash2(wid + salt * 1.7)) * cell;
  // A gentle sway, a whole number of times per loop.
  center.x += sin(TAU * (uPhase * cycles * 2.0 + h)) * cell * 0.12;
  vec2 d = q - center;
  d.y /= stretch;
  float r = radius * (0.6 + 0.8 * hash(wid + salt + 3.1));
  return vec2(smoothstep(r, r * 0.35, length(d)), h);
}
`;

const snow = /* glsl */ `${fx}${particles}
uniform float p_amount;
uniform float p_size;
uniform float p_wind;
uniform float p_speed;
uniform float p_haze;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  float u = uUnit;
  float flakes = 0.0;
  flakes += particleLayer(p, 14.0 * u, p_speed, p_wind * 0.3, 2.0 * p_size * u, 1.0, p_amount, 1.0).x * 0.6;
  flakes += particleLayer(p, 26.0 * u, p_speed * 2.0, p_wind * 0.45, 3.6 * p_size * u, 1.0, p_amount, 7.0).x * 0.85;
  flakes += particleLayer(p, 48.0 * u, p_speed * 3.0, p_wind * 0.6, 6.5 * p_size * u, 1.0, p_amount * 0.8, 13.0).x;
  vec3 col = mix(s.rgb, vec3(0.9, 0.93, 0.97), p_haze * 0.25);
  col = mix(col, vec3(1.0), clamp(flakes, 0.0, 1.0) * 0.95);
  emit(col, s.a);
}`;

const rain = /* glsl */ `${fx}${particles}
uniform float p_amount;
uniform float p_length;
uniform float p_wind;
uniform float p_speed;
uniform float p_mood;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  float u = uUnit;
  float drops = 0.0;
  // Streaks: thin particles stretched along the fall.
  drops += particleLayer(p, 16.0 * u, p_speed * 4.0, p_wind * 0.3, 0.7 * u, p_length * 10.0, p_amount, 2.0).x * 0.35;
  drops += particleLayer(p, 26.0 * u, p_speed * 6.0, p_wind * 0.4, 1.0 * u, p_length * 14.0, p_amount, 9.0).x * 0.5;
  vec3 col = mix(s.rgb, s.rgb * vec3(0.78, 0.86, 1.0) * 0.85, p_mood);
  col += vec3(0.75, 0.82, 0.9) * clamp(drops, 0.0, 1.0);
  emit(col, s.a);
}`;

const sparkles = /* glsl */ `${fx}
uniform float p_size;
uniform float p_threshold;
uniform float p_density;
uniform float p_speed;
uniform int p_color;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  float cell = max(6.0, 26.0 * uUnit);
  vec2 id = floor(p / cell);
  vec3 add = vec3(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 k = id + vec2(float(x), float(y));
      if (hash(k + 4.0) > p_density) continue;
      vec2 c = (k + 0.2 + 0.6 * hash2(k)) * cell;
      vec3 base = srcAvg(c, cell * 0.25).rgb;
      if (luma(base) < p_threshold) continue;
      // Each glint twinkles on its own beat, a whole number of times per loop.
      float tw = pow(max(0.0, sin(TAU * (uPhase * p_speed * (1.0 + floor(hash(k + 9.0) * 3.0)) + hash(k + 2.0)))), 6.0);
      vec2 d = p - c;
      float len = p_size * uUnit * 24.0 * (0.5 + hash(k + 5.0));
      float w = max(0.7, uUnit * 1.0);
      float rays = exp(-abs(d.x) / w) * exp(-abs(d.y) / len) + exp(-abs(d.y) / w) * exp(-abs(d.x) / len);
      vec2 r = rot(0.785) * d;
      rays += 0.45 * (exp(-abs(r.x) / w) * exp(-abs(r.y) / (len * 0.5)) + exp(-abs(r.y) / w) * exp(-abs(r.x) / (len * 0.5)));
      rays += 1.5 * exp(-dot(d, d) / (w * w * 20.0));
      vec3 tint = p_color == 0 ? vec3(1.0) : p_color == 1 ? mix(vec3(1.0), saturateColor(base, 1.6), 0.6) : vec3(1.0, 0.85, 0.5);
      add += tint * rays * tw;
    }
  emit(1.0 - (1.0 - s.rgb) * (1.0 - clamp(add, 0.0, 1.0)), s.a);
}`;

const grain = /* glsl */ `${fx}
uniform float p_grain;
uniform float p_flicker;
uniform float p_dust;
uniform float p_weave;
uniform int p_tone;
void main() {
  vec2 p = gl_FragCoord.xy;
  // Gate weave: the frame shifts a little, differently every frame.
  vec2 weave = (vec2(frameHash(vec2(1.0), 24.0), frameHash(vec2(2.0), 24.0)) - 0.5) * p_weave * uUnit * 3.0;
  vec4 s = src(p + weave);
  vec3 c = s.rgb;
  if (p_tone == 1) c = mix(c, vec3(luma(c)), 0.45) * vec3(1.04, 1.0, 0.92) + vec3(0.04, 0.03, 0.0);
  else if (p_tone == 2) c = vec3(luma(c)) * vec3(1.07, 0.95, 0.78);
  else if (p_tone == 3) c = vec3(luma(c));
  c *= 1.0 + (frameHash(vec2(3.0), 24.0) - 0.5) * p_flicker * 0.25;
  float g = frameHash(floor(p / max(1.0, uUnit * 0.9)), 24.0) - 0.5;
  c += g * p_grain * 0.25 * (1.0 - abs(luma(c) - 0.5));
  // Dust specks and a hairline scratch, new every few frames.
  float dcell = uUnit * 60.0;
  vec2 did = floor(p / dcell);
  if (frameHash(did, 8.0) < p_dust * 0.03) {
    vec2 dc = (did + frameHash(did + 1.0, 8.0)) * dcell;
    c = mix(c, vec3(0.05), cover(length(p - dc) - uUnit * (0.8 + 2.0 * frameHash(did + 2.0, 8.0))) * 0.8);
  }
  float sx = frameHash(vec2(5.0), 4.0) * uSize.x;
  if (frameHash(vec2(6.0), 4.0) < p_dust) c = mix(c, vec3(0.9), cover(abs(p.x - sx) - uUnit * 0.4) * 0.35);
  emit(c, s.a);
}`;

const leaks = /* glsl */ `${fx}
uniform float p_intensity;
uniform float p_size;
uniform float p_speed;
uniform vec3 p_colorA;
uniform vec3 p_colorB;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  vec2 uv = p / uSize;
  vec3 light = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    // Blobs drift on circles near the edges and breathe in brightness.
    vec2 home = vec2(fi == 1.0 ? 1.0 : 0.0, fi == 2.0 ? 1.0 : 0.15 + fi * 0.3);
    vec2 center = home + loopCircle(p_speed * (fi == 1.0 ? -1.0 : 1.0)) * (0.18 + 0.05 * fi);
    float r = p_size * (0.35 + 0.1 * fi);
    vec2 d = (uv - center) * vec2(uSize.x / uSize.y, 1.0);
    float glow = exp(-dot(d, d) / (r * r));
    glow *= 0.7 + 0.3 * sin(TAU * (uPhase * p_speed + fi / 3.0));
    light += mix(p_colorA, p_colorB, fi / 2.0) * glow;
  }
  light *= p_intensity;
  emit(1.0 - (1.0 - s.rgb) * (1.0 - clamp(light, 0.0, 1.0)), s.a);
}`;

const bokeh = /* glsl */ `${fx}${particles}
uniform float p_amount;
uniform float p_size;
uniform float p_speed;
uniform float p_blur;
uniform float p_intensity;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = srcLod(p, p_blur * 5.0);
  vec3 add = vec3(0.0);
  float cell = 110.0 * uUnit * p_size;
  // Rising discs: each layer's grid moves up by whole rows per loop, so it loops.
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float c = cell * (1.0 + fl * 0.6);
    float rows = ceil(uSize.y / c) + 2.0;
    float lift = uPhase * p_speed * (1.0 + fl) * rows * c;
    vec2 q = vec2(p.x, p.y + lift);
    vec2 id = floor(q / c);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 k = id + vec2(float(x), float(y));
        vec2 wk = vec2(k.x, mod(k.y, rows)) + fl * 31.0;
        if (hash(wk) > p_amount) continue;
        vec2 center = (k + 0.2 + 0.6 * hash2(wk)) * c;
        float radius = c * (0.18 + 0.2 * hash(wk + 1.0));
        float d = length(q - center);
        float disc = smoothstep(radius, radius * 0.85, d) * (0.55 + 0.45 * smoothstep(radius * 0.6, radius * 0.95, d));
        vec3 tint = saturateColor(srcLod(center - vec2(0.0, lift), 6.0).rgb, 1.5) * 1.3 + 0.1;
        add += tint * disc * (0.5 + 0.4 * hash(wk + 2.0));
      }
  }
  emit(1.0 - (1.0 - s.rgb) * (1.0 - clamp(add * p_intensity, 0.0, 1.0)), s.a);
}`;

const ripple = /* glsl */ `${fx}
uniform int p_mode;
uniform float p_strength;
uniform float p_scale;
uniform float p_speed;
uniform float p_cx;
uniform float p_cy;
void main() {
  vec2 p = gl_FragCoord.xy;
  float L = max(uSize.x, uSize.y);
  vec2 offset;
  vec3 tint = vec3(1.0);
  if (p_mode == 0) {
    // Heat haze: fine vertical shimmer rising through the frame.
    vec2 q = p / (L * 0.02 * p_scale);
    offset = vec2(loopNoise(q + vec2(0.0, uPhase * p_speed * 8.0), 3.0, p_speed) - 0.5, loopNoise(q * 1.3 + 5.0, 3.0, p_speed) - 0.5) * p_strength * uUnit * 6.0;
  } else if (p_mode == 1) {
    // Water: rings travel out from the center a whole number of wavelengths per loop.
    vec2 c = vec2(p_cx, p_cy) * uSize;
    vec2 d = p - c;
    float r = length(d);
    float wl = L * 0.04 * p_scale;
    float wave = sin(TAU * (r / wl - uPhase * p_speed * 2.0)) * exp(-r / (L * 0.6));
    offset = normalize(d + 1e-3) * wave * p_strength * uUnit * 4.0;
  } else {
    // Underwater: slow wobble and caustic light.
    vec2 q = p / (L * 0.06 * p_scale);
    offset = (vec2(loopNoise(q, 2.0, p_speed), loopNoise(q + 9.0, 2.0, p_speed)) - 0.5) * p_strength * uUnit * 10.0;
    float caustic = pow(abs(sin(loopNoise(q * 3.0, 1.5, p_speed) * 12.0)), 8.0);
    tint = vec3(0.75, 0.95, 1.05) + caustic * 0.35;
  }
  vec4 s = src(p + offset);
  emit(s.rgb * tint, s.a);
}`;

const colorCycle = /* glsl */ `${fx}
uniform int p_mode;
uniform float p_speed;
uniform float p_saturation;
uniform float p_mix;
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  vec3 c;
  if (p_mode == 0) {
    vec3 h = rgb2hsv(s.rgb);
    c = hsv2rgb(vec3(fract(h.x + uPhase * p_speed), min(1.0, h.y * p_saturation), h.z));
  } else {
    // Psychedelic gradient map: brightness picks a hue that keeps rotating.
    float l = luma(s.rgb);
    c = hsv2rgb(vec3(fract(l * 1.5 - uPhase * p_speed), clamp(p_saturation * 0.7, 0.0, 1.0), 0.35 + 0.65 * l));
  }
  emit(mix(s.rgb, c, p_mix), s.a);
}`;

const camera = /* glsl */ `${fx}
uniform int p_mode;
uniform float p_amount;
uniform float p_speed;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 c = uSize * 0.5;
  float zoom = 1.0 + p_amount * 0.08;
  vec2 shift = vec2(0.0);
  float angle = 0.0;
  if (p_mode == 0) {
    // Handheld shake: small wandering offsets and roll.
    shift = (vec2(loopNoise(vec2(1.0, 0.0), 2.0, p_speed * 2.0), loopNoise(vec2(0.0, 7.0), 2.0, p_speed * 2.0)) - 0.5) * p_amount * uUnit * 30.0;
    angle = (loopNoise(vec2(4.0, 4.0), 2.0, p_speed * 2.0) - 0.5) * p_amount * 0.03;
  } else if (p_mode == 1) {
    zoom *= 1.0 + p_amount * 0.06 * (0.5 - 0.5 * cos(TAU * uPhase * p_speed));
  } else {
    // Ken Burns drift on a slow circle.
    shift = loopCircle(p_speed) * p_amount * uUnit * 25.0;
    zoom *= 1.0 + p_amount * 0.04;
  }
  vec2 q = rot(angle) * ((p - c - shift) / zoom) + c;
  vec4 s = src(q);
  emit(s.rgb, src(p).a);
}`;

const confetti = /* glsl */ `${fx}
uniform float p_amount;
uniform float p_size;
uniform float p_speed;
uniform int p_palette;
vec3 paletteColor(float h) {
  if (p_palette == 1) return hsv2rgb(vec3(0.1 + h * 0.08, 0.6, 1.0));
  if (p_palette == 2) return hsv2rgb(vec3(0.55 + h * 0.4, 0.35, 1.0));
  return hsv2rgb(vec3(h, 0.75, 1.0));
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = src(p);
  vec3 col = s.rgb;
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float cell = (34.0 + fl * 22.0) * uUnit * p_size;
    float rows = ceil(uSize.y / cell) + 2.0;
    vec2 q = vec2(p.x, p.y - uPhase * p_speed * (1.0 + fl) * rows * cell);
    vec2 id = floor(q / cell);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 k = id + vec2(float(x), float(y));
        vec2 wk = vec2(k.x, mod(k.y, rows)) + fl * 17.0;
        if (hash(wk) > p_amount) continue;
        vec2 center = (k + 0.2 + 0.6 * hash2(wk)) * cell;
        center.x += sin(TAU * (uPhase * p_speed * 2.0 + hash(wk + 1.0))) * cell * 0.3;
        float spin = TAU * (uPhase * p_speed * (1.0 + floor(hash(wk + 2.0) * 3.0)) + hash(wk + 3.0));
        vec2 d = rot(spin) * (q - center);
        // Tumbling: the piece's width swings with its flip.
        vec2 half_ = vec2(cell * 0.18 * abs(cos(spin * 1.3)) + uUnit * 0.5, cell * 0.09);
        vec2 e = abs(d) - half_;
        float piece = cover(length(max(e, 0.0)) + min(max(e.x, e.y), 0.0));
        col = mix(col, paletteColor(hash(wk + 4.0)) * (0.8 + 0.2 * cos(spin)), piece);
      }
  }
  emit(col, s.a);
}`;

export const motionEffects: EffectDef[] = [
  {
    id: "snow",
    name: "Snowfall",
    category: "Motion",
    animated: true,
    description: "Three layers of drifting snow, near flakes bigger and faster.",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0.05, max: 1, step: 0.01, default: 0.5 },
      { key: "size", label: "Flake size", type: "number", min: 0.3, max: 3, step: 0.05, default: 1 },
      { key: "wind", label: "Wind", type: "number", min: -1, max: 1, step: 0.01, default: 0.25 },
      { key: "haze", label: "Winter haze", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      speed,
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-snow", snow, u),
  },
  {
    id: "rain",
    name: "Rain",
    category: "Motion",
    animated: true,
    description: "Slanting streaks of rain with a cool, overcast mood.",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0.05, max: 1, step: 0.01, default: 0.45 },
      { key: "length", label: "Streak length", type: "number", min: 0.3, max: 3, step: 0.05, default: 1 },
      { key: "wind", label: "Slant", type: "number", min: -1, max: 1, step: 0.01, default: 0.2 },
      { key: "mood", label: "Moody tint", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      speed,
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-rain-motion", rain, u),
  },
  {
    id: "sparkles",
    name: "Sparkles",
    category: "Motion",
    animated: true,
    description: "Star glints twinkle on the bright parts of the image.",
    params: [
      { key: "size", label: "Size", type: "number", min: 0.2, max: 3, step: 0.05, default: 1 },
      { key: "threshold", label: "On highlights above", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "density", label: "Density", type: "number", min: 0.02, max: 1, step: 0.01, default: 0.5 },
      {
        key: "color",
        label: "Color",
        type: "select",
        options: [
          { value: "white", label: "White" },
          { value: "photo", label: "Photo colors" },
          { value: "gold", label: "Gold" },
        ],
        default: "white",
      },
      speed,
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-sparkles", sparkles, u),
  },
  {
    id: "film",
    name: "Film Grain & Flicker",
    category: "Motion",
    animated: true,
    description: "Moving grain, exposure flicker, dust, scratches and gate weave.",
    params: [
      { key: "grain", label: "Grain", type: "number", min: 0, max: 1.5, step: 0.01, default: 0.6 },
      { key: "flicker", label: "Flicker", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "dust", label: "Dust & scratches", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "weave", label: "Gate weave", type: "number", min: 0, max: 1, step: 0.01, default: 0.3 },
      {
        key: "tone",
        label: "Stock",
        type: "select",
        options: [
          { value: "color", label: "Color" },
          { value: "faded", label: "Faded" },
          { value: "sepia", label: "Sepia" },
          { value: "bw", label: "Black & white" },
        ],
        default: "faded",
      },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-film", grain, u),
  },
  {
    id: "light-leaks",
    name: "Light Leaks",
    category: "Motion",
    animated: true,
    description: "Warm light bleeding in from the edges and drifting.",
    params: [
      { key: "intensity", label: "Intensity", type: "number", min: 0, max: 2, step: 0.01, default: 0.9 },
      { key: "size", label: "Size", type: "number", min: 0.2, max: 2, step: 0.01, default: 0.8 },
      { key: "colorA", label: "Color 1", type: "color", default: "#ff6a2a" },
      { key: "colorB", label: "Color 2", type: "color", default: "#ff2f7a" },
      speed,
    ],
    render: (ctx, u) => ctx.pass("fx-leaks", leaks, u),
  },
  {
    id: "bokeh",
    name: "Bokeh Float",
    category: "Motion",
    animated: true,
    description: "Soft out-of-focus lights in the photo's colors float upward.",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0.05, max: 1, step: 0.01, default: 0.45 },
      { key: "size", label: "Size", type: "number", min: 0.4, max: 2.5, step: 0.05, default: 1 },
      { key: "intensity", label: "Brightness", type: "number", min: 0, max: 2, step: 0.01, default: 1.1 },
      { key: "blur", label: "Background blur", type: "number", min: 0, max: 1, step: 0.01, default: 0.25 },
      speed,
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-bokeh", bokeh, u),
  },
  {
    id: "ripple",
    name: "Heat & Water",
    category: "Motion",
    animated: true,
    description: "Heat shimmer, spreading water rings or an underwater wobble.",
    params: [
      {
        key: "mode",
        label: "Kind",
        type: "select",
        options: [
          { value: "heat", label: "Heat haze" },
          { value: "water", label: "Water rings" },
          { value: "underwater", label: "Underwater" },
        ],
        default: "water",
      },
      { key: "strength", label: "Strength", type: "number", min: 0, max: 3, step: 0.01, default: 1.6 },
      { key: "scale", label: "Scale", type: "number", min: 0.3, max: 3, step: 0.01, default: 1 },
      { key: "cx", label: "Center X", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "cy", label: "Center Y", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
      speed,
    ],
    render: (ctx, u) => ctx.pass("fx-ripple", ripple, u),
  },
  {
    id: "color-cycle",
    name: "Color Cycle",
    category: "Motion",
    animated: true,
    description: "Hues rotate through the spectrum, or a psychedelic gradient map flows.",
    params: [
      {
        key: "mode",
        label: "Style",
        type: "select",
        options: [
          { value: "hue", label: "Hue rotation" },
          { value: "map", label: "Psychedelic map" },
        ],
        default: "hue",
      },
      { key: "saturation", label: "Saturation", type: "number", min: 0, max: 2.5, step: 0.01, default: 1.3 },
      { key: "mix", label: "Mix", type: "number", min: 0, max: 1, step: 0.01, default: 1 },
      speed,
    ],
    render: (ctx, u) => ctx.pass("fx-color-cycle", colorCycle, u),
  },
  {
    id: "camera",
    name: "Camera Motion",
    category: "Motion",
    animated: true,
    description: "Handheld shake, a breathing zoom or a slow Ken Burns drift.",
    params: [
      {
        key: "mode",
        label: "Motion",
        type: "select",
        options: [
          { value: "shake", label: "Handheld shake" },
          { value: "zoom", label: "Zoom pulse" },
          { value: "drift", label: "Ken Burns drift" },
        ],
        default: "drift",
      },
      { key: "amount", label: "Amount", type: "number", min: 0, max: 2, step: 0.01, default: 0.6 },
      speed,
    ],
    render: (ctx, u) => ctx.pass("fx-camera", camera, u),
  },
  {
    id: "confetti",
    name: "Confetti",
    category: "Motion",
    animated: true,
    description: "Tumbling paper confetti falling through the frame.",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0.05, max: 1, step: 0.01, default: 0.45 },
      { key: "size", label: "Size", type: "number", min: 0.4, max: 3, step: 0.05, default: 1 },
      {
        key: "palette",
        label: "Colors",
        type: "select",
        options: [
          { value: "rainbow", label: "Rainbow" },
          { value: "gold", label: "Gold" },
          { value: "pastel", label: "Pastel" },
        ],
        default: "rainbow",
      },
      speed,
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-confetti", confetti, u),
  },
];
