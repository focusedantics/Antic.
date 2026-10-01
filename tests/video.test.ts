import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demux } from "@/core/video/demux";
import { bitcrush, earrape, echo, mixSoundtrack, pitchShift, renderSegment, resample, stretch } from "@/core/video/dsp";
import { encodeOptions, quantizerFor } from "@/core/video/encoder";
import { defaultAudioFx, defaultEdit, isPlainSegment, isVideoFile, newSegment, outputSize, sanitizeEdit, type VideoEdit } from "@/core/video/model";
import { type ClipInfo, compile, duplicateSegments, frameAt, isUntouched, moveSegments, removeSegments, splitAt } from "@/core/video/timeline";

const info: ClipInfo = { fps: 30, frames: 60, duration: 2, width: 320, height: 180 };
const infoOf = () => info;
const edit = (segments = [newSegment(null, 0, 2)]): VideoEdit => ({ ...defaultEdit(2), segments });
const frames = (e: VideoEdit) => {
  const plan = compile(e, "own", infoOf, 30);
  return Array.from({ length: plan.frames }, (_, k) => frameAt(plan, k, infoOf)!.frame);
};

describe("video edits", () => {
  it("migrates a v2 trim into one segment and sanitizes v3", () => {
    const v2 = sanitizeEdit({ version: 2, trimStart: 0.5, trimEnd: 1.5, effect: null, effectMix: 1, output: { quality: "medium" } }, 2);
    expect(v2.version).toBe(3);
    expect(v2.segments).toHaveLength(1);
    expect(v2.segments[0]).toMatchObject({ in: 0.5, out: 1.5, speed: 1, clip: null });
    expect(v2.output.format).toBe("mkv-lossless");
    const v3 = sanitizeEdit({ version: 3, segments: [{ in: -1, out: 99, speed: 100, stutter: 99, pitch: -80, audio: { earrape: 7 }, visual: { zoom: 9 } }, { in: 1, out: 1 }] }, 2);
    expect(v3.segments).toHaveLength(1);
    expect(v3.segments[0]).toMatchObject({ in: 0, out: 2, speed: 8, stutter: 32, pitch: -24 });
    expect(v3.segments[0].audio.earrape).toBe(1);
    expect(v3.segments[0].visual.zoom).toBe(4);
    expect(isPlainSegment(newSegment(null, 0, 1))).toBe(true);
    expect(isVideoFile({ name: "clip.MOV", type: "" })).toBe(true);
    expect(outputSize(1920, 1080, "720")).toEqual({ width: 1280, height: 720 });
  });
});

describe("timeline", () => {
  it("emits every source frame exactly once at normal speed (no drops, no doubles)", () => {
    expect(frames(edit())).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(isUntouched(edit(), info)).toBe(true);
    // Two segments cut from the same clip, back to back.
    const cut = edit([newSegment(null, 0, 1), newSegment(null, 1, 2)]);
    expect(frames(cut)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("keeps the last frame when the stored duration is a little short, but honours a real one-frame trim", () => {
    expect(frames(edit([newSegment(null, 0, 1.98)]))).toHaveLength(60);
    expect(frames(edit([newSegment(null, 0, 59 / 30)]))).toHaveLength(59);
  });

    it("reverses, stutters, ping-pongs, holds and changes speed frame-exactly", () => {
    const base = newSegment(null, 0, 0.2); // frames 0..5
    expect(frames(edit([{ ...base, reverse: true }]))).toEqual([5, 4, 3, 2, 1, 0]);
    expect(frames(edit([{ ...base, stutter: 3, stutterLength: 2 / 30 }]))).toEqual([0, 1, 0, 1, 0, 1, 2, 3, 4, 5]);
    expect(frames(edit([{ ...base, pingPong: 1 }]))).toEqual([0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0]);
    expect(frames(edit([{ ...base, hold: 0.1 }]))).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 5]);
    expect(frames(edit([{ ...base, speed: 2 }]))).toEqual([0, 2, 4]);
    expect(frames(edit([{ ...base, speed: 0.5 }]))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("splits, deletes, duplicates and moves segments (sentence mixing)", () => {
    const e = edit();
    const plan = compile(e, "own", infoOf, 30);
    const split = splitAt(e, plan, 20, infoOf)!;
    expect(split.edit.segments.map((s) => [s.in, s.out])).toEqual([
      [0, 20 / 30],
      [20 / 30, 2],
    ]);
    expect(frames(split.edit)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    const [a, b] = split.edit.segments;
    const swapped = moveSegments(split.edit, new Set([b.id]), 0);
    expect(frames(swapped).slice(0, 3)).toEqual([20, 21, 22]);
    const doubled = duplicateSegments(split.edit, new Set([a.id]));
    expect(doubled.edit.segments).toHaveLength(3);
    expect(frames(doubled.edit)).toHaveLength(80);
    expect(removeSegments(split.edit, new Set([a.id])).segments).toEqual([b]);
    // A reversed segment splits in playback order.
    const rev = edit([{ ...newSegment(null, 0, 1), reverse: true }]);
    const r = splitAt(rev, compile(rev, "own", infoOf, 30), 10, infoOf)!;
    expect(frames(r.edit)).toEqual(frames(rev));
  });
});

describe("audio DSP", () => {
  const tone = (hz: number, seconds: number, rate = 48000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
  /** Dominant frequency by zero crossings. */
  const freq = (c: Float32Array, rate = 48000) => {
    let n = 0;
    for (let i = 1; i < c.length; i++) if (c[i - 1] < 0 && c[i] >= 0) n++;
    return n / (c.length / rate);
  };

  it("resamples (tape speed) and time-stretches (same pitch)", () => {
    const x = tone(220, 1);
    const fast = resample(x, 2);
    expect(fast.length).toBe(24000);
    expect(freq(fast)).toBeCloseTo(440, -1);
    const [long] = stretch([x], 2);
    expect(long.length).toBe(96000);
    expect(freq(long.subarray(4800, 91200))).toBeCloseTo(220, -1);
    const [up] = pitchShift([x], 12);
    expect(up.length).toBe(x.length);
    expect(freq(up.subarray(4800, 43200))).toBeCloseTo(440, -1);
  });

  it("renders a reversed, stuttered segment to the timeline length", () => {
    const ramp = Float32Array.from({ length: 48000 }, (_, i) => i / 48000);
    const job = { clip: "c", duration: 0.5, keepPitch: false, pitch: 0, volume: 0, mute: false, fx: defaultAudioFx, pieces: [{ from: 0, to: 0.5, reverse: true, rate: 1, offset: 0, duration: 0.5 }] };
    const [l] = renderSegment([ramp], job);
    expect(l.length).toBe(24000);
    expect(l[1000]).toBeGreaterThan(l[20000]); // plays backwards
    const muted = renderSegment([ramp], { ...job, mute: true });
    expect(Math.max(...muted[0])).toBe(0);
    const mixed = mixSoundtrack([{ start: 0.25, channels: [l, l] }], 1);
    expect(mixed[0].length).toBe(48000);
    expect(mixed[0][0]).toBe(0);
  });

  it("applies the treatments", () => {
    const x = tone(440, 0.5).map((v) => v * 0.1);
    expect(Math.max(...earrape(x, 1))).toBeGreaterThan(0.9);
    const crushed = bitcrush(x, 1);
    expect(new Set(crushed).size).toBeLessThan(20);
    const e = echo(Float32Array.from({ length: 48000 }, (_, i) => (i === 0 ? 1 : 0)), 1, 0.25, 48000);
    expect(e[12000]).toBeGreaterThan(0.5);
  });
});

describe("encoder", () => {
  it("maps quality to each codec's quantizer (lower is better)", () => {
    expect(quantizerFor("avc", 1)).toBe(8);
    expect(quantizerFor("vp9", 1)).toBe(4);
    expect(encodeOptions({ config: { codec: "avc1.64001f", width: 2, height: 2 }, mux: "avc", quantizer: 13 }, true)).toEqual({ keyFrame: true, avc: { quantizer: 13 } });
    expect(encodeOptions({ config: { codec: "avc1.64001f", width: 2, height: 2 }, mux: "avc", quantizer: null }, false)).toEqual({ keyFrame: false });
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
    expect(d.audio?.codec).toBe("opus");
  });
});

describe("exact YUV shuffles", () => {
  it("crops NV12 to I420 and rotates planes without changing a sample", async () => {
    const { rotatePlane, visibleI420, rotateI420 } = await import("@/core/video/yuv");
    // 4×2 NV12: Y rows then interleaved UV.
    const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21]);
    const f = visibleI420(data, "NV12", [{ offset: 0, stride: 4 }, { offset: 8, stride: 4 }], { x: 0, y: 0, width: 4, height: 2 })!;
    expect([...f.planes[0].data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...f.planes[1].data]).toEqual([10, 11]);
    expect([...f.planes[2].data]).toEqual([20, 21]);
    const p = { data: Uint8Array.from([1, 2, 3, 4, 5, 6]), width: 3, height: 2 }; // 1 2 3 / 4 5 6
    expect(rotatePlane(p, 90)).toEqual({ data: Uint8Array.from([4, 1, 5, 2, 6, 3]), width: 2, height: 3 });
    expect([...rotatePlane(p, 180).data]).toEqual([6, 5, 4, 3, 2, 1]);
    expect(rotatePlane(p, 270)).toEqual({ data: Uint8Array.from([3, 6, 2, 5, 1, 4]), width: 2, height: 3 });
    const r = rotateI420(f, 90);
    expect([r.width, r.height]).toEqual([2, 4]);
    // Four quarter turns are the identity.
    expect(rotatePlane(rotatePlane(rotatePlane(rotatePlane(p, 90), 90), 90), 90)).toEqual(p);
  });
});

describe("mp4 timescale", () => {
  it("is a whole number that makes non-integer frame rates exact", async () => {
    const { mp4Timescale } = await import("@/core/video/export");
    expect(mp4Timescale(30)).toBe(30);
    expect(mp4Timescale(28.96)).toBe(2896);
    expect(mp4Timescale(29.97)).toBe(2997);
    expect(mp4Timescale(23.976)).toBe(23976);
    expect(Number.isInteger(mp4Timescale(Math.PI))).toBe(true);
  });
});
