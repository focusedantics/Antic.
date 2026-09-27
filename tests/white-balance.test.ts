import { describe, expect, it } from "vitest";
import { illuminantXy, whiteBalanceMatrix, xyToTemperatureTint } from "@/lib/colorimetry";
import { mulVec3 } from "@/lib/math";
import { neutralize, whiteBalanceFor } from "@/core/develop/white-balance";

describe("white balance", () => {
  it("round-trips temperature and tint through chromaticity", () => {
    for (const [t, tint] of [[2850, 0], [5500, 10], [6500, -20], [10000, 30]]) {
      const back = xyToTemperatureTint(illuminantXy(t, tint));
      expect(Math.abs(back.temperature - t) / t).toBeLessThan(0.01);
      expect(Math.abs(back.tint - tint)).toBeLessThanOrEqual(1);
    }
  });

  it("warms the photo when the temperature is raised", () => {
    const m = whiteBalanceMatrix(illuminantXy(5000, 0), illuminantXy(7000, 0));
    const [r, , b] = mulVec3(m, [0.5, 0.5, 0.5]);
    expect(r).toBeGreaterThan(b);
  });

  it("is the identity at as-shot values", () => {
    const m = whiteBalanceFor({ mode: "as-shot", temperature: 5300, tint: -10 }, { raw: true, asShot: { temperature: 5300, tint: -10 } });
    expect(m).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("neutralizes a cast back to neutral", () => {
    const info = { raw: true, asShot: { temperature: 5500, tint: 0 } };
    // A bluish gray: the photo looks too cool, so the neutralizing temperature must be higher.
    const wb = neutralize([0.4, 0.45, 0.6], info);
    expect(wb.temperature).toBeGreaterThan(5500);
    const m = whiteBalanceFor({ mode: "custom", ...wb }, info);
    const [r, g, b] = mulVec3(m, [0.4, 0.45, 0.6]);
    expect(Math.abs(r - b) / g).toBeLessThan(0.06);
    expect(Math.abs(r - g) / g).toBeLessThan(0.06);
  });
});
