/**
 * A fast MDCT (N inputs → N/2 outputs) through a DCT-IV of size N/2 computed with a
 * complex FFT of size N/4: X[k] = Σ x[n] cos(2π/N (n + 1/2 + N/4)(k + 1/2)).
 */
export class Mdct {
  private readonly n: number;
  private readonly m: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly fftCos: Float64Array;
  private readonly fftSin: Float64Array;
  private readonly rev: Uint32Array;
  private readonly u: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(n: number) {
    this.n = n;
    const m = (this.m = n / 2);
    const q = m / 2;
    // Pre/post twiddles for the DCT-IV: exp(−iπ(8j + 1)/(8M)).
    this.cos = Float64Array.from({ length: q }, (_, j) => Math.cos((Math.PI * (8 * j + 1)) / (8 * m)));
    this.sin = Float64Array.from({ length: q }, (_, j) => Math.sin((Math.PI * (8 * j + 1)) / (8 * m)));
    this.fftCos = Float64Array.from({ length: q / 2 }, (_, j) => Math.cos((2 * Math.PI * j) / q));
    this.fftSin = Float64Array.from({ length: q / 2 }, (_, j) => Math.sin((2 * Math.PI * j) / q));
    const bits = Math.log2(q);
    this.rev = Uint32Array.from({ length: q }, (_, i) => {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      return r;
    });
    this.u = new Float64Array(m);
    this.re = new Float64Array(q);
    this.im = new Float64Array(q);
  }

  /** MDCT of `x` (length N) into `out` (length N/2). */
  forward(x: ArrayLike<number>, out: Float64Array) {
    const { n, m, u, re, im } = this;
    const h = n / 4;
    // Fold the N inputs into the M-point DCT-IV input.
    for (let i = 0; i < h; i++) {
      u[i] = -x[3 * h - 1 - i] - x[3 * h + i];
      u[h + i] = x[i] - x[2 * h - 1 - i];
    }
    // DCT-IV through a complex FFT of size M/2.
    const q = m / 2;
    for (let j = 0; j < q; j++) {
      const a = u[2 * j];
      const b = u[m - 1 - 2 * j];
      const k = this.rev[j];
      re[k] = a * this.cos[j] + b * this.sin[j];
      im[k] = b * this.cos[j] - a * this.sin[j];
    }
    for (let size = 2; size <= q; size *= 2) {
      const half = size / 2;
      const step = q / size;
      for (let start = 0; start < q; start += size)
        for (let j = 0; j < half; j++) {
          const c = this.fftCos[j * step];
          const s = this.fftSin[j * step];
          const p = start + j;
          const r = p + half;
          const tr = re[r] * c + im[r] * s;
          const ti = im[r] * c - re[r] * s;
          re[r] = re[p] - tr;
          im[r] = im[p] - ti;
          re[p] += tr;
          im[p] += ti;
        }
    }
    for (let j = 0; j < q; j++) {
      const a = re[j] * this.cos[j] + im[j] * this.sin[j];
      const b = im[j] * this.cos[j] - re[j] * this.sin[j];
      out[2 * j] = a;
      out[m - 1 - 2 * j] = -b;
    }
  }
}

/** The MDCT by its definition (slow; for tests). */
export function mdctDirect(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * Math.cos(((2 * Math.PI) / n) * (i + 0.5 + n / 4) * (k + 0.5));
    out[k] = s;
  }
  return out;
}
