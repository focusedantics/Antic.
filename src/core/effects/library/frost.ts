import { fx } from "../glsl";
import type { EffectDef } from "../types";

/**
 * Frosted glass: the photo seen through textured, sand-blasted glass. Every pixel looks
 * through a random spot nearby (the frosting scatters light), so edges break up into
 * speckles; a slow warp makes the shapes melt like pebbled glass; grain covers it like
 * printed paper. Shown as a duotone (ink on paper, the poster look) or in its own colours.
 */
const frost = /* glsl */ `${fx}
uniform sampler2D uSoft;
uniform float p_frost;
uniform float p_ripple;
uniform float p_rippleSize;
uniform float p_grain;
uniform int p_tone;
uniform vec3 p_ink;
uniform vec3 p_paper;
uniform float p_contrast;
uniform float p_lightness;
void main() {
  vec2 p = gl_FragCoord.xy;
  // The glass's slow bumps: a smooth warp from layered noise.
  float s = max(2.0, p_rippleSize * uUnit);
  vec2 warp = vec2(fbm(p / s), fbm(p / s + 19.7)) - 0.5;
  // The frosting: each pixel looks through a random spot within the frost radius.
  vec2 h = hash2(p);
  float r = p_frost * uUnit * sqrt(h.x);
  float a = TAU * h.y;
  vec2 q = p + warp * p_ripple * s * 1.5 + vec2(cos(a), sin(a)) * r;
  vec4 c = unpremul(texture(uSoft, q / uSize));
  // Grain, like ink on rough paper: one part stipples where ink meets paper, one part is
  // a neutral speckle over everything (so the paper stays the paper's colour).
  float stipple = (hash(p + 31.7) - 0.5) * p_grain;
  float speckle = (hash(p + 77.3) - 0.5) * p_grain * 0.3;
  if (p_tone == 0) {
    // Dark parts take the ink, light parts the paper, re-centred on the photo's own average
    // brightness (unclamped until the end, so lightness moves the whole range and the
    // darkest parts can still reach full ink).
    float l = clamp((luma(c.rgb) - meanLuma()) * p_contrast + 0.5 + p_lightness + stipple, 0.0, 1.0);
    emit(mix(p_ink, p_paper, l) * (1.0 + speckle), c.a);
  } else {
    emit(c.rgb * (1.0 + speckle) + stipple * 0.4, c.a);
  }
}`;

const duotone = { key: "tone", equals: "duotone" } as const;

export const frostEffects: EffectDef[] = [
  {
    id: "frosted-glass",
    name: "Frosted Glass",
    category: "Light & glass",
    description: "The photo behind sand-blasted glass: speckled, melting edges and grain, as a two-colour print or in its own colours.",
    params: [
      { key: "frost", label: "Frost", type: "number", min: 0, max: 60, step: 0.5, default: 16 },
      { key: "soften", label: "Softness", type: "number", min: 0, max: 40, step: 0.5, default: 5 },
      { key: "ripple", label: "Ripple", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      { key: "rippleSize", label: "Ripple size", type: "number", min: 4, max: 150, step: 1, default: 40 },
      { key: "grain", label: "Grain", type: "number", min: 0, max: 1, step: 0.01, default: 0.45 },
      {
        key: "tone",
        label: "Colour",
        type: "select",
        options: [
          { value: "duotone", label: "Two colours (ink on paper)" },
          { value: "photo", label: "The photo's own" },
        ],
        default: "duotone",
      },
      { key: "ink", label: "Ink", type: "color", default: "#1f4d3a", showIf: duotone },
      { key: "paper", label: "Paper", type: "color", default: "#e4e4e1", showIf: duotone },
      { key: "contrast", label: "Contrast", type: "number", min: 0.5, max: 4, step: 0.05, default: 1.6, showIf: duotone },
      { key: "lightness", label: "Lightness", type: "number", min: -0.5, max: 0.6, step: 0.01, default: 0.3, showIf: duotone },
      { key: "seed", label: "Seed", type: "number", min: 0, max: 99, step: 1, default: 7 },
    ],
    render(ctx, u, params) {
      const soft = ctx.blur(ctx.input, Number(params.soften) * ctx.unit);
      const out = ctx.pass("fx-frosted-glass", frost, u, { uSoft: soft });
      ctx.release(soft);
      return out;
    },
  },
];
