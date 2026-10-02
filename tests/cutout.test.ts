import { describe, expect, it } from "vitest";
import { classify } from "@/components/cutoutFx";
import { highResolutionMix, Spring } from "@/components/particleGlobe";

/** A grid of `cols` × `rows` where `bg(c, r)` cells change between before and after. */
function grids(cols: number, rows: number, bg: (c: number, r: number) => boolean) {
  const before = new Uint8ClampedArray(cols * rows * 4).fill(120);
  const after = new Uint8ClampedArray(before);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (bg(c, r)) after.set([40, 40, 40, 255], (r * cols + c) * 4);
  return { before: { columns: cols, rows, rgba: before }, after: { columns: cols, rows, rgba: after } };
}

describe("cutout classification", () => {
  it("marks changed cells as background, the subject's border as outline, and finds the subject", () => {
    // Subject: the 2×2 block at columns 3–4, rows 2–3 of an 8×6 grid.
    const subject = (c: number, r: number) => c >= 3 && c <= 4 && r >= 2 && r <= 3;
    const { before, after } = grids(8, 6, (c, r) => !subject(c, r));
    const box = { x0: 0, y0: 0, x1: 80, y1: 60 };
    const { kinds, center, changed } = classify(before, after, box);
    expect(changed).toBe(8 * 6 - 4);
    expect(kinds[0]).toBe(1);
    // Every subject cell touches the background here, so all four are outline.
    expect([kinds[2 * 8 + 3], kinds[2 * 8 + 4], kinds[3 * 8 + 3], kinds[3 * 8 + 4]]).toEqual([2, 2, 2, 2]);
    expect(center).toEqual({ x: 40, y: 30 });
  });

  it("reports no change when nothing changed (the viewer has not redrawn yet)", () => {
    const { before } = grids(4, 4, () => false);
    expect(classify(before, before, { x0: 0, y0: 0, x1: 4, y1: 4 }).changed).toBe(0);
  });
});

describe("globe motion", () => {
  it("forms without overshoot and lands back with a small bounce, like the sketch's springs", () => {
    const s = new Spring(0);
    s.to(1, 55, 16, 1); // forming: just over critically damped
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      s.step(1 / 60);
      peak = Math.max(peak, s.x);
    }
    expect(s.resting).toBe(true);
    expect(peak).toBeLessThanOrEqual(1.0001);
    s.to(0, 70, 16, 1); // returning: slightly under-damped
    let low = 1;
    for (let i = 0; i < 300; i++) {
      s.step(1 / 60);
      low = Math.min(low, s.x);
    }
    expect(s.resting).toBe(true);
    expect(low).toBeLessThan(0);
  });

  it("brings the exact photo back only in the last moments of the return", () => {
    expect(highResolutionMix(0)).toBe(1);
    expect(highResolutionMix(0.02)).toBeGreaterThan(0);
    expect(highResolutionMix(0.02)).toBeLessThan(1);
    expect(highResolutionMix(0.1)).toBe(0);
  });
});
