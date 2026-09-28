import { fx } from "../glsl";
import type { EffectDef } from "../types";

const quantize = /* glsl */ `
vec3 quantizeLevels(vec3 c, float levels) { return levels < 2.0 ? c : floor(c * (levels - 1.0) + 0.5) / (levels - 1.0); }
`;

const crossStitch = /* glsl */ `${fx}${quantize}
uniform float p_size;
uniform float p_levels;
uniform float p_skip;
uniform vec3 p_fabric;
float strand(vec2 local, bool rising, out float along) {
  // Distance from the diagonal, in cell units; \`along\` runs 0..1 along the thread.
  float d = rising ? abs(local.x + local.y - 1.0) : abs(local.x - local.y);
  along = rising ? (local.x - local.y + 1.0) * 0.5 : (local.x + local.y) * 0.5;
  return d * 0.7071;
}
void main() {
  float size = max(3.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / size);
  vec2 local = (p - cell * size) / size;
  vec4 s = srcAvg((cell + 0.5) * size, size);
  // Aida fabric: a soft weave with holes at the stitch corners.
  vec2 w = abs(fract(p / size) - 0.5);
  float weave = 0.93 + 0.07 * sin((p.x + p.y) / size * 12.566) * sin((p.x - p.y) / size * 12.566);
  float hole = smoothstep(0.1, 0.0, length(vec2(0.5) - w));
  vec3 col = p_fabric * weave * (1.0 - 0.35 * hole);
  if (luma(s.rgb) <= p_skip && s.a > 0.05) {
    vec3 thread = quantizeLevels(s.rgb, p_levels);
    float a1, a2;
    float d1 = strand(local, false, a1);
    float d2 = strand(local, true, a2);
    // Threads are full width in the middle and pinch into the fabric holes at the corners.
    float w1 = 0.27 * (0.45 + 0.55 * smoothstep(0.0, 0.3, min(a1, 1.0 - a1)));
    float w2 = 0.27 * (0.45 + 0.55 * smoothstep(0.0, 0.3, min(a2, 1.0 - a2)));
    float width = w2;
    float px = 1.0 / size;
    float c1 = clamp((w1 - d1) / px, 0.0, 1.0);
    float c2 = clamp((w2 - d2) / px, 0.0, 1.0);
    // Twisted fibers and a rounded cross-section give each strand its sheen.
    float fibers1 = 0.85 + 0.15 * sin((a1 * 9.0 + d1 * 40.0) * PI);
    float fibers2 = 0.85 + 0.15 * sin((a2 * 9.0 + d2 * 40.0) * PI);
    float round1 = sqrt(max(0.0, 1.0 - pow(d1 / w1, 2.0)));
    float round2 = sqrt(max(0.0, 1.0 - pow(d2 / w2, 2.0)));
    col = mix(col, thread * (0.55 + 0.5 * round1) * fibers1, c1);
    // The top strand shades the one beneath it.
    col *= 1.0 - 0.35 * (1.0 - c2) * (1.0 - smoothstep(width, width * 1.8, d2)) * c1;
    col = mix(col, thread * (0.6 + 0.55 * round2) * fibers2, c2);
  }
  emit(col, s.a);
}`;

const knit = /* glsl */ `${fx}${quantize}
uniform float p_size;
uniform float p_levels;
uniform float p_fuzz;
float lobe(vec2 q, vec2 center, float lean, out float shade) {
  vec2 d = rot(lean) * (q - center);
  vec2 r = vec2(0.24, 0.58);
  float e = length(d / r);
  shade = sqrt(max(0.0, 1.0 - e * e)) * (0.8 + 0.2 * sin(d.y * 50.0 + d.x * 12.0));
  return e;
}
void main() {
  float w = max(4.0, p_size * uUnit);
  vec2 cellSize = vec2(w, w * 0.8);
  vec2 p = gl_FragCoord.xy;
  vec2 cell = floor(p / cellSize);
  vec3 col = vec3(0.0);
  float best = 1e9;
  float fuzz = (vnoise(p / (w * 0.08)) - 0.5) * p_fuzz * 0.25;
  // Each stitch is a V of two leaning loops; loops overlap the rows above and below.
  for (int dy = -1; dy <= 1; dy++) {
    vec2 c = cell + vec2(0.0, float(dy));
    vec2 q = (p - c * cellSize) / cellSize.x;
    vec3 yarn = quantizeLevels(srcAvg((c + 0.5) * cellSize, w).rgb, p_levels);
    float shadeL, shadeR;
    float eL = lobe(q, vec2(0.28, 0.5), -0.5, shadeL) + fuzz;
    float eR = lobe(q, vec2(0.72, 0.5), 0.5, shadeR) + fuzz;
    // Lower rows sit on top of the ones above them.
    float order = float(dy) * 0.01;
    if (eL < 1.0 && eL - order < best) { best = eL - order; col = yarn * (0.35 + 0.8 * shadeL); }
    if (eR < 1.0 && eR - order < best) { best = eR - order; col = yarn * (0.35 + 0.8 * shadeR); }
  }
  if (best > 1e8) col = srcAvg(p, w).rgb * 0.18;
  emit(col, src(p).a);
}`;

const voronoi = /* glsl */ `
// Jittered-grid Voronoi: nearest site, its id, and the distance to the nearest cell border (iq's two-pass method).
vec3 voronoi(vec2 x, float jitter, out vec2 siteId) {
  vec2 n = floor(x);
  vec2 f = x - n;
  vec2 mg, mr;
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = 0.5 + (hash2(n + g) - 0.5) * jitter;
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  md = 8.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = 0.5 + (hash2(n + g) - 0.5) * jitter;
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
    }
  siteId = n + mg;
  return vec3(md, x + mr);
}
`;

const tiles = /* glsl */ `${fx}${voronoi}
uniform float p_size;
uniform float p_grout;
uniform float p_irregular;
uniform float p_variation;
uniform vec3 p_groutColor;
void main() {
  float size = max(3.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 id;
  vec3 v = voronoi(p / size, p_irregular, id);
  float edge = v.x * size;
  vec3 tile = srcAvg(v.yz * size, size * 0.7).rgb;
  tile *= 1.0 + (hash(id) - 0.5) * p_variation;
  // Slightly domed tiles: brighter towards the upper left, a soft shade at the lower edge.
  float bevel = smoothstep(0.0, size * 0.25, edge);
  tile *= 0.82 + 0.18 * bevel;
  tile += (vnoise(p / (uUnit * 1.5)) - 0.5) * 0.05;
  float g = p_grout * uUnit * 0.5;
  vec3 col = mix(p_groutColor * (0.9 + 0.2 * vnoise(p / uUnit)), tile, clamp(edge - g + 0.5, 0.0, 1.0));
  emit(col, src(p).a);
}`;

const stainedGlass = /* glsl */ `${fx}${voronoi}
uniform float p_size;
uniform float p_lead;
uniform float p_saturation;
uniform float p_texture;
void main() {
  float size = max(6.0, p_size * uUnit);
  vec2 p = gl_FragCoord.xy;
  vec2 id;
  vec3 v = voronoi(p / size, 0.9, id);
  float edge = v.x * size;
  vec3 glass = saturateColor(srcAvg(v.yz * size, size * 0.6).rgb, 1.0 + p_saturation);
  // Uneven glass: thickness ripples change how much light comes through.
  float ripple = fbm(p / (size * 0.35) + id * 3.1);
  glass *= 0.75 + 0.5 * mix(0.5, ripple, p_texture);
  glass += smoothstep(0.55, 0.9, fbm(p / (size * 0.9) - id)) * 0.25 * p_texture;
  // Light through the pane is brightest in the middle, darker against the lead.
  glass *= 0.7 + 0.3 * smoothstep(0.0, size * 0.3, edge);
  float lead = p_lead * uUnit;
  float leadCover = clamp(lead - edge + 0.5, 0.0, 1.0);
  vec3 leadColor = vec3(0.07) + 0.06 * smoothstep(lead, 0.0, abs(edge - lead * 0.5));
  emit(mix(glass, leadColor, leadCover), src(p).a);
}`;

const paperCutMain = /* glsl */ `${fx}
uniform sampler2D uBlur;
uniform float p_layers;
uniform float p_shadow;
uniform int p_palette;
uniform vec3 p_colorA;
uniform vec3 p_colorB;
float levelAt(vec2 p) {
  vec4 b = unpremul(texture(uBlur, p / uSize));
  return min(p_layers - 1.0, floor(luma(b.rgb) * p_layers));
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float level = levelAt(p);
  vec2 dir = normalize(vec2(1.0, 1.4));
  // Higher (brighter) sheets cast shadows onto the lower ones.
  float shadow = 0.0;
  float len = p_shadow * uUnit;
  for (int i = 1; i <= 12; i++) {
    float t = float(i) / 12.0;
    float above = levelAt(p - dir * len * t) - level;
    if (above > 0.0) shadow = max(shadow, (1.0 - t) * min(1.0, above * 0.6 + 0.4));
  }
  float rim = levelAt(p + dir * max(1.0, uUnit)) < level ? 1.0 : 0.0;
  vec3 base;
  float t = level / max(p_layers - 1.0, 1.0);
  if (p_palette == 0) {
    vec3 c = unpremul(texture(uBlur, p / uSize)).rgb;
    float l = max(luma(c), 1e-3);
    base = clamp(c * ((t * 0.85 + 0.12) / l), 0.0, 1.0);
    base = saturateColor(base, 1.15);
  } else {
    base = mix(p_colorA, p_colorB, t);
  }
  float grain = 0.96 + 0.06 * fbm(p / (uUnit * 2.0));
  vec3 col = base * grain * (1.0 - 0.45 * shadow) + rim * 0.07;
  emit(col, src(p).a);
}`;

export const craftEffects: EffectDef[] = [
  {
    id: "cross-stitch",
    name: "Cross Stitch",
    category: "Textile & craft",
    description: "Embroidered X stitches on Aida fabric.",
    params: [
      { key: "size", label: "Stitch size", type: "number", min: 3, max: 50, step: 0.5, default: 9 },
      { key: "levels", label: "Thread colors", type: "number", min: 2, max: 16, step: 1, default: 6 },
      { key: "skip", label: "Leave highlights bare", type: "number", min: 0.5, max: 1, step: 0.01, default: 1 },
      { key: "fabric", label: "Fabric", type: "color", default: "#efe8d6" },
    ],
    render: (ctx, u) => ctx.pass("fx-cross-stitch", crossStitch, u),
  },
  {
    id: "knit",
    name: "Knitted",
    category: "Textile & craft",
    description: "Rows of V stitches in chunky yarn.",
    params: [
      { key: "size", label: "Stitch size", type: "number", min: 4, max: 60, step: 0.5, default: 14 },
      { key: "levels", label: "Yarn colors", type: "number", min: 2, max: 16, step: 1, default: 7 },
      { key: "fuzz", label: "Fuzz", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    render: (ctx, u) => ctx.pass("fx-knit", knit, u),
  },
  {
    id: "tile-mosaic",
    name: "Tile Mosaic",
    category: "Textile & craft",
    description: "Irregular stone tiles set in grout.",
    params: [
      { key: "size", label: "Tile size", type: "number", min: 4, max: 80, step: 0.5, default: 14 },
      { key: "grout", label: "Grout width", type: "number", min: 0, max: 6, step: 0.1, default: 1.4 },
      { key: "irregular", label: "Irregularity", type: "number", min: 0, max: 1, step: 0.01, default: 0.75 },
      { key: "variation", label: "Tile variation", type: "number", min: 0, max: 0.5, step: 0.01, default: 0.18 },
      { key: "groutColor", label: "Grout", type: "color", default: "#d9d2c3" },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-tiles", tiles, u),
  },
  {
    id: "paper-cut",
    name: "Paper Cutout",
    category: "Textile & craft",
    description: "Stacked sheets of cut paper casting soft shadows.",
    params: [
      { key: "layers", label: "Sheets", type: "number", min: 2, max: 10, step: 1, default: 5 },
      { key: "smooth", label: "Smoothness", type: "number", min: 1, max: 30, step: 0.5, default: 6 },
      { key: "shadow", label: "Shadow", type: "number", min: 0, max: 30, step: 0.5, default: 9 },
      {
        key: "palette",
        label: "Colors",
        type: "select",
        options: [
          { value: "photo", label: "Photo colors" },
          { value: "duo", label: "Two colors" },
        ],
        default: "photo",
      },
      { key: "colorA", label: "Deep", type: "color", default: "#1d3557" },
      { key: "colorB", label: "Light", type: "color", default: "#f1c27d" },
    ],
    render(ctx, u, params) {
      const blur = ctx.blur(ctx.input, Number(params.smooth) * ctx.unit);
      const out = ctx.pass("fx-paper-cut", paperCutMain, u, { uBlur: blur });
      ctx.release(blur);
      return out;
    },
  },
];

export const glassExtras: EffectDef[] = [
  {
    id: "stained-glass",
    name: "Stained Glass",
    category: "Light & glass",
    description: "Glowing panes of colored glass held in lead.",
    params: [
      { key: "size", label: "Pane size", type: "number", min: 8, max: 150, step: 1, default: 38 },
      { key: "lead", label: "Lead width", type: "number", min: 0.5, max: 8, step: 0.1, default: 2.4 },
      { key: "saturation", label: "Color boost", type: "number", min: 0, max: 1.5, step: 0.05, default: 0.5 },
      { key: "texture", label: "Glass texture", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 0 },
    ],
    render: (ctx, u) => ctx.pass("fx-stained-glass", stainedGlass, u),
  },
];
