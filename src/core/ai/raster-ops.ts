/**
 * Coverage raster utilities (8-bit, one byte per pixel). Pure functions, so they
 * run in workers and are unit tested.
 */

/** Bilinear resize of an 8-bit single-channel image. */
export function resizeU8(src: Uint8Array | Float32Array, sw: number, sh: number, dw: number, dh: number, scale = 1): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = Math.max(0, Math.min(255, Math.round((a * (1 - ty) + b * ty) * scale)));
    }
  }
  return out;
}

/** Box filter with an integral image: O(1) per pixel regardless of radius. */
function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * Edge-aware refinement (He et al., guided filter): the mask follows the
 * photo's edges, so hair and fine boundaries snap to the image instead of the
 * model's low-resolution output.
 */
export function guidedFilter(mask: Uint8Array, rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, radius: number, eps = 1e-3): Uint8Array {
  const n = w * h;
  const I = new Float32Array(n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    I[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
    p[i] = mask[i] / 255;
  }
  const Ip = new Float32Array(n);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Ip[i] = I[i] * p[i];
    II[i] = I[i] * I[i];
  }
  const meanI = boxFilter(I, w, h, radius);
  const meanP = boxFilter(p, w, h, radius);
  const meanIp = boxFilter(Ip, w, h, radius);
  const meanII = boxFilter(II, w, h, radius);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = meanIp[i] - meanI[i] * meanP[i];
    const variance = meanII[i] - meanI[i] * meanI[i];
    a[i] = cov / (variance + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxFilter(a, w, h, radius);
  const meanB = boxFilter(b, w, h, radius);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round((meanA[i] * I[i] + meanB[i]) * 255)));
  return out;
}

/** Union of several masks (max). */
export function unionU8(masks: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (const m of masks) for (let i = 0; i < n; i++) if (m[i] > out[i]) out[i] = m[i];
  return out;
}

/** Stretches a soft mask so its values span 0..255 (U²-Net outputs are not calibrated). */
export function normalizeU8(values: Float32Array): Uint8Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = new Uint8Array(values.length);
  const range = hi - lo || 1;
  for (let i = 0; i < values.length; i++) out[i] = Math.round(((values[i] - lo) / range) * 255);
  return out;
}

export function coverageFraction(mask: Uint8Array) {
  let sum = 0;
  for (const v of mask) sum += v;
  return sum / (mask.length * 255);
}
