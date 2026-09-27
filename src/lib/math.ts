export const clamp = (value: number, min = 0, max = 1) =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const degToRad = (deg: number) => (deg * Math.PI) / 180;

export type Point = { readonly x: number; readonly y: number };

/**
 * Monotone piecewise cubic Hermite interpolation (Fritsch–Carlson). Tone curves use it
 * because, unlike a natural spline, it never overshoots between control points.
 */
export function interpolatePchip(points: readonly Point[]) {
  const n = points.length;
  if (n === 0) return (x: number) => x;
  if (n === 1) return () => points[0].y;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = h[i] === 0 ? 0 : (ys[i + 1] - ys[i]) / h[i];
  }
  const m: number[] = new Array(n).fill(0);
  if (n === 2) {
    m[0] = m[1] = delta[0];
  } else {
    for (let i = 1; i < n - 1; i++) {
      if (delta[i - 1] * delta[i] <= 0) {
        m[i] = 0;
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
      }
    }
    const end = (h0: number, h1: number, d0: number, d1: number) => {
      let d = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(d) !== Math.sign(d0)) d = 0;
      else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(d) > Math.abs(3 * d0)) d = 3 * d0;
      return d;
    };
    m[0] = end(h[0], h[1], delta[0], delta[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h[i] * m[i + 1]
    );
  };
}

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Row-major 3×3 product. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as number[];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r as unknown as Mat3;
}

export function mulVec3(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Singular matrix");
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

/** Column-major Float32Array for a GLSL mat3 uniform from a row-major matrix. */
export function toGlMat3(m: Mat3): Float32Array {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}
