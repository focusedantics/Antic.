import { describe, expect, it } from "vitest";
import { illuminantXy, whiteBalanceMatrix, xyToTemperatureTint } from "@/lib/colorimetry";
import { mulVec3 } from "@/lib/math";
import { sanitizeRecipe } from "@/core/develop/operations";
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

  it("as shot is no change on any source, whatever numbers come with it", () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // A RAW's recipe (5500 K) on its camera preview, once treated as a rendered file: read on
    // the rendered scale, 5500 was an enormous shift and the photo came out with a heavy cast.
    expect(whiteBalanceFor({ mode: "as-shot", temperature: 5500, tint: 0 }, { raw: false })).toEqual(identity);
    // Not yet rebased on the camera's as-shot values (a RAW never opened in Develop).
    expect(whiteBalanceFor({ mode: "as-shot", temperature: 5500, tint: 0 }, { raw: true, asShot: { temperature: 4900, tint: 12 } })).toEqual(identity);
    expect(whiteBalanceFor({ mode: "as-shot", temperature: 0, tint: 0 }, { raw: true, rendered: true })).toEqual(identity);
  });

  it("a RAW's preview takes a custom white balance as the RAW does", () => {
    const wb = { mode: "custom" as const, temperature: 7000, tint: 5 };
    const asShot = { temperature: 5300, tint: -10 };
    expect(whiteBalanceFor(wb, { raw: true, asShot, rendered: true })).toEqual(whiteBalanceFor(wb, { raw: true, asShot }));
  });

  it("a RAW's white balance saved on the rendered scale is read as the Kelvin that means the same", () => {
    const info = { raw: true, asShot: { temperature: 5300, tint: 0 } };
    // Custom +20 (warmer) written while the RAW was edited as a rendered file.
    const warmed = sanitizeRecipe({ whiteBalance: { mode: "custom", temperature: 20, tint: 4 } }, info).whiteBalance;
    expect(warmed.mode).toBe("custom");
    expect(warmed.temperature).toBeGreaterThan(5300);
    expect(warmed.temperature).toBeLessThan(7000);
    expect(sanitizeRecipe({ whiteBalance: { mode: "custom", temperature: -20, tint: 0 } }, info).whiteBalance.temperature).toBeLessThan(5300);
    // "As shot" saved as 0/0: the photo's own values, not the coldest the scale allows.
    expect(sanitizeRecipe({ whiteBalance: { mode: "as-shot", temperature: 0, tint: 0 } }, info).whiteBalance.temperature).toBe(5300);
    // Kelvin stays as it is; rendered files keep their scale.
    expect(sanitizeRecipe({ whiteBalance: { mode: "custom", temperature: 6500, tint: 0 } }, info).whiteBalance.temperature).toBe(6500);
    expect(sanitizeRecipe({ whiteBalance: { mode: "custom", temperature: 20, tint: 0 } }, { raw: false }).whiteBalance.temperature).toBe(20);
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
