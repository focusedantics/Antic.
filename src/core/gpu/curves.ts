import type { Curve, ParametricCurve, ToneCurve } from "@/core/develop/recipe";
import { clamp, interpolatePchip } from "@/lib/math";

export const LUT_SIZE = 1024;

const identity = (c: Curve) => c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;

export function isToneCurveActive(tc: ToneCurve) {
  const p = tc.parametric;
  return !!(p.highlights || p.lights || p.darks || p.shadows) || !identity(tc.master) || !identity(tc.red) || !identity(tc.green) || !identity(tc.blue);
}

/**
 * Lightroom-style parametric curve: four regions split at 25/50/75 %, each
 * lifting or lowering its part of the tonal range with a smooth bump.
 */
export function parametric(p: ParametricCurve) {
  const bump = (x: number, center: number, width: number) => {
    const d = (x - center) / width;
    return Math.abs(d) >= 1 ? 0 : (1 - d * d) ** 2;
  };
  return (x: number) =>
    clamp(
      x +
        0.2 *
          ((p.shadows / 100) * bump(x, 0.125, 0.25) +
            (p.darks / 100) * bump(x, 0.375, 0.25) +
            (p.lights / 100) * bump(x, 0.625, 0.25) +
            (p.highlights / 100) * bump(x, 0.875, 0.25)) *
          (x > 0 && x < 1 ? 1 : 0),
    );
}

/** RGBA LUT over perceptual 0..1: R/G/B are channel curves after the master curve, A is the master alone. */
export function bakeCurves(tc: ToneCurve): Float32Array {
  const par = parametric(tc.parametric);
  const master = interpolatePchip(tc.master);
  const red = interpolatePchip(tc.red);
  const green = interpolatePchip(tc.green);
  const blue = interpolatePchip(tc.blue);
  const out = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    const m = clamp(master(par(x)));
    out[i * 4] = clamp(red(m));
    out[i * 4 + 1] = clamp(green(m));
    out[i * 4 + 2] = clamp(blue(m));
    out[i * 4 + 3] = m;
  }
  return out;
}

/** Float32 → IEEE half bits, for uploading float data into RGBA16F textures. */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | (mant + 0x1000) >> 13;
  }
  if (exp >= 31) return sign | 0x7c00;
  // Rounding can carry into the exponent; that is still the correct half value.
  return (sign | (exp << 10)) + ((mant + 0x1000) >> 13);
}

export function toHalfArray(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i]);
  return out;
}
