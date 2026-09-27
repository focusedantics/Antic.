import { createId } from "@/lib/id";
import { deletePreset, listPresets, type PresetRecord, putPreset } from "@/core/catalog/db";
import { identityCurve } from "./defaults";
import type { RecipeClip } from "./operations";
import type { DevelopRecipe, RecipeGroup } from "./recipe";

/**
 * Built-in looks. Each touches only the groups it names, so applying one keeps
 * the photo's own white balance, crop and masks.
 */
const builtIn = (name: string, group: string, values: Partial<DevelopRecipe>): PresetRecord => ({
  id: `builtin:${name}`,
  name,
  group,
  createdAt: 0,
  clip: { groups: Object.keys(values) as RecipeGroup[], values, raw: false },
});

const curve = (...pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));

export const BUILT_IN_PRESETS: PresetRecord[] = [
  builtIn("Punchy", "Color", {
    basic: { exposure: 0, contrast: 25, highlights: -30, shadows: 20, whites: 10, blacks: -10, texture: 10, clarity: 12, dehaze: 5, vibrance: 25, saturation: 5 },
  }),
  builtIn("Soft Portrait", "Color", {
    basic: { exposure: 0.1, contrast: -10, highlights: -25, shadows: 15, whites: 0, blacks: 5, texture: -15, clarity: -10, dehaze: 0, vibrance: 10, saturation: -5 },
    colorMixer: { hue: [0, 5, 0, 0, 0, 0, 0, 0], saturation: [-5, -10, 0, 0, 0, 0, 0, 0], luminance: [5, 10, 0, 0, 0, 0, 0, 0] },
  }),
  builtIn("Matte Fade", "Film", {
    toneCurve: { parametric: { highlights: -10, lights: 0, darks: 10, shadows: 15 }, master: curve([0, 0.08], [0.25, 0.26], [0.75, 0.76], [1, 0.95]), red: identityCurve, green: identityCurve, blue: identityCurve },
    basic: { exposure: 0, contrast: -15, highlights: -20, shadows: 10, whites: -10, blacks: 10, texture: 0, clarity: 0, dehaze: -5, vibrance: 0, saturation: -15 },
  }),
  builtIn("Warm Film", "Film", {
    colorGrading: {
      shadows: { hue: 200, saturation: 12, luminance: 0 },
      midtones: { hue: 35, saturation: 8, luminance: 0 },
      highlights: { hue: 45, saturation: 18, luminance: 0 },
      global: { hue: 0, saturation: 0, luminance: 0 },
      blending: 60,
      balance: 10,
    },
    effects: { vignetteAmount: -12, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 60, grainAmount: 18, grainSize: 30, grainRoughness: 50 },
  }),
  builtIn("Teal & Orange", "Color", {
    colorGrading: {
      shadows: { hue: 190, saturation: 25, luminance: 0 },
      midtones: { hue: 0, saturation: 0, luminance: 0 },
      highlights: { hue: 35, saturation: 22, luminance: 0 },
      global: { hue: 0, saturation: 0, luminance: 0 },
      blending: 50,
      balance: 0,
    },
    colorMixer: { hue: [0, 0, 0, 30, 20, -10, 0, 0], saturation: [0, 10, -20, -30, 10, 15, 0, 0], luminance: [0, 5, 0, 0, 0, -10, 0, 0] },
  }),
  builtIn("B&W Contrast", "Black & White", {
    profile: "monochrome",
    basic: { exposure: 0, contrast: 35, highlights: -20, shadows: 10, whites: 15, blacks: -20, texture: 10, clarity: 20, dehaze: 0, vibrance: 0, saturation: 0 },
  }),
  builtIn("B&W Soft", "Black & White", {
    profile: "monochrome",
    basic: { exposure: 0.1, contrast: -10, highlights: -30, shadows: 25, whites: 0, blacks: 10, texture: 0, clarity: -5, dehaze: 0, vibrance: 0, saturation: 0 },
    effects: { vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, grainAmount: 25, grainSize: 25, grainRoughness: 60 },
  }),
];

export async function allPresets(): Promise<PresetRecord[]> {
  const user = await listPresets();
  return [...BUILT_IN_PRESETS, ...user.sort((a, b) => a.name.localeCompare(b.name))];
}

export async function savePreset(name: string, group: string, clip: RecipeClip) {
  const record: PresetRecord = { id: createId("preset"), name: name.trim() || "Preset", group: group.trim() || "User Presets", createdAt: Date.now(), clip };
  await putPreset(record);
  return record;
}

export async function removePreset(id: string) {
  if (!id.startsWith("builtin:")) await deletePreset(id);
}

/** Presets exported as JSON, and imported back through the recipe sanitizer on apply. */
export function presetFile(presets: PresetRecord[]) {
  return new Blob([JSON.stringify({ format: "focused-presets", version: 1, presets }, null, 2)], { type: "application/json" });
}

export function parsePresetFile(text: string): PresetRecord[] {
  const data = JSON.parse(text) as { format?: string; presets?: unknown[] };
  if (data.format !== "focused-presets" || !Array.isArray(data.presets)) throw new Error("Not a Focused preset file");
  return data.presets
    .filter((p): p is PresetRecord => !!p && typeof p === "object" && typeof (p as PresetRecord).name === "string" && !!(p as PresetRecord).clip)
    .map((p) => ({ ...p, id: createId("preset"), createdAt: Date.now() }));
}
