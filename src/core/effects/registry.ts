import { analogEffects } from "./library/analog";
import { blurEffects } from "./library/blur";
import { craftEffects, glassExtras } from "./library/craft";
import { edgeEffects } from "./library/edges";
import { experimentalEffects } from "./library/experimental";
import { halftoneEffects } from "./library/halftone";
import { interfaceEffects } from "./library/interface";
import { lightEffects } from "./library/light";
import { liquidEffects } from "./library/liquid";
import { motionEffects } from "./library/motion";
import { pixelEffects } from "./library/pixel";
import { typeEffects } from "./library/type";
import { POST_PARAMS } from "./post";
import { defaultParams, EFFECT_CATEGORIES, type EffectDef, type EffectInstance, sanitizeParams } from "./types";

/** Every effect also gets the shared post-processing controls (bloom and grain). */
const withPost = (def: EffectDef): EffectDef => ({ ...def, params: [...def.params, ...POST_PARAMS] });

export const EFFECTS: readonly EffectDef[] = [
  ...blurEffects,
  ...lightEffects,
  ...liquidEffects,
  ...glassExtras,
  ...typeEffects,
  ...halftoneEffects,
  ...craftEffects,
  ...pixelEffects,
  ...edgeEffects,
  ...analogEffects,
  ...experimentalEffects,
  ...interfaceEffects,
  ...motionEffects,
]
  .map(withPost)
  .sort((a, b) => EFFECT_CATEGORIES.indexOf(a.category) - EFFECT_CATEGORIES.indexOf(b.category));

const byId = new Map(EFFECTS.map((e) => [e.id, e]));

export const effectById = (id: string): EffectDef | undefined => byId.get(id);

export const PICKS: readonly string[] = ["liquid-glass", "liquid-metal", "snow", "sparkles", "film", "ascii", "bricks", "halftone-cmyk", "fluted-glass", "contours", "tracking", "cross-stitch", "vhs", "dither", "neon", "risograph", "stained-glass", "lens-blur", "tilt-shift"];

export function newEffect(id: string): EffectInstance | null {
  const def = byId.get(id);
  return def ? { id, params: { ...defaultParams(def), ...def.initial } } : null;
}

/** Validates an effect from an untrusted document; unknown effects are dropped. */
export function sanitizeEffect(v: unknown): EffectInstance | null {
  const e = v && typeof v === "object" ? (v as { id?: unknown; params?: unknown }) : null;
  const def = typeof e?.id === "string" ? byId.get(e.id) : undefined;
  return def ? { id: def.id, params: sanitizeParams(def, e!.params) } : null;
}
