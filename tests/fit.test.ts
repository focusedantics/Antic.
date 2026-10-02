import { describe, expect, it } from "vitest";
import { placeClear } from "@/lib/fit";

describe("placeClear: a picture under a floating panel", () => {
  it("centres the picture when no panel floats", () => {
    expect(placeClear(200, 500, 0, 16)).toBe(150);
  });

  it("centres it in the free part when it fits above the panel", () => {
    // 500 tall, the panel covers 260: 240 free, minus 16 above and below = 208; a 200 picture sits 4 lower.
    expect(placeClear(200, 500, 260, 16)).toBe(20);
  });

  it("starts at the top when it is taller than the free part (the panel covers its bottom)", () => {
    expect(placeClear(468, 500, 260, 16)).toBe(16);
  });

  it("never moves it lower than centred-in-the-viewer would", () => {
    for (const cover of [1, 50, 200, 400]) expect(placeClear(300, 600, cover, 16)).toBeLessThanOrEqual(150);
  });
});
