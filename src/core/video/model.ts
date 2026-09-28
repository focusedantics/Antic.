import { sanitizeEffect } from "@/core/effects/registry";
import type { EffectInstance } from "@/core/effects/types";

/**
 * A video edit is plain data, like a develop recipe: trim points, an optional
 * effect with its strength, and the output settings. The source file is never
 * modified; exporting renders a new MP4.
 */
export type Resolution = "original" | "2160" | "1440" | "1080" | "720" | "480" | "360";
export type Quality = "maximum" | "high" | "medium" | "low" | "custom";
export type FrameRate = "original" | "60" | "30" | "24" | "15";

export type VideoOutput = {
  readonly resolution: Resolution;
  readonly quality: Quality;
  /** Megabits per second when quality is "custom". */
  readonly bitrate: number;
  readonly frameRate: FrameRate;
  readonly audio: boolean;
};

export type VideoEdit = {
  readonly version: 1;
  /** Seconds from the start of the source. */
  readonly trimStart: number;
  readonly trimEnd: number;
  readonly effect: EffectInstance | null;
  /** 0..1: how much of the effect shows over the original frame. */
  readonly effectMix: number;
  readonly output: VideoOutput;
};

export const RESOLUTIONS: { id: Resolution; label: string; lines: number }[] = [
  { id: "original", label: "Original", lines: 0 },
  { id: "2160", label: "4K (2160p)", lines: 2160 },
  { id: "1440", label: "1440p", lines: 1440 },
  { id: "1080", label: "1080p", lines: 1080 },
  { id: "720", label: "720p", lines: 720 },
  { id: "480", label: "480p", lines: 480 },
  { id: "360", label: "360p", lines: 360 },
];

/**
 * Browser encoders have no lossless mode, so "Maximum" is the closest thing:
 * at least the source's own bits per pixel with 50 % headroom for the
 * re-encode, and never below a visually lossless floor.
 */
export const QUALITIES: { id: Quality; label: string; bitsPerPixel: number }[] = [
  { id: "maximum", label: "Maximum (matches the original)", bitsPerPixel: 0.3 },
  { id: "high", label: "High", bitsPerPixel: 0.2 },
  { id: "medium", label: "Medium", bitsPerPixel: 0.1 },
  { id: "low", label: "Low (small file)", bitsPerPixel: 0.035 },
  { id: "custom", label: "Custom bitrate", bitsPerPixel: 0 },
];

export const MAX_BITRATE = 200e6;

export const FRAME_RATES: { id: FrameRate; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "60", label: "60 fps" },
  { id: "30", label: "30 fps" },
  { id: "24", label: "24 fps" },
  { id: "15", label: "15 fps" },
];

export const defaultOutput: VideoOutput = { resolution: "original", quality: "maximum", bitrate: 20, frameRate: "original", audio: true };

export function defaultEdit(duration: number): VideoEdit {
  return { version: 1, trimStart: 0, trimEnd: Math.max(0, duration), effect: null, effectMix: 1, output: defaultOutput };
}

const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly { id: T }[], fallback: T): T => (list.some((x) => x.id === v) ? (v as T) : fallback);

/** Validates an edit from storage against the clip's duration. */
export function sanitizeEdit(v: unknown, duration: number): VideoEdit {
  const e = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const o = e.output && typeof e.output === "object" ? (e.output as Record<string, unknown>) : {};
  const d = Math.max(0, duration);
  const trimStart = num(e.trimStart, 0, 0, d);
  const trimEnd = num(e.trimEnd, d, trimStart, d);
  return {
    version: 1,
    trimStart,
    trimEnd,
    effect: e.effect ? sanitizeEffect(e.effect) : null,
    effectMix: num(e.effectMix, 1, 0, 1),
    output: {
      resolution: oneOf(o.resolution, RESOLUTIONS, defaultOutput.resolution),
      quality: oneOf(o.quality, QUALITIES, defaultOutput.quality),
      bitrate: num(o.bitrate, defaultOutput.bitrate, 0.2, MAX_BITRATE / 1e6),
      frameRate: oneOf(o.frameRate, FRAME_RATES, defaultOutput.frameRate),
      audio: o.audio !== false,
    },
  };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Output frame size: the short side shrinks to the chosen resolution, never enlarges, and stays even for H.264. */
export function outputSize(width: number, height: number, resolution: Resolution) {
  const lines = RESOLUTIONS.find((r) => r.id === resolution)?.lines ?? 0;
  const short = Math.min(width, height);
  const scale = lines && lines < short ? lines / short : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

/** Bits per pixel per frame of a source track (its size over its duration). */
export function sourceBitsPerPixel(bytes: number, seconds: number, width: number, height: number, fps: number) {
  return seconds > 0 && width * height * fps > 0 ? (bytes * 8) / seconds / (width * height * fps) : 0;
}

/** Target video bitrate in bits per second; `sourceBpp` is the original's bits per pixel (0 = unknown). */
export function videoBitrate(output: VideoOutput, width: number, height: number, fps: number, sourceBpp = 0) {
  if (output.quality === "custom") return Math.round(output.bitrate * 1e6);
  const q = QUALITIES.find((x) => x.id === output.quality)!;
  const bpp = output.quality === "maximum" ? Math.max(q.bitsPerPixel, sourceBpp * 1.5) : q.bitsPerPixel;
  return Math.round(Math.min(MAX_BITRATE, Math.max(250e3, width * height * Math.min(fps, 60) * bpp)));
}

export function outputFrameRate(output: VideoOutput, sourceFps: number) {
  return output.frameRate === "original" ? sourceFps : Math.min(sourceFps, Number(output.frameRate));
}

/** Rough size of the exported file: video bitrate plus ~128 kb/s of audio. */
export function estimateBytes(edit: VideoEdit, width: number, height: number, sourceFps: number, hasAudio: boolean, sourceBpp = 0) {
  const size = outputSize(width, height, edit.output.resolution);
  const fps = outputFrameRate(edit.output, sourceFps);
  const seconds = Math.max(0, edit.trimEnd - edit.trimStart);
  const bits = videoBitrate(edit.output, size.width, size.height, fps, sourceBpp) * seconds + (hasAudio && edit.output.audio ? 128e3 * seconds : 0);
  return bits / 8;
}

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov"];
export const isVideoFile = (f: { name: string; type: string }) =>
  f.type === "video/mp4" || f.type === "video/quicktime" || f.type === "video/x-m4v" || VIDEO_EXTENSIONS.includes(f.name.split(".").pop()?.toLowerCase() ?? "");
