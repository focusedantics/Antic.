import { describe, expect, it } from "vitest";
import { shrinkRgb16 } from "@/core/gpu/shrink";

/** w × h pixels with red = x, green = y, blue = 1000. */
const ramp = (w: number, h: number) => {
  const data = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 100, y * 100, 1000], (y * w + x) * 3);
  return data;
};
const at = (data: Uint16Array, w: number, x: number, y: number) => [...data.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];

describe("shrinking 16-bit RGB before upload", () => {
  it("averages whole blocks", () => {
    const out = shrinkRgb16(ramp(4, 4), 4, 4, 2, 2);
    expect(at(out, 2, 0, 0)).toEqual([50, 50, 1000]);
    expect(at(out, 2, 1, 1)).toEqual([250, 250, 1000]);
  });

  it("weights partly covered pixels: 3 → 2 averages 1½ pixels each", () => {
    const out = shrinkRgb16(ramp(3, 1), 3, 1, 2, 1);
    // Pixels 0 and half of 1: (0 + 50) / 1.5; half of 1 and 2: (50 + 200) / 1.5.
    expect(at(out, 2, 0, 0)).toEqual([33, 0, 1000]);
    expect(at(out, 2, 1, 0)).toEqual([167, 0, 1000]);
  });

  it("keeps a flat colour flat at any ratio, edges included", () => {
    const w = 8400;
    const flat = new Uint16Array(w * 3 * 3).fill(4321);
    const out = shrinkRgb16(flat, w, 3, 8192, 3);
    expect(new Set(out)).toEqual(new Set([4321]));
  });
});
