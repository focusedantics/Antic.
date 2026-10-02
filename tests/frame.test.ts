import { describe, expect, it } from "vitest";
import { defaultFrame, frameLayout, sanitizeFrame } from "@/core/export/frame";

const on = (patch: Partial<typeof defaultFrame>) => ({ ...defaultFrame, enabled: true, ...patch });

describe("export frame layout", () => {
  it("leaves the image alone when the frame is off", () => {
    const L = frameLayout(1500, 1000, defaultFrame);
    expect([L.width, L.height, L.band]).toEqual([1500, 1000, 0]);
    expect(L.inner).toEqual({ x: 0, y: 0, w: 1500, h: 1000 });
  });

  it("inside: same size, the opening inset by the band (a share of the short side)", () => {
    const L = frameLayout(1500, 1000, on({ placement: "inside", width: 4 }));
    expect([L.width, L.height, L.band]).toEqual([1500, 1000, 40]);
    expect(L.photo).toEqual({ x: 0, y: 0, w: 1500, h: 1000 });
    expect(L.inner).toEqual({ x: 40, y: 40, w: 1420, h: 920 });
  });

  it("around: the image grows by the band on every side and is not cropped", () => {
    const L = frameLayout(1500, 1000, on({ placement: "around", width: 4 }));
    expect([L.width, L.height]).toEqual([1580, 1080]);
    expect(L.photo).toEqual({ x: 40, y: 40, w: 1500, h: 1000 });
    expect(L.inner).toEqual(L.photo);
  });

  it("polaroid: always around, with a deeper bottom edge", () => {
    const L = frameLayout(1000, 1500, on({ style: "polaroid", placement: "inside", width: 5 }));
    expect(L.band).toBe(50);
    expect([L.width, L.height]).toEqual([1100, 1500 + 50 + 160]);
    expect(L.photo).toEqual({ x: 50, y: 50, w: 1000, h: 1500 });
  });

  it("keeps the corner radius inside the opening, and a band of at least a pixel", () => {
    const tiny = frameLayout(10, 10, on({ width: 20, roundness: 1 }));
    expect(tiny.radius).toBeLessThanOrEqual(Math.min(tiny.inner.w, tiny.inner.h) / 2);
    expect(frameLayout(20, 20, on({ width: 0.5 })).band).toBe(1);
  });
});

describe("sanitizeFrame", () => {
  it("returns the defaults for junk", () => {
    expect(sanitizeFrame(null)).toEqual(defaultFrame);
    expect(sanitizeFrame("frame")).toEqual(defaultFrame);
  });

  it("clamps numbers and rejects unknown styles, placements and colours", () => {
    const f = sanitizeFrame({ enabled: true, style: "neon", placement: "sideways", width: 99, roundness: -1, color: "red", tint: 2, frost: Number.NaN, rim: 0.2, shadow: "1" });
    expect(f).toEqual({ ...defaultFrame, enabled: true, width: 20, roundness: 0, tint: 1, rim: 0.2 });
  });

  it("keeps a valid frame as it is", () => {
    const f = on({ style: "polaroid", placement: "around", width: 6.5, color: "#1a2b3c", shadow: 0 });
    expect(sanitizeFrame(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });
});
