import { describe, expect, it } from "vitest";
import { outputSize, sizePlan } from "@/core/video/model";

describe("fitting a video under a size limit", () => {
  it("spends 92% of the limit, at most 15% of it on sound", () => {
    // 27 s of 720p at 30 fps under 10 MB: ~2.7 Mb/s in all.
    const p = sizePlan(10e6, 27, 1280, 720, 30, "original", true);
    const total = (10e6 * 0.92 * 8) / 27;
    expect(p.audioKbps).toBe(320); // 15% of ~2.7 Mb/s is ~410 kb/s
    expect(p.videoBitrate).toBe(Math.round(total - 320_000));
    // A long clip: the sound shrinks with the budget.
    expect(sizePlan(10e6, 300, 1280, 720, 30, "original", true).audioKbps).toBe(96);
    expect(p.resolution).toBe("original");
  });

  it("steps the frame down when the picture would get too few bits, unless a resolution was chosen", () => {
    // A minute of 1080p under 10 MB: ~1.2 Mb/s, too little for 1080p or 720p, enough for 480p.
    const p = sizePlan(10e6, 60, 1920, 1080, 30, "original", true);
    const s = outputSize(1920, 1080, p.resolution);
    expect(s.height).toBe(480);
    expect(p.videoBitrate / (s.width * s.height * 30)).toBeGreaterThanOrEqual(0.05);
    // Three minutes: it stops at the smallest step.
    expect(outputSize(1920, 1080, sizePlan(10e6, 180, 1920, 1080, 30, "original", true).resolution).height).toBe(360);
    expect(sizePlan(10e6, 180, 1920, 1080, 30, "1080", true).resolution).toBe("1080");
  });

  it("gives a retry fewer bits, and the sound back to the picture when there is none", () => {
    const first = sizePlan(10e6, 60, 1280, 720, 30, "original", true);
    const retry = sizePlan(10e6, 60, 1280, 720, 30, "original", true, 0.8);
    expect(retry.videoBitrate).toBeLessThan(first.videoBitrate);
    const silent = sizePlan(10e6, 60, 1280, 720, 30, "original", false);
    expect(silent.videoBitrate).toBeGreaterThan(first.videoBitrate);
  });
});
