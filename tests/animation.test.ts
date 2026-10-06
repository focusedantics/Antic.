import { describe, expect, it } from "vitest";
import { DEFAULT_ANIMATION, docAnimation, hasAnimatedLayers, isAnimated, loopFrames } from "@/core/document/animation";
import type { Layer } from "@/core/document/model";
import { createDocument, effectLayer, groupLayer, sanitizeAnimation, sanitizeDocument, textLayer } from "@/core/document/operations";
import { curveSag, drawText } from "@/core/text/draw";
import { FONTS, fontLabel } from "@/core/text/fonts";
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

describe("animated text", () => {
  const doc = createDocument(800, 600);
  const text = textLayer(doc, { text: "Hi there" });

  it("sanitizes motion and counts moving text as animation", () => {
    expect(hasAnimatedLayers([text])).toBe(false);
    const wave = sanitizeDocument(JSON.parse(JSON.stringify({ ...doc, layers: [{ ...text, style: { ...(text as { style: object }).style, motion: { kind: "wave", speed: 9.4, amount: 3 } } }] })));
    const style = (wave.layers[0] as Extract<Layer, { kind: "text" }>).style;
    expect(style.motion).toEqual({ kind: "wave", speed: 4, amount: 1 });
    expect(isAnimated(wave)).toBe(true);
    const bogus = sanitizeDocument(JSON.parse(JSON.stringify({ ...doc, layers: [{ ...text, style: { ...(text as { style: object }).style, motion: { kind: "explode" } } }] })));
    expect((bogus.layers[0] as Extract<Layer, { kind: "text" }>).style.motion).toBeUndefined();
  });

  it("types letters in over the loop and moves waving letters", () => {
    const calls: { ch: string; y: number }[] = [];
    let ty = 0;
    const ctx = {
      font: "",
      fillStyle: "",
      textAlign: "left",
      textBaseline: "middle",
      globalAlpha: 1,
      shadowBlur: 0,
      shadowColor: "",
      measureText: (t: string) => ({ width: t.length * 10 }),
      fillText: (ch: string, _x: number, y: number) => calls.push({ ch, y: y + ty }),
      fillRect: () => {},
      save: () => {},
      restore: () => {
        ty = 0;
      },
      translate: (_x: number, y: number) => {
        ty += y;
      },
      scale: () => {},
    } as unknown as OffscreenCanvasRenderingContext2D;
    const style = { ...(text as Extract<Layer, { kind: "text" }>).style, text: "abcd" };
    drawText(ctx, { ...style, motion: { kind: "typewriter", speed: 1, amount: 0.5 } }, 200, 100, 0.35, 3);
    expect(calls.map((c) => c.ch).join("")).toBe("ab");
    calls.length = 0;
    drawText(ctx, { ...style, motion: { kind: "typewriter", speed: 1, amount: 0.5 } }, 200, 100, 0.9, 3);
    expect(calls.map((c) => c.ch).join("")).toBe("abcd");
    calls.length = 0;
    drawText(ctx, { ...style, motion: { kind: "wave", speed: 1, amount: 1 } }, 200, 100, 0.25, 3);
    expect(new Set(calls.map((c) => Math.round(c.y))).size).toBeGreaterThan(1);
  });

  it("bends curved text along an arc: outer letters lower and turned outwards", () => {
    const calls: { ch: string; y: number; angle: number }[] = [];
    let ty = 0;
    let angle = 0;
    const ctx = {
      font: "",
      fillStyle: "",
      textAlign: "left",
      textBaseline: "middle",
      globalAlpha: 1,
      shadowBlur: 0,
      measureText: (t: string) => ({ width: t.length * 10 }),
      fillText: (ch: string, _x: number, y: number) => calls.push({ ch, y: y + ty, angle }),
      fillRect: () => {},
      save: () => {},
      restore: () => {
        ty = 0;
        angle = 0;
      },
      translate: (_x: number, y: number) => {
        ty += y;
      },
      rotate: (a: number) => {
        angle += a;
      },
      scale: () => {},
    } as unknown as OffscreenCanvasRenderingContext2D;
    const style = { ...(text as Extract<Layer, { kind: "text" }>).style, text: "abcde", curve: 1 };
    drawText(ctx, style, 200, 100);
    expect(calls.map((c) => c.ch).join("")).toBe("abcde");
    const [a, , c, , e] = calls;
    // Bulging up: the middle letter is highest, the ends lower and tilted away from it.
    expect(c.y).toBeLessThan(a.y);
    expect(a.y).toBeCloseTo(e.y, 6);
    expect(a.angle).toBeLessThan(0);
    expect(e.angle).toBeGreaterThan(0);
    expect(c.angle).toBeCloseTo(0, 6);
    // In a box as tall as the arc plus a line (what the Curve control sizes it to), every letter fits.
    calls.length = 0;
    const h = curveSag(1, 50) + style.size * 1.3;
    drawText(ctx, style, 200, h);
    for (const l of calls) {
      expect(l.y - style.size / 2).toBeGreaterThanOrEqual(0);
      expect(l.y + style.size / 2).toBeLessThanOrEqual(h);
    }
  });

  it("lists every bundled font once with a readable label", () => {
    expect(new Set(FONTS.map((f) => f.css)).size).toBe(FONTS.length);
    expect(fontLabel("'Bebas Neue', Impact, sans-serif")).toBe("Bebas Neue");
    expect(fontLabel("'Old Font', serif")).toBe("Old Font");
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
