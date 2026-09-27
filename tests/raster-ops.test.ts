import { describe, expect, it } from "vitest";
import { guidedFilter, normalizeU8, resizeU8 } from "@/core/ai/raster-ops";

describe("raster ops", () => {
  it("resizes preserving constant regions", () => {
    const src = new Uint8Array(16).fill(200);
    const out = resizeU8(src, 4, 4, 9, 7);
    expect(out.length).toBe(63);
    expect(out.every((v) => v === 200)).toBe(true);
  });

  it("normalizes to the full range", () => {
    expect([...normalizeU8(new Float32Array([0.25, 0.5, 0.75]))]).toEqual([0, 128, 255]);
  });

  it("snaps a blurry mask to an image edge", () => {
    const w = 40;
    const h = 10;
    const rgba = new Uint8Array(w * h * 4);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bright = x >= 20 ? 255 : 0;
        rgba.set([bright, bright, bright, 255], (y * w + x) * 4);
        // A soft ramp across x = 14..26 that doesn't know where the edge is.
        mask[y * w + x] = Math.max(0, Math.min(255, Math.round(((x - 14) / 12) * 255)));
      }
    const refined = guidedFilter(mask, rgba, w, h, 4, 1e-4);
    const row = 5 * w;
    expect(refined[row + 17]).toBeLessThan(mask[row + 17]);
    expect(refined[row + 22]).toBeGreaterThan(mask[row + 22]);
  });
});
