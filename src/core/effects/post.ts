import type { Target } from "@/core/gpu/gl";
import { fx } from "./glsl";
import type { EffectContext, EffectParams, ParamDef } from "./types";

/**
 * Post-processing shared by every effect: bloom (bright parts glow) and film
 * grain, applied to the effect's output. Both are off by default, so documents
 * saved before they existed render exactly as before.
 */
const GROUP = "Post-processing";
const whenBloom = { key: "post_bloom", equals: true } as const;
const whenGrain = { key: "post_grain", equals: true } as const;

export const POST_PARAMS: readonly ParamDef[] = [
  { key: "post_bloom", label: "Bloom", type: "toggle", default: false, group: GROUP },
  { key: "post_threshold", label: "Bloom threshold", short: "Threshold", type: "number", min: 0, max: 1, step: 0.01, default: 0.3, group: GROUP, showIf: whenBloom },
  { key: "post_soft", label: "Bloom softness", short: "Softness", type: "number", min: 0, max: 1, step: 0.01, default: 0.2, group: GROUP, showIf: whenBloom },
  { key: "post_intensity", label: "Bloom intensity", short: "Intensity", type: "number", min: 0, max: 4, step: 0.05, default: 1.5, group: GROUP, showIf: whenBloom },
  { key: "post_radius", label: "Bloom radius", short: "Radius", type: "number", min: 1, max: 60, step: 0.5, default: 12, group: GROUP, showIf: whenBloom },
  { key: "post_grain", label: "Grain", type: "toggle", default: false, group: GROUP },
  { key: "post_grainAmount", label: "Grain amount", short: "Intensity", type: "number", min: 0, max: 100, step: 1, default: 35, group: GROUP, showIf: whenGrain },
  { key: "post_grainSize", label: "Grain size", short: "Size", type: "number", min: 1, max: 8, step: 0.5, default: 2, group: GROUP, showIf: whenGrain },
];

const num = (params: EffectParams, key: string) => {
  const v = params[key];
  const def = POST_PARAMS.find((p) => p.key === key)!;
  return typeof v === "number" ? v : (def.default as number);
};

/** Bright parts above a soft-kneed threshold (premultiplied in and out). */
const extract = /* glsl */ `${fx}
uniform sampler2D uImage;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec4 c = texture(uImage, vUv);
  float br = max(c.r, max(c.g, c.b));
  float knee = max(uKnee, 1e-4);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float k = max(soft, br - uThreshold) / max(br, 1e-4);
  outColor = c * clamp(k, 0.0, 1.0);
}`;

/** Adds the glow (two blur widths, so it has a core and a halo), then the grain. */
const finish = /* glsl */ `${fx}
uniform sampler2D uImage;
uniform sampler2D uNear;
uniform sampler2D uFar;
uniform float uBloom;
uniform float uIntensity;
uniform float uGrain;
uniform float uGrainPx;
uniform float uGrainMoves;
void main() {
  vec4 c = texture(uImage, vUv);
  if (uBloom > 0.5) {
    vec4 b = texture(uNear, vUv) * 0.6 + texture(uFar, vUv) * 0.4;
    vec3 add = b.rgb * uIntensity;
    // Glow spills past the effect's edges onto transparent pixels.
    float a = clamp(c.a + (1.0 - c.a) * max(add.r, max(add.g, add.b)), 0.0, 1.0);
    c = vec4(min(c.rgb + add, vec3(a)), a);
  }
  if (uGrain > 0.0 && c.a > 0.0) {
    vec2 cell = floor(gl_FragCoord.xy / uGrainPx);
    float n = uGrainMoves > 0.5 ? frameHash(cell, 24.0) : hash(cell);
    n = n + hash(cell + 41.7) - 1.0; // triangular noise, -1..1
    vec3 rgb = c.rgb / c.a;
    // Strongest in the mid-tones, like film.
    float l = luma(rgb);
    float w = 1.0 - pow(abs(2.0 * l - 1.0), 2.0) * 0.6;
    rgb = clamp(rgb + n * uGrain * 0.22 * w, 0.0, 1.0);
    c = vec4(rgb * c.a, c.a);
  }
  outColor = c;
}`;

export function postActive(params: EffectParams): boolean {
  return params.post_bloom === true || (params.post_grain === true && num(params, "post_grainAmount") > 0);
}

/** Applies bloom and grain to `image` (released here) and returns a new target. */
export function applyPost(ctx: EffectContext, image: Target, params: EffectParams, animated: boolean): Target {
  if (!postActive(params)) return image;
  const bloom = params.post_bloom === true;
  let near: Target | null = null;
  let far: Target | null = null;
  if (bloom) {
    const threshold = num(params, "post_threshold");
    const bright = ctx.pass("fx-post-extract", extract, { uThreshold: threshold, uKnee: Math.max(threshold, 0.05) * num(params, "post_soft") }, { uImage: image });
    const sigma = Math.max(0.5, num(params, "post_radius") * ctx.unit * 0.5);
    near = ctx.blur(bright, sigma);
    far = ctx.blur(bright, sigma * 3);
    ctx.release(bright);
  }
  const grain = params.post_grain === true ? num(params, "post_grainAmount") / 100 : 0;
  const out = ctx.pass(
    "fx-post-finish",
    finish,
    {
      uBloom: bloom ? 1 : 0,
      uIntensity: num(params, "post_intensity"),
      uGrain: grain,
      uGrainPx: Math.max(1, num(params, "post_grainSize") * ctx.unit * 0.5),
      uGrainMoves: animated ? 1 : 0,
    },
    { uImage: image, uNear: near ?? image, uFar: far ?? image },
  );
  ctx.release(image);
  if (near) ctx.release(near);
  if (far) ctx.release(far);
  return out;
}
