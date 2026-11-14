/**
 * Shrinks 16-bit RGB pixels to `outWidth × outHeight` by area averaging: each output pixel
 * is the mean of the input area it covers, partly covered pixels weighted by how much.
 * Used before upload when a photo is larger than the GPU can hold in one texture (WebGL
 * refuses such a texture outright). Works one output row at a time, so the only extra
 * memory is the result and a row.
 */
export function shrinkRgb16(data: Uint16Array, width: number, height: number, outWidth: number, outHeight: number): Uint16Array {
  const fx = width / outWidth;
  const fy = height / outHeight;
  // For each output column, the input columns it covers and how much of each.
  const starts = new Uint32Array(outWidth + 1);
  const cols: number[] = [];
  const weights: number[] = [];
  for (let ox = 0; ox < outWidth; ox++) {
    starts[ox] = cols.length;
    const a = ox * fx;
    const b = Math.min(width, a + fx);
    for (let ix = Math.floor(a); ix < Math.ceil(b); ix++) {
      cols.push(ix);
      weights.push(Math.min(b, ix + 1) - Math.max(a, ix));
    }
  }
  starts[outWidth] = cols.length;
  const out = new Uint16Array(outWidth * outHeight * 3);
  const acc = new Float64Array(outWidth * 3);
  for (let oy = 0; oy < outHeight; oy++) {
    acc.fill(0);
    const a = oy * fy;
    const b = Math.min(height, a + fy);
    for (let iy = Math.floor(a); iy < Math.ceil(b); iy++) {
      const wy = Math.min(b, iy + 1) - Math.max(a, iy);
      const row = iy * width * 3;
      for (let ox = 0; ox < outWidth; ox++) {
        let r = 0;
        let g = 0;
        let bl = 0;
        for (let k = starts[ox]; k < starts[ox + 1]; k++) {
          const i = row + cols[k] * 3;
          const w = weights[k];
          r += data[i] * w;
          g += data[i + 1] * w;
          bl += data[i + 2] * w;
        }
        acc[ox * 3] += r * wy;
        acc[ox * 3 + 1] += g * wy;
        acc[ox * 3 + 2] += bl * wy;
      }
    }
    for (let ox = 0; ox < outWidth; ox++) {
      // The area this pixel covers (rounding can leave the last row or column a little short).
      const area = (Math.min(width, (ox + 1) * fx) - ox * fx) * (b - a);
      const o = (oy * outWidth + ox) * 3;
      out[o] = Math.round(acc[ox * 3] / area);
      out[o + 1] = Math.round(acc[ox * 3 + 1] / area);
      out[o + 2] = Math.round(acc[ox * 3 + 2] / area);
    }
  }
  return out;
}
