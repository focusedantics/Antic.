import type { ColorGrading, ColorMixer, GradeWheel } from "@/core/develop/recipe";

/**
 * Oklab hue angles of the eight full-saturation sRGB anchor colors (red…magenta),
 * from OpenLight (src/features/color-mixer/model.ts, MIT, © 2026 roprgm).
 */
export const MIXER_ANGLES = [29.23389, 52.77574, 109.76923, 142.49534, 194.76895, 264.05202, 293.77405, 328.36342];

export function isMixerActive(m: ColorMixer) {
  return [...m.hue, ...m.saturation, ...m.luminance].some((v) => v !== 0);
}

/** uMixer[8]: (hue, saturation, luminance, anchor angle). */
export function mixerUniform(m: ColorMixer): Float32Array {
  const out = new Float32Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = m.hue[i];
    out[i * 4 + 1] = m.saturation[i];
    out[i * 4 + 2] = m.luminance[i];
    out[i * 4 + 3] = MIXER_ANGLES[i];
  }
  return out;
}

function hsvToRgb(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 1 - Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

const srgbToLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** Unit Oklab (a, b) direction of a hue on the color wheel. */
export function hueDirection(hue: number): [number, number] {
  const [r, g, b] = hsvToRgb(((hue % 360) + 360) % 360).map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const len = Math.hypot(A, B) || 1;
  return [A / len, B / len];
}

const wheel = (w: GradeWheel, strength = 0.06): [number, number, number] => {
  const [a, b] = hueDirection(w.hue);
  const s = (w.saturation / 100) * strength;
  return [a * s, b * s, w.luminance / 100];
};

export function isGradingActive(g: ColorGrading) {
  return [g.shadows, g.midtones, g.highlights, g.global].some((w) => w.saturation !== 0 || w.luminance !== 0);
}

export function gradingUniforms(g: ColorGrading) {
  return {
    uGradeShadows: wheel(g.shadows),
    uGradeMidtones: wheel(g.midtones),
    uGradeHighlights: wheel(g.highlights),
    uGradeGlobal: wheel(g.global, 0.04),
    uGradeBalance: [g.balance / 100, 0.08 + (g.blending / 100) * 0.4],
  };
}
