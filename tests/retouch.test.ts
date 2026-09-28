import { describe, expect, it } from "vitest";
import { findSource } from "@/core/develop/retouch";

describe("heal source search", () => {
  it("picks a clean area that matches the surroundings", () => {
    const size = 64;
    const px = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        // Left half is bright, right half dark; the blemish sits on the bright side near the edge.
        const v = x < 36 ? 0.8 : 0.1;
        px.set([v, v, v, 1], (y * size + x) * 4);
      }
    // A dark blemish at the center.
    for (let y = 29; y < 35; y++) for (let x = 29; x < 35; x++) px.set([0, 0, 0, 1], (y * size + x) * 4);
    const { dx } = findSource(px, size, 4);
    // The source should stay on the bright side (to the left of the edge).
    expect(32 + dx).toBeLessThan(36);
  });
});
