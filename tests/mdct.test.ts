import { describe, expect, it } from "vitest";
import { Mdct, mdctDirect } from "@/core/video/mdct";

describe("fast MDCT", () => {
  for (const n of [16, 64, 2048]) {
    it(`matches the definition for N = ${n}`, () => {
      let seed = n;
      const x = Float64Array.from({ length: n }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5);
      const fast = new Float64Array(n / 2);
      new Mdct(n).forward(x, fast);
      const slow = mdctDirect(x);
      let err = 0;
      let mag = 0;
      for (let k = 0; k < n / 2; k++) {
        err = Math.max(err, Math.abs(fast[k] - slow[k]));
        mag = Math.max(mag, Math.abs(slow[k]));
      }
      expect(err / mag).toBeLessThan(1e-9);
    });
  }
});
