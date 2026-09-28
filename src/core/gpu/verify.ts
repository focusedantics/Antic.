/** Straight RGBA pixels, as in ImageData. */
export type Pixels = { readonly width: number; readonly height: number; readonly data: ArrayLike<number> };

/**
 * Compares two renders of the same image at different sizes on a coarse grid of
 * block averages (straight RGBA, 0..255). Effects and resampling change fine
 * detail, not the averages; a blank, shifted or flipped render changes them a lot.
 */
export function similarImages(a: Pixels, b: Pixels, cols = 16, rows = 12): boolean {
  const grid = (img: Pixels) => {
    const out = new Float64Array(cols * rows * 4);
    const counts = new Float64Array(cols * rows);
    const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 40000)));
    for (let y = 0; y < img.height; y += step) {
      const gy = Math.min(rows - 1, Math.floor((y / img.height) * rows));
      for (let x = 0; x < img.width; x += step) {
        const gx = Math.min(cols - 1, Math.floor((x / img.width) * cols));
        const i = (y * img.width + x) * 4;
        const c = gy * cols + gx;
        const alpha = img.data[i + 3] / 255;
        out[c * 4] += img.data[i] * alpha;
        out[c * 4 + 1] += img.data[i + 1] * alpha;
        out[c * 4 + 2] += img.data[i + 2] * alpha;
        out[c * 4 + 3] += img.data[i + 3];
        counts[c]++;
      }
    }
    for (let c = 0; c < counts.length; c++) for (let k = 0; k < 4; k++) out[c * 4 + k] /= Math.max(1, counts[c]);
    return out;
  };
  const ga = grid(a);
  const gb = grid(b);
  let diff = 0;
  for (let i = 0; i < ga.length; i++) diff += Math.abs(ga[i] - gb[i]);
  return diff / ga.length < 40;
}
