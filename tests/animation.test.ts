import { describe, expect, it } from "vitest";
import { DEFAULT_ANIMATION, docAnimation, hasAnimatedLayers, isAnimated, loopFrames } from "@/core/document/animation";
import type { Layer } from "@/core/document/model";
import { createDocument, effectLayer, groupLayer, sanitizeAnimation, sanitizeDocument } from "@/core/document/operations";
import { EFFECTS } from "@/core/effects/registry";
import { buildPalette, gifDelay, GifWriter, indexPixels, PaletteMatcher } from "@/core/export/gif";

describe("document animation", () => {
  const doc = createDocument(800, 600);
  const snow = effectLayer(doc, "snow")!;
  const halftone = effectLayer(doc, "halftone-cmyk")!;

  it("detects visible animated effect layers at any depth", () => {
    expect(isAnimated(doc)).toBe(false);
    expect(hasAnimatedLayers([halftone])).toBe(false);
    expect(hasAnimatedLayers([halftone, snow])).toBe(true);
    expect(hasAnimatedLayers([{ ...snow, visible: false } as Layer])).toBe(false);
    expect(hasAnimatedLayers([groupLayer(doc, [snow])])).toBe(true);
  });

  it("defaults, sanitises and survives a round trip", () => {
    expect(docAnimation(doc)).toEqual(DEFAULT_ANIMATION);
    expect(sanitizeAnimation({ duration: 99, fps: 1 })).toEqual({ duration: 10, fps: 6 });
    expect(sanitizeAnimation({ duration: "x", fps: 24.4 })).toEqual({ duration: DEFAULT_ANIMATION.duration, fps: 24 });
    const withLoop = { ...doc, layers: [snow], animation: { duration: 4.5, fps: 20 } };
    const back = sanitizeDocument(JSON.parse(JSON.stringify(withLoop)));
    expect(back.animation).toEqual({ duration: 4.5, fps: 20 });
    expect(isAnimated(back)).toBe(true);
    expect(sanitizeDocument(JSON.parse(JSON.stringify(doc))).animation).toBeUndefined();
  });

  it("covers one loop without repeating the first frame", () => {
    const times = loopFrames({ duration: 2, fps: 10 });
    expect(times).toHaveLength(20);
    expect(times[0]).toBe(0);
    expect(times[19]).toBeCloseTo(1.9);
  });

  it("marks the Motion effects animated, with whole cycles per loop so they repeat seamlessly", () => {
    const motion = EFFECTS.filter((e) => e.category === "Motion");
    expect(motion.length).toBeGreaterThanOrEqual(8);
    for (const def of motion) {
      expect(def.animated).toBe(true);
      const speed = def.params.find((p) => p.key === "speed");
      if (speed?.type === "number") expect(Number.isInteger(speed.step ?? 1)).toBe(true);
    }
  });
});

describe("GIF encoding", () => {
  const solid = (w: number, h: number, rgb: [number, number, number]) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i += 4) px.set([...rgb, 255], i);
    return px;
  };

  it("builds a palette that holds the frame colours", () => {
    const palette = buildPalette([solid(8, 8, [250, 10, 10]), solid(8, 8, [10, 10, 250])]);
    const matcher = new PaletteMatcher(palette);
    const red = palette[matcher.nearest(250, 10, 10)];
    const blue = palette[matcher.nearest(10, 10, 250)];
    expect(red[0]).toBeGreaterThan(200);
    expect(blue[2]).toBeGreaterThan(200);
  });

  it("dithers a gradient so its average tone is preserved", () => {
    const w = 64;
    const h = 8;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x * 4, x * 4, x * 4, 255], (y * w + x) * 4);
    const palette = [
      [0, 0, 0],
      [255, 255, 255],
    ];
    const matcher = new PaletteMatcher(palette);
    const flat = indexPixels(px, w, h, matcher, false);
    const dithered = indexPixels(px, w, h, matcher, true);
    const mean = (idx: Uint8Array) => idx.reduce((s, i) => s + palette[i][0], 0) / idx.length;
    const truth = px.filter((_, i) => i % 4 === 0).reduce((s, v) => s + v, 0) / (w * h);
    expect(Math.abs(mean(dithered) - truth)).toBeLessThan(6);
    expect(Math.abs(mean(dithered) - truth)).toBeLessThanOrEqual(Math.abs(mean(flat) - truth));
  });

  it("spreads centisecond rounding so the loop keeps its length", () => {
    const delays = Array.from({ length: 45 }, (_, i) => gifDelay(i, 15));
    expect(delays.reduce((a, b) => a + b, 0)).toBe(3000);
    expect(new Set(delays)).toEqual(new Set([60, 70]));
  });

  it("writes a looping GIF89a", () => {
    const frames = [solid(4, 4, [255, 0, 0]), solid(4, 4, [0, 255, 0])];
    const writer = new GifWriter(4, 4, buildPalette(frames), 10, true);
    for (const f of frames) writer.add(f);
    const bytes = writer.finish();
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("GIF89a");
    expect(new TextDecoder().decode(bytes).includes("NETSCAPE2.0")).toBe(true);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });
});
