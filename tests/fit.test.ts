import { describe, expect, it } from "vitest";
import { placeClear, placePicture } from "@/lib/fit";

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

describe("placePicture: where a viewer shows a photo", () => {
  it("fits and centres it inside the padding", () => {
    // 3:2 in 390 × 500: width-limited to 358 × 238.7, centred vertically.
    const r = placePicture({ width: 3000, height: 2000 }, 390, 500);
    expect(r.left).toBe(16);
    expect(r.width).toBeCloseTo(358);
    expect(r.height).toBeCloseTo(238.67, 1);
    expect(r.top).toBeCloseTo(16 + (468 - 238.67) / 2, 1);
  });

  it("fits whole above a panel when not editing under it", () => {
    const r = placePicture({ width: 1000, height: 1500 }, 390, 600, { cover: 250 });
    expect(r.top + r.height).toBeLessThanOrEqual(600 - 250 - 16 + 1e-9);
  });

  it("keeps the whole-viewer size under a panel while editing, starting at the top", () => {
    // 2:3 in 390 × 600: 358 × 537 either way, but under a 250 px panel it starts at the top.
    const r = placePicture({ width: 1000, height: 1500 }, 390, 600, { cover: 250, under: true });
    expect(r.height).toBeCloseTo(537);
    expect(r.top).toBe(16);
    expect(placePicture({ width: 1000, height: 1500 }, 390, 600, { cover: 250 }).height).toBeCloseTo(318);
  });
});
