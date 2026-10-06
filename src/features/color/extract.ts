import { rgbToHex } from "@/lib/hsv";

/**
 * The main colours of an image: k-means on a small copy (about 9 000 pixels), seeded
 * deterministically with k-means++ (farthest-point picks), so the same photo always gives
 * the same palette. Colours come out most-covering first; near-duplicates are merged.
 */
export function extractPalette(pixels: Uint8ClampedArray, count = 6): string[] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 200) pts.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  if (!pts.length) return [];
  const d2 = (a: readonly number[], b: readonly number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // Seed: the mean, then repeatedly the point farthest from every centre so far.
  const mean = pts.reduce((m, p) => [m[0] + p[0], m[1] + p[1], m[2] + p[2]], [0, 0, 0]).map((v) => v / pts.length) as [number, number, number];
  const centres: [number, number, number][] = [mean];
  const nearest = pts.map((p) => d2(p, mean));
  while (centres.length < count) {
    let best = -1;
    let far = -1;
    for (let i = 0; i < pts.length; i++)
      if (nearest[i] > far) {
        far = nearest[i];
        best = i;
      }
    if (far <= 0) break;
    const c = [...pts[best]] as [number, number, number];
    centres.push(c);
    for (let i = 0; i < pts.length; i++) nearest[i] = Math.min(nearest[i], d2(pts[i], c));
  }
  const assign = new Int32Array(pts.length);
  for (let iter = 0; iter < 14; iter++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = d2(pts[i], centres[c]);
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      assign[i] = bi;
      const s = sums[bi];
      s[0] += pts[i][0];
      s[1] += pts[i][1];
      s[2] += pts[i][2];
      s[3]++;
    }
    let moved = 0;
    centres.forEach((c, k) => {
      const s = sums[k];
      if (!s[3]) return;
      const next: [number, number, number] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      moved += d2(c, next);
      centres[k] = next;
    });
    if (moved < 1) break;
  }
  const sizes = centres.map(() => 0);
  for (let i = 0; i < pts.length; i++) sizes[assign[i]]++;
  const order = centres.map((c, k) => ({ c, n: sizes[k] })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  // Merge colours closer than a just-noticeable step.
  const out: [number, number, number][] = [];
  for (const { c } of order) if (!out.some((o) => d2(o, c) < 18 ** 2)) out.push(c);
  return out.map(([r, g, b]) => rgbToHex({ r, g, b }));
}

/** The palette of an image file or blob (decoded small). */
export async function paletteFromBlob(blob: Blob, count = 6): Promise<string[]> {
  const bitmap = await createImageBitmap(blob, { resizeWidth: 96, resizeQuality: "medium" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return extractPalette(ctx.getImageData(0, 0, canvas.width, canvas.height).data, count);
}
