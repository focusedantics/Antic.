import type { Basic, Detail, Effects, LocalAdjustments, Optics } from "./recipe";

export type Range = { readonly min: number; readonly max: number; readonly step: number; readonly label: string };

const r = (label: string, min: number, max: number, step = 1): Range => ({ label, min, max, step });

export const basicRanges: Record<keyof Basic, Range> = {
  exposure: r("Exposure", -5, 5, 0.01),
  contrast: r("Contrast", -100, 100),
  highlights: r("Highlights", -100, 100),
  shadows: r("Shadows", -100, 100),
  whites: r("Whites", -100, 100),
  blacks: r("Blacks", -100, 100),
  texture: r("Texture", -100, 100),
  clarity: r("Clarity", -100, 100),
  dehaze: r("Dehaze", -100, 100),
  vibrance: r("Vibrance", -100, 100),
  saturation: r("Saturation", -100, 100),
};

export const detailRanges: Record<keyof Detail, Range> = {
  sharpenAmount: r("Amount", 0, 150),
  sharpenRadius: r("Radius", 0.5, 3, 0.1),
  sharpenDetail: r("Detail", 0, 100),
  sharpenMasking: r("Masking", 0, 100),
  noiseLuminance: r("Luminance", 0, 100),
  noiseDetail: r("Detail", 0, 100),
  noiseColor: r("Color", 0, 100),
};

export const opticsRanges: Record<Exclude<keyof Optics, "removeChromaticAberration">, Range> = {
  distortion: r("Distortion", -100, 100),
  vignetting: r("Vignetting", -100, 100),
  vignettingMidpoint: r("Midpoint", 0, 100),
};

export const effectsRanges: Record<keyof Effects, Range> = {
  vignetteAmount: r("Amount", -100, 100),
  vignetteMidpoint: r("Midpoint", 0, 100),
  vignetteRoundness: r("Roundness", -100, 100),
  vignetteFeather: r("Feather", 0, 100),
  grainAmount: r("Amount", 0, 100),
  grainSize: r("Size", 0, 100),
  grainRoughness: r("Roughness", 0, 100),
};

export const localRanges: Record<keyof LocalAdjustments, Range> = {
  temperature: r("Temp", -100, 100),
  tint: r("Tint", -100, 100),
  exposure: r("Exposure", -4, 4, 0.01),
  contrast: r("Contrast", -100, 100),
  highlights: r("Highlights", -100, 100),
  shadows: r("Shadows", -100, 100),
  whites: r("Whites", -100, 100),
  blacks: r("Blacks", -100, 100),
  texture: r("Texture", -100, 100),
  clarity: r("Clarity", -100, 100),
  dehaze: r("Dehaze", -100, 100),
  hue: r("Hue", -180, 180),
  saturation: r("Saturation", -100, 100),
};

export const parametricRanges = {
  highlights: r("Highlights", -100, 100),
  lights: r("Lights", -100, 100),
  darks: r("Darks", -100, 100),
  shadows: r("Shadows", -100, 100),
};

export const temperatureRange = { raw: r("Temp", 2000, 50000, 50), rendered: r("Temp", -100, 100) };
export const tintRange = { raw: r("Tint", -150, 150), rendered: r("Tint", -100, 100) };

export const mixerColors = [
  { id: "red", label: "Red", swatch: "#e0473e" },
  { id: "orange", label: "Orange", swatch: "#e8883a" },
  { id: "yellow", label: "Yellow", swatch: "#e3cf45" },
  { id: "green", label: "Green", swatch: "#5bbf4b" },
  { id: "aqua", label: "Aqua", swatch: "#45c7c4" },
  { id: "blue", label: "Blue", swatch: "#3f6fe0" },
  { id: "purple", label: "Purple", swatch: "#8a4fd6" },
  { id: "magenta", label: "Magenta", swatch: "#d34fb8" },
] as const;
