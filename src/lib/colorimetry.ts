import { invert3, type Mat3, mul3, mulVec3 } from "./math";

/**
 * White balance colorimetry. The develop pipeline works in linear Rec.2020 (D65).
 * A temperature/tint pair names an illuminant; changing it applies a Bradford
 * chromatic adaptation between the as-shot illuminant and the requested one.
 */

export type Xy = { x: number; y: number };

/** Planckian locus chromaticity, Kim et al. cubic spline fit (1667 K – 25000 K). */
export function planckianXy(kelvin: number): Xy {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const t = 1e3 / T;
  const x =
    T <= 4000
      ? -0.2661239 * t ** 3 - 0.2343589 * t ** 2 + 0.8776956 * t + 0.17991
      : -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.24039;
  let y: number;
  if (T <= 2222) y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}

const xyToUv = ({ x, y }: Xy) => {
  const d = -2 * x + 12 * y + 3;
  return { u: (4 * x) / d, v: (6 * y) / d };
};
const uvToXy = (u: number, v: number): Xy => {
  const d = 2 * u - 8 * v + 4;
  return { x: (3 * u) / d, y: (2 * v) / d };
};

/**
 * Tint moves perpendicular to the locus in CIE 1960 uv. Positive tint means the
 * illuminant is assumed greener, so the correction pushes the photo toward magenta,
 * matching Lightroom's slider direction. One tint unit is 1/3000 Δuv (±150 ≈ ±0.05).
 */
export const TINT_SCALE = 1 / 3000;

export function illuminantXy(kelvin: number, tint: number): Xy {
  const a = xyToUv(planckianXy(kelvin));
  const b = xyToUv(planckianXy(kelvin + 10));
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const len = Math.hypot(du, dv) || 1;
  // Normal pointing to +v (toward green, above the locus).
  const nu = -dv / len;
  const nv = du / len;
  const sign = nv >= 0 ? 1 : -1;
  const duv = tint * TINT_SCALE;
  return uvToXy(a.u + nu * sign * duv, a.v + nv * sign * duv);
}

/** Inverse of illuminantXy by Newton iterations on temperature, then Δuv for tint. */
export function xyToTemperatureTint(xy: Xy): { temperature: number; tint: number } {
  const target = xyToUv(xy);
  let best = { T: 5000, dist: Infinity };
  // Coarse search in mired space, then refine.
  for (let mired = 40; mired <= 600; mired += 2) {
    const T = 1e6 / mired;
    const p = xyToUv(planckianXy(T));
    const dist = Math.hypot(p.u - target.u, p.v - target.v);
    if (dist < best.dist) best = { T, dist };
  }
  let lo = 1e6 / (1e6 / best.T + 2);
  let hi = 1e6 / (1e6 / best.T - 2);
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d = (T: number) => {
      const p = xyToUv(planckianXy(T));
      return Math.hypot(p.u - target.u, p.v - target.v);
    };
    if (d(m1) < d(m2)) hi = m2;
    else lo = m1;
  }
  const T = (lo + hi) / 2;
  const a = xyToUv(planckianXy(T));
  const b = xyToUv(planckianXy(T + 10));
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const len = Math.hypot(du, dv) || 1;
  const nu = -dv / len;
  const nv = du / len;
  const sign = nv >= 0 ? 1 : -1;
  const duv = ((target.u - a.u) * nu + (target.v - a.v) * nv) * sign;
  return { temperature: Math.round(T), tint: Math.round(duv / TINT_SCALE) };
}

export function xyToXYZ({ x, y }: Xy): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

export function XYZToXy([X, Y, Z]: readonly [number, number, number]): Xy {
  const s = X + Y + Z || 1;
  return { x: X / s, y: Y / s };
}

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = invert3(BRADFORD);

/** Linear Rec.2020 (D65) to XYZ, row-major. */
export const REC2020_TO_XYZ: Mat3 = [
  0.636958, 0.1446169, 0.1688810, 0.2627002, 0.6779981, 0.0593017, 0, 0.0280727, 1.0609851,
];
export const XYZ_TO_REC2020 = invert3(REC2020_TO_XYZ);
export const SRGB_TO_XYZ: Mat3 = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
];
export const XYZ_TO_SRGB = invert3(SRGB_TO_XYZ);
export const SRGB_TO_REC2020 = mul3(XYZ_TO_REC2020, SRGB_TO_XYZ);
export const REC2020_TO_SRGB = invert3(SRGB_TO_REC2020);

/**
 * Rec.2020-space matrix that re-balances a photo rendered for `from` so that
 * `to` becomes neutral instead. Choosing a warmer `to` than the as-shot white
 * makes the photo warmer, like the Temperature slider in Lightroom.
 */
export function whiteBalanceMatrix(from: Xy, to: Xy): Mat3 {
  const src = mulVec3(BRADFORD, xyToXYZ(from));
  const dst = mulVec3(BRADFORD, xyToXYZ(to));
  // A neutral under `to` should map to the white that `from` currently maps to.
  const diag: Mat3 = [src[0] / dst[0], 0, 0, 0, src[1] / dst[1], 0, 0, 0, src[2] / dst[2]];
  const lms = mul3(BRADFORD_INV, mul3(diag, BRADFORD));
  return mul3(XYZ_TO_REC2020, mul3(lms, REC2020_TO_XYZ));
}

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** As-shot illuminant from LibRaw's camera matrix and white-balance multipliers. */
export function asShotFromCamera(
  camXyz: readonly (readonly number[])[] | undefined,
  camMul: readonly number[] | undefined,
): { temperature: number; tint: number } | null {
  if (!camXyz || !camMul || camXyz.length < 3 || camMul.length < 3) return null;
  const m: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m.push(Number(camXyz[r][c]) || 0);
  if (m.every((v) => v === 0) || camMul.slice(0, 3).some((v) => !(v > 0))) return null;
  try {
    const xyzToCam = m as unknown as Mat3;
    const camToXyz = invert3(xyzToCam);
    const neutral: [number, number, number] = [1 / camMul[0], 1 / camMul[1], 1 / camMul[2]];
    const XYZ = mulVec3(camToXyz, neutral);
    if (XYZ.some((v) => !Number.isFinite(v)) || XYZ[1] <= 0) return null;
    const result = xyToTemperatureTint(XYZToXy(XYZ));
    if (!(result.temperature > 1500 && result.temperature < 50000)) return null;
    return result;
  } catch {
    return null;
  }
}

export const D65: Xy = { x: 0.31271, y: 0.32902 };
