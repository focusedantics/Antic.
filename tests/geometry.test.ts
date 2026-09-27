import { describe, expect, it } from "vitest";
import { defaultGeometry } from "@/core/develop/defaults";
import { apply, constrainCrop, outputSize, outputToSource, sourceToOutput } from "@/core/develop/geometry";
import type { Geometry } from "@/core/develop/recipe";

const size = { width: 6000, height: 4000 };
const g = (patch: Partial<Geometry>): Geometry => ({ ...defaultGeometry, ...patch });
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("develop geometry", () => {
  it("is the identity by default", () => {
    const m = outputToSource(size, defaultGeometry);
    close(apply(m, 0, 0), [0, 0]);
    close(apply(m, 1, 1), [1, 1]);
    close(apply(m, 0.25, 0.75), [0.25, 0.75]);
  });

  it("maps a crop", () => {
    const m = outputToSource(size, g({ crop: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 } }));
    close(apply(m, 0, 0), [0.5, 0.25]);
    close(apply(m, 1, 1), [1, 0.75]);
    expect(outputSize(size, g({ crop: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 } }))).toEqual({ width: 3000, height: 2000 });
  });

  it("rotates a quarter turn clockwise", () => {
    const rot = g({ rotate90: 1 });
    expect(outputSize(size, rot)).toEqual({ width: 4000, height: 6000 });
    const m = outputToSource(size, rot);
    // Top-left of the rotated output is the source's bottom-left.
    close(apply(m, 0, 0), [0, 1]);
    close(apply(m, 1, 0), [0, 0]);
    close(apply(m, 1, 1), [1, 0]);
  });

  it("flips horizontally", () => {
    close(apply(outputToSource(size, g({ flipHorizontal: true })), 0, 0), [1, 0]);
  });

  it("round-trips through the inverse", () => {
    const geo = g({ angle: 7, rotate90: 3, flipVertical: true, vertical: 30, crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 } });
    const fwd = outputToSource(size, geo);
    const inv = sourceToOutput(size, geo);
    const [sx, sy] = apply(fwd, 0.3, 0.6);
    close(apply(inv, sx, sy), [0.3, 0.6]);
  });

  it("keeps a straightened crop inside the photo", () => {
    const crop = constrainCrop(size, 10, { x: 0, y: 0, width: 1, height: 1 });
    expect(crop.width).toBeLessThan(1);
    expect(crop.width / crop.height).toBeCloseTo(1, 6);
    const m = outputToSource(size, g({ angle: 10, crop }));
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const [x, y] = apply(m, u, v);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(1 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
