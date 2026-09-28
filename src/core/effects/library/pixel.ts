import { fx } from "../glsl";
import type { EffectDef } from "../types";

const blocks = /* glsl */ `${fx}
uniform float p_size;
uniform int p_shape;
uniform float p_gap;
uniform float p_levels;
uniform int p_bevel;
uniform vec3 p_background;
void main() {
  float size = max(2.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / size);
  vec2 o = p - (cell + 0.5) * size;
  vec4 s = srcAvg((cell + 0.5) * size, size);
  vec3 c = s.rgb;
  if (p_levels >= 2.0) c = floor(c * (p_levels - 1.0) + 0.5) / (p_levels - 1.0);
  float half_ = size * 0.5 * (1.0 - p_gap);
  float d;
  if (p_shape == 0) d = max(abs(o.x), abs(o.y)) - half_;
  else if (p_shape == 1) { float r = half_ * 0.45; vec2 q = abs(o) - (half_ - r); d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  else if (p_shape == 2) d = length(o) - half_;
  else d = (abs(o.x) + abs(o.y)) - half_;
  if (p_bevel == 1) {
    float light = clamp(-(o.x + o.y) / (size * 0.9), -1.0, 1.0);
    float edge = smoothstep(-size * 0.18, 0.0, d);
    c = clamp(c * (1.0 + 0.3 * light * edge) - 0.05 * edge, 0.0, 1.0);
  }
  emit(mix(p_background, c, cover(d)), s.a);
}`;

const bricks = /* glsl */ `${fx}
uniform float p_size;
uniform int p_palette;
uniform float p_studs;
uniform vec3 uPalette[24];
uniform int uPaletteCount;
vec3 nearest(vec3 c) {
  vec3 lab = labOf(c);
  vec3 best = uPalette[0];
  float bd = 1e9;
  for (int i = 0; i < 24; i++) {
    if (i >= uPaletteCount) break;
    vec3 d = labOf(uPalette[i]) - lab;
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = uPalette[i]; }
  }
  return best;
}
void main() {
  float size = max(4.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / size);
  vec2 o = (p - (cell + 0.5) * size) / size; // -0.5..0.5, y down
  vec4 s = srcAvg((cell + 0.5) * size, size);
  vec3 base = p_palette == 0 ? nearest(s.rgb) : s.rgb;
  vec3 col = base;
  // Plate edges: light from the upper left.
  float edge = 0.5 - max(abs(o.x), abs(o.y));
  float px = 1.0 / size;
  float rim = 1.0 - smoothstep(0.0, 0.06, edge);
  float lit = (o.x + o.y) > 0.0 ? -1.0 : 1.0;
  col *= 1.0 + 0.18 * lit * rim;
  col *= mix(0.55, 1.0, smoothstep(0.0, px * 1.5, edge));
  // Stud: shadow falling to the lower right, then the cylinder with a highlight on its rim.
  float r = 0.3 * p_studs;
  if (r > 0.0) {
    float shadow = smoothstep(r + 0.08, r - 0.02, length(o - vec2(0.06, 0.06)));
    col *= 1.0 - 0.3 * shadow;
    float d = length(o) - r;
    float stud = clamp(-d / px + 0.5, 0.0, 1.0);
    vec2 n = o / max(length(o), 1e-4);
    float ring = smoothstep(-0.07, 0.0, d);
    float shade = dot(n, normalize(vec2(-1.0, -1.0)));
    vec3 top = base * (1.02 + 0.1 * (0.5 - length(o + 0.08) * 2.0));
    vec3 side = base * (1.0 + 0.35 * shade);
    col = mix(col, mix(top, side, ring), stud);
    col += vec3(0.18) * stud * smoothstep(0.08, 0.0, abs(length(o + vec2(0.05)) - r * 0.72)) * step(0.3, -dot(o, vec2(1.0)));
  }
  emit(col, s.a);
}`;

const iso = /* glsl */ `${fx}
uniform float p_size;
uniform float p_shading;
uniform int p_outline;
void main() {
  float size = max(4.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy / size;
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 center = (p - g) * size;
  vec4 s = srcAvg(center, size);
  // Pointy-top hexagon split into three rhombi: top, left and right faces of a cube.
  vec2 up = vec2(g.x, -g.y);
  float ang = degrees(atan(up.y, up.x));
  if (ang < 0.0) ang += 360.0;
  float face = (ang >= 30.0 && ang < 150.0) ? 0.0 : (ang >= 150.0 && ang < 270.0) ? 1.0 : 2.0;
  float k = face == 0.0 ? 1.0 + 0.35 * p_shading : face == 1.0 ? 1.0 - 0.25 * p_shading : 1.0 - 0.55 * p_shading;
  vec3 col = clamp(s.rgb * k + (face == 0.0 ? 0.08 * p_shading : 0.0), 0.0, 1.0);
  if (p_outline == 1) {
    float R = 0.57735;
    float d = segment(g, vec2(0.0), vec2(R * cos(radians(30.0)), -R * sin(radians(30.0))));
    d = min(d, segment(g, vec2(0.0), vec2(R * cos(radians(150.0)), -R * sin(radians(150.0)))));
    d = min(d, segment(g, vec2(0.0), vec2(0.0, R)));
    float hexd = max(abs(g.x), max(abs(dot(g, vec2(0.5, 0.8660254))), abs(dot(g, vec2(0.5, -0.8660254)))));
    d = min(d, 0.5 - hexd);
    col *= mix(0.3, 1.0, clamp(d * size - 0.5, 0.0, 1.0));
  }
  emit(col, s.a);
}`;

const led = /* glsl */ `${fx}
uniform float p_size;
uniform int p_style;
uniform float p_glow;
uniform float p_gain;
void main() {
  float size = max(3.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / size);
  vec2 o = p - (cell + 0.5) * size;
  vec4 s = srcAvg((cell + 0.5) * size, size);
  vec3 c = clamp(s.rgb * p_gain, 0.0, 1.0);
  vec3 col;
  if (p_style == 0) {
    float d = length(o);
    float led = cover(d - size * 0.36);
    float halo = exp(-pow(d / (size * 0.45), 2.0)) * p_glow;
    col = c * (led * (0.85 + 0.15 * smoothstep(size * 0.36, 0.0, d)) + halo * 0.7);
  } else {
    // Three subpixel stripes per cell.
    float third = size / 3.0;
    float i = clamp(floor((o.x + size * 0.5) / third), 0.0, 2.0);
    vec2 so = vec2(o.x + size * 0.5 - (i + 0.5) * third, o.y);
    vec2 q = abs(so) - vec2(third * 0.32, size * 0.4);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - third * 0.1;
    float on = cover(d);
    vec3 channel = i == 0.0 ? vec3(c.r, 0.0, 0.0) : i == 1.0 ? vec3(0.0, c.g, 0.0) : vec3(0.0, 0.0, c.b);
    col = channel * (on + exp(-max(d, 0.0) / (third * 0.6)) * p_glow * 0.5);
  }
  emit(col, s.a);
}`;

const relief = /* glsl */ `${fx}
uniform float p_depth;
uniform float p_detail;
uniform float p_angle;
uniform int p_material;
uniform vec3 p_color;
float height(vec2 p, float lod) { return luma(srcLod(p, lod).rgb); }
void main() {
  vec2 p = gl_FragCoord.xy;
  float lod = log2(max(1.0, p_detail * uUnit));
  float e = max(1.0, p_detail * uUnit);
  float hx = height(p + vec2(e, 0.0), lod) - height(p - vec2(e, 0.0), lod);
  float hy = height(p + vec2(0.0, e), lod) - height(p - vec2(0.0, e), lod);
  vec3 n = normalize(vec3(-hx * p_depth * 6.0, -hy * p_depth * 6.0, 1.0));
  float a = radians(p_angle);
  vec3 l = normalize(vec3(cos(a), -sin(a), 0.9));
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  vec4 s = src(p);
  vec3 albedo = p_material == 0 ? vec3(0.78, 0.74, 0.68) : p_material == 1 ? p_color : s.rgb;
  float metal = p_material == 1 ? 0.8 : 0.15;
  vec3 col = albedo * (0.25 + 0.85 * diff) + vec3(spec * metal);
  emit(col, s.a);
}`;

const hexColor = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** A generic toy-brick color range (whites, greys, primaries and earth tones). */
const BRICK_COLORS = [
  "#f4f4f4", "#a0a5a9", "#6c6e68", "#1b2a34", "#c91a09", "#720e0f", "#fe8a18", "#f2cd37", "#e4cd9e", "#958a73",
  "#583927", "#bbe90b", "#4b9f4a", "#237841", "#184632", "#5a93db", "#0055bf", "#0a3463", "#fc97ac", "#81007b",
  "#6074a1", "#aee9ef", "#f6d7b3", "#cc702a",
];

export const pixelEffects: EffectDef[] = [
  {
    id: "blocks",
    name: "Blockify",
    category: "Pixel & 3D",
    description: "Big pixels as squares, rounded tiles, circles or diamonds.",
    params: [
      { key: "size", label: "Block size", type: "number", min: 2, max: 100, step: 0.5, default: 18 },
      {
        key: "shape",
        label: "Shape",
        type: "select",
        options: [
          { value: "square", label: "Square" },
          { value: "rounded", label: "Rounded" },
          { value: "circle", label: "Circle" },
          { value: "diamond", label: "Diamond" },
        ],
        default: "rounded",
      },
      { key: "gap", label: "Gap", type: "number", min: 0, max: 0.6, step: 0.01, default: 0.08 },
      { key: "levels", label: "Color levels (0 = all)", type: "number", min: 0, max: 16, step: 1, default: 0 },
      { key: "bevel", label: "Bevel", type: "toggle", default: true },
      { key: "background", label: "Background", type: "color", default: "#101010" },
    ],
    render: (ctx, u) => ctx.pass("fx-blocks", blocks, u),
  },
  {
    id: "bricks",
    name: "Toy Bricks",
    category: "Pixel & 3D",
    description: "A mosaic of studded plastic bricks with real bevels and shadows.",
    params: [
      { key: "size", label: "Brick size", type: "number", min: 4, max: 80, step: 0.5, default: 16 },
      {
        key: "palette",
        label: "Colors",
        type: "select",
        options: [
          { value: "toy", label: "Toy box" },
          { value: "photo", label: "Photo colors" },
        ],
        default: "toy",
      },
      { key: "studs", label: "Stud size", type: "number", min: 0, max: 1.4, step: 0.01, default: 1 },
    ],
    render(ctx, u) {
      const colors = new Float32Array(72);
      BRICK_COLORS.forEach((c, i) => colors.set(hexColor(c), i * 3));
      return ctx.pass("fx-bricks", bricks, { ...u, uPalette: colors, uPaletteCount: BRICK_COLORS.length });
    },
  },
  {
    id: "iso-cubes",
    name: "Iso Cubes",
    category: "Pixel & 3D",
    description: "Isometric cubes tiled across the image.",
    params: [
      { key: "size", label: "Cube size", type: "number", min: 4, max: 100, step: 0.5, default: 22 },
      { key: "shading", label: "Shading", type: "number", min: 0, max: 1, step: 0.01, default: 0.85 },
      { key: "outline", label: "Outlines", type: "toggle", default: true },
    ],
    render: (ctx, u) => ctx.pass("fx-iso", iso, u),
  },
  {
    id: "led",
    name: "LED Wall",
    category: "Pixel & 3D",
    description: "Glowing LEDs or RGB subpixels on black.",
    params: [
      { key: "size", label: "Pixel size", type: "number", min: 3, max: 50, step: 0.5, default: 10 },
      {
        key: "style",
        label: "Style",
        type: "select",
        options: [
          { value: "led", label: "Round LEDs" },
          { value: "subpixel", label: "RGB subpixels" },
        ],
        default: "led",
      },
      { key: "glow", label: "Glow", type: "number", min: 0, max: 1.5, step: 0.01, default: 0.6 },
      { key: "gain", label: "Brightness", type: "number", min: 0.5, max: 3, step: 0.05, default: 1.3 },
    ],
    render: (ctx, u) => ctx.pass("fx-led", led, u),
  },
  {
    id: "relief",
    name: "Relief",
    category: "Pixel & 3D",
    description: "Turns brightness into height and lights the surface: clay, metal or painted.",
    params: [
      { key: "depth", label: "Depth", type: "number", min: 0, max: 6, step: 0.05, default: 2.5 },
      { key: "detail", label: "Smoothness", type: "number", min: 0.5, max: 12, step: 0.1, default: 2 },
      { key: "angle", label: "Light angle", type: "number", min: 0, max: 360, step: 1, default: 135 },
      {
        key: "material",
        label: "Material",
        type: "select",
        options: [
          { value: "clay", label: "Clay" },
          { value: "metal", label: "Metal" },
          { value: "painted", label: "Painted" },
        ],
        default: "clay",
      },
      { key: "color", label: "Metal color", type: "color", default: "#c9a45c" },
    ],
    render: (ctx, u) => ctx.pass("fx-relief", relief, u),
  },
];
