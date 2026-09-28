import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demux } from "@/core/video/demux";
import { defaultEdit, estimateBytes, isVideoFile, outputSize, sanitizeEdit, sourceBitsPerPixel, videoBitrate } from "@/core/video/model";

describe("video edits", () => {
  it("sanitizes stored edits against the clip length", () => {
    const e = sanitizeEdit({ trimStart: -3, trimEnd: 99, effectMix: 4, effect: { id: "nope" }, output: { resolution: "8k", quality: "custom", bitrate: 1e6, audio: false } }, 10);
    expect(e.trimStart).toBe(0);
    expect(e.trimEnd).toBe(10);
    expect(e.effectMix).toBe(1);
    expect(e.effect).toBeNull();
    expect(e.output).toMatchObject({ resolution: "original", quality: "custom", bitrate: 200, audio: false });
    expect(sanitizeEdit({ trimStart: 6, trimEnd: 2 }, 10).trimEnd).toBe(6);
    expect(sanitizeEdit({ effect: { id: "vhs", params: { bleed: 1000 } } }, 5).effect?.params.bleed).toBe(40);
  });

  it("scales the short side down to the chosen resolution, keeping even sizes", () => {
    expect(outputSize(1920, 1080, "720")).toEqual({ width: 1280, height: 720 });
    expect(outputSize(1080, 1920, "480")).toEqual({ width: 480, height: 854 });
    expect(outputSize(640, 360, "1080")).toEqual({ width: 640, height: 360 });
    expect(outputSize(641, 361, "original")).toEqual({ width: 642, height: 362 });
  });

  it("lower quality means a smaller file", () => {
    const base = defaultEdit(10);
    const high = estimateBytes({ ...base, output: { ...base.output, quality: "high" } }, 1920, 1080, 30, true);
    const low = estimateBytes({ ...base, output: { ...base.output, quality: "low" } }, 1920, 1080, 30, true);
    const trimmed = estimateBytes({ ...base, trimEnd: 5, output: { ...base.output, quality: "low" } }, 1920, 1080, 30, true);
    expect(low).toBeLessThan(high);
    expect(trimmed).toBeCloseTo(low / 2, -3);
    expect(videoBitrate({ ...base.output, quality: "custom", bitrate: 2.5 }, 1920, 1080, 30)).toBe(2_500_000);
  });

  it("defaults to maximum quality, which never drops below the original's bitrate", () => {
    const base = defaultEdit(10);
    expect(base.output.quality).toBe("maximum");
    const fullHd = 1920 * 1080 * 30;
    // A phone clip at ~0.25 bits per pixel (≈ 16 Mb/s): maximum gives 1.5× that.
    expect(videoBitrate(base.output, 1920, 1080, 30, 0.25)).toBeCloseTo(fullHd * 0.375, -3);
    // An unusually lean source still gets the visually lossless floor.
    expect(videoBitrate(base.output, 1920, 1080, 30, 0.02)).toBeCloseTo(fullHd * 0.3, -3);
    const high = videoBitrate({ ...base.output, quality: "high" }, 1920, 1080, 30, 0.25);
    const medium = videoBitrate({ ...base.output, quality: "medium" }, 1920, 1080, 30, 0.25);
    expect(high).toBeLessThan(videoBitrate(base.output, 1920, 1080, 30, 0.25));
    expect(medium).toBeLessThan(high);
    expect(high).toBeGreaterThan(10e6);
    expect(sourceBitsPerPixel(20e6, 10, 1920, 1080, 30)).toBeCloseTo((20e6 * 8) / 10 / fullHd);
  });

  it("recognizes video files", () => {
    expect(isVideoFile({ name: "clip.MOV", type: "" })).toBe(true);
    expect(isVideoFile({ name: "a.mp4", type: "video/mp4" })).toBe(true);
    expect(isVideoFile({ name: "a.jpg", type: "image/jpeg" })).toBe(false);
  });
});

describe("mp4 demuxing", () => {
  it("reads tracks, samples and decoder configs", async () => {
    const bytes = readFileSync("tests/fixtures/clip.mp4");
    const d = await demux(new Blob([bytes]));
    expect(d.video.config.codec).toMatch(/^vp09/);
    expect(d.video.config.codedWidth).toBe(320);
    expect(d.video.samples).toHaveLength(60);
    expect(d.video.samples[0].is_sync).toBe(true);
    expect(d.video.fps).toBeCloseTo(30, 0);
    expect(d.video.rotation).toBe(0);
    expect(d.duration).toBeCloseTo(2, 1);
    expect(d.audio?.codec).toBe("opus");
    const head = new TextDecoder().decode((d.audio!.config.description as Uint8Array).slice(0, 8));
    expect(head).toBe("OpusHead");
  });
});
