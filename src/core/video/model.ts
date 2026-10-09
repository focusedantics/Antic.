import { sanitizeEffect } from "@/core/effects/registry";
import type { EffectInstance } from "@/core/effects/types";
import { createId } from "@/lib/id";

/**
 * A video edit is plain data, like a develop recipe: a timeline of segments
 * cut from source clips, each with its own YouTube Poop style treatment
 * (speed, pitch, reverse, stutter, ping-pong, stare-down freeze, audio and
 * visual effects), a whole-video effect and the output settings. Source files
 * are never modified; exporting renders a new file.
 *
 * Times are seconds of the segment's source clip. The engine snaps them to
 * that clip's frames, so a segment always covers whole frames.
 */

/** Audio treatments, each 0 (off) … 1 (full). */
export type AudioFx = {
  /** Gain plus hard clipping: "ear rape". */
  readonly earrape: number;
  /** Feedback echo; `echoTime` is the delay in seconds. */
  readonly echo: number;
  readonly echoTime: number;
  readonly reverb: number;
  readonly chorus: number;
  /** Pitch wobble. */
  readonly vibrato: number;
  /** Harmonizer: a suspended-fourth chord (root, +5, +7 semitones) stacked on the voice. */
  readonly sus: number;
  /** Fewer bits and a lower sample rate. */
  readonly bitcrush: number;
};

/** Visual treatments applied before the effects. */
export type VisualFx = {
  readonly mirror: boolean;
  readonly flip: boolean;
  readonly invert: boolean;
  /** Degrees. */
  readonly hue: number;
  /** Hue cycles over time ("rainbow"). */
  readonly rainbow: boolean;
  /** 1 … 4, centred: the classic stare-down zoom. */
  readonly zoom: number;
  /** 0 … 1 camera shake. */
  readonly shake: number;
  /** 0 … 1 extra contrast and saturation ("deep fried"). */
  readonly contrast: number;
};

export type Segment = {
  readonly id: string;
  /** Source clip id; null = the clip this edit belongs to. */
  readonly clip: string | null;
  /** Source range, seconds. */
  readonly in: number;
  readonly out: number;
  /** Playback rate, 0.1 … 8. */
  readonly speed: number;
  /** With a speed change, keep the voice's pitch (time-stretch) instead of tape-style chipmunk / slow-mo. */
  readonly keepPitch: boolean;
  /** Semitones, −24 … +24, without changing the timing. */
  readonly pitch: number;
  readonly reverse: boolean;
  /** Stutter: the first `stutterLength` seconds play `stutter` times in total before the rest ("w-w-w-what"). */
  readonly stutter: number;
  readonly stutterLength: number;
  /** Extra back-and-forth passes after the segment ("dance" / ping-pong). */
  readonly pingPong: number;
  /** Seconds the last frame is held afterwards, silent ("stare down"). */
  readonly hold: number;
  /** Decibels, −40 … +24. */
  readonly volume: number;
  readonly mute: boolean;
  readonly audio: AudioFx;
  readonly visual: VisualFx;
  /** An effect from the library on this segment only. */
  readonly effect: EffectInstance | null;
  readonly effectMix: number;
};

export type Resolution = "original" | "2160" | "1440" | "1080" | "720" | "480" | "360";

/**
 * - `mkv-lossless`: VP9 at quantizer 0 (mathematically lossless) + uncompressed 24-bit PCM audio. Truly lossless.
 * - `mp4-lossless`: the same lossless VP9 video in MP4, with lossless FLAC sound (core/video/flac.ts).
 * - `mp4-h264`: H.264 at near-lossless constant quality, with AAC sound (MP3 where the browser has no AAC encoder).
 */
export type ExportFormat = "mkv-lossless" | "mp4-lossless" | "mp4-h264";

/** The Compatible format's file size: the best quality, or under a limit (Discord's 10 MB, Nitro Basic's 50 MB…). */
export type OutputSize = "best" | "10" | "25" | "50";

export type VideoOutput = {
  readonly format: ExportFormat;
  readonly resolution: Resolution;
  readonly audio: boolean;
  readonly size: OutputSize;
};

export type VideoEdit = {
  readonly version: 3;
  readonly segments: readonly Segment[];
  /** An effect on the whole video (also what Looks save and apply). */
  readonly effect: EffectInstance | null;
  /** 0..1: how much of the effect shows over the frame. */
  readonly effectMix: number;
  readonly output: VideoOutput;
};

export const FORMATS: { id: ExportFormat; label: string; extension: "mkv" | "mp4"; detail: string }[] = [
  {
    id: "mkv-lossless",
    label: "Lossless master (.mkv)",
    extension: "mkv",
    detail: "Every frame bit-exact (lossless VP9) with uncompressed audio. Large files; plays in VLC, mpv, Chrome and DaVinci Resolve.",
  },
  {
    id: "mp4-lossless",
    label: "Lossless video (.mp4)",
    extension: "mp4",
    detail: "Lossless VP9 frames with lossless FLAC sound, for editing and YouTube. Doesn't play on iPhones or in Discord: to share, choose Compatible.",
  },
  { id: "mp4-h264", label: "Compatible (.mp4, H.264)", extension: "mp4", detail: "Near-lossless H.264 with AAC (or MP3) sound: plays everywhere, iPhones and Discord included. Not bit-exact." },
];

export const SIZES: { id: OutputSize; label: string; bytes: number }[] = [
  { id: "best", label: "Best quality (large)", bytes: 0 },
  { id: "10", label: "Under 10 MB (Discord)", bytes: 10e6 },
  { id: "25", label: "Under 25 MB", bytes: 25e6 },
  { id: "50", label: "Under 50 MB (Discord Nitro Basic)", bytes: 50e6 },
];

export const RESOLUTIONS: { id: Resolution; label: string; lines: number }[] = [
  { id: "original", label: "Original", lines: 0 },
  { id: "2160", label: "4K (2160p)", lines: 2160 },
  { id: "1440", label: "1440p", lines: 1440 },
  { id: "1080", label: "1080p", lines: 1080 },
  { id: "720", label: "720p", lines: 720 },
  { id: "480", label: "480p", lines: 480 },
  { id: "360", label: "360p", lines: 360 },
];

export const defaultAudioFx: AudioFx = { earrape: 0, echo: 0, echoTime: 0.25, reverb: 0, chorus: 0, vibrato: 0, sus: 0, bitcrush: 0 };
export const defaultVisualFx: VisualFx = { mirror: false, flip: false, invert: false, hue: 0, rainbow: false, zoom: 1, shake: 0, contrast: 0 };
export const defaultOutput: VideoOutput = { format: "mkv-lossless", resolution: "original", audio: true, size: "best" };

export function newSegment(clip: string | null, start: number, end: number): Segment {
  return {
    id: createId("seg"),
    clip,
    in: start,
    out: end,
    speed: 1,
    keepPitch: false,
    pitch: 0,
    reverse: false,
    stutter: 1,
    stutterLength: 0.2,
    pingPong: 0,
    hold: 0,
    volume: 0,
    mute: false,
    audio: defaultAudioFx,
    visual: defaultVisualFx,
    effect: null,
    effectMix: 1,
  };
}

export function defaultEdit(duration: number): VideoEdit {
  return { version: 3, segments: [newSegment(null, 0, Math.max(0, duration))], effect: null, effectMix: 1, output: defaultOutput };
}

const sameAudio = (a: AudioFx) => (Object.keys(defaultAudioFx) as (keyof AudioFx)[]).every((k) => a[k] === defaultAudioFx[k]);
const sameVisual = (v: VisualFx) => (Object.keys(defaultVisualFx) as (keyof VisualFx)[]).every((k) => v[k] === defaultVisualFx[k]);

/** True when a segment's pictures are its source frames as they are (timing and sound may differ). */
export const hasPlainPictures = (s: Segment) => !(s.effect && s.effectMix > 0) && sameVisual(s.visual);

/** True when a segment's sound is its source audio as it is (apart from timing). */
export const hasPlainSound = (s: Segment) => s.pitch === 0 && s.volume === 0 && !s.mute && sameAudio(s.audio);

/** True when a segment plays its source exactly as it is. */
export const isPlainSegment = (s: Segment) => s.speed === 1 && !s.reverse && s.stutter <= 1 && s.pingPong === 0 && s.hold === 0 && hasPlainPictures(s) && hasPlainSound(s);

const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly { id: T }[], fallback: T): T => (list.some((x) => x.id === v) ? (v as T) : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function sanitizeAudio(v: unknown): AudioFx {
  const a = obj(v);
  return {
    earrape: num(a.earrape, 0, 0, 1),
    echo: num(a.echo, 0, 0, 1),
    echoTime: num(a.echoTime, 0.25, 0.02, 2),
    reverb: num(a.reverb, 0, 0, 1),
    chorus: num(a.chorus, 0, 0, 1),
    vibrato: num(a.vibrato, 0, 0, 1),
    sus: num(a.sus, 0, 0, 1),
    bitcrush: num(a.bitcrush, 0, 0, 1),
  };
}

function sanitizeVisual(v: unknown): VisualFx {
  const a = obj(v);
  return {
    mirror: a.mirror === true,
    flip: a.flip === true,
    invert: a.invert === true,
    hue: num(a.hue, 0, -180, 180),
    rainbow: a.rainbow === true,
    zoom: num(a.zoom, 1, 1, 4),
    shake: num(a.shake, 0, 0, 1),
    contrast: num(a.contrast, 0, 0, 1),
  };
}

/** Validates one segment; `duration` is its source clip's length (Infinity when unknown). */
export function sanitizeSegment(v: unknown, duration: number): Segment | null {
  const s = obj(v);
  const d = Math.max(0, duration);
  const start = num(s.in, 0, 0, d);
  const end = num(s.out, d, start, d);
  if (!(end > start) || !Number.isFinite(end)) return null;
  return {
    id: typeof s.id === "string" && s.id.length > 0 && s.id.length <= 64 ? s.id : createId("seg"),
    clip: typeof s.clip === "string" && s.clip.length <= 64 ? s.clip : null,
    in: start,
    out: end,
    speed: num(s.speed, 1, 0.1, 8),
    keepPitch: s.keepPitch === true,
    pitch: Math.round(num(s.pitch, 0, -24, 24) * 10) / 10,
    reverse: s.reverse === true,
    stutter: Math.round(num(s.stutter, 1, 1, 32)),
    stutterLength: num(s.stutterLength, 0.2, 0.01, 5),
    pingPong: Math.round(num(s.pingPong, 0, 0, 16)),
    hold: num(s.hold, 0, 0, 30),
    volume: num(s.volume, 0, -40, 24),
    mute: s.mute === true,
    audio: sanitizeAudio(s.audio),
    visual: sanitizeVisual(s.visual),
    effect: s.effect ? sanitizeEffect(s.effect) : null,
    effectMix: num(s.effectMix, 1, 0, 1),
  };
}

/**
 * Validates an edit from storage. `duration` is the clip's own length;
 * `durationOf` gives other clips' lengths for segments cut from them.
 * Version 1–2 edits (one trim range) become a single segment.
 */
export function sanitizeEdit(v: unknown, duration: number, durationOf: (clip: string) => number = () => Infinity): VideoEdit {
  const e = obj(v);
  const o = obj(e.output);
  const d = Math.max(0, duration);
  let segments: Segment[];
  if (e.version === 3 && Array.isArray(e.segments)) {
    segments = e.segments
      .slice(0, 2000)
      .map((s) => {
        const clip = obj(s).clip;
        return sanitizeSegment(s, typeof clip === "string" ? durationOf(clip) : d);
      })
      .filter((s): s is Segment => !!s);
  } else {
    // Earlier versions: a single trim range.
    const start = num(e.trimStart, 0, 0, d);
    const end = num(e.trimEnd, d, start, d);
    segments = end > start ? [newSegment(null, start, end)] : [];
  }
  if (!segments.length && d > 0) segments = [newSegment(null, 0, d)];
  return {
    version: 3,
    segments,
    effect: e.effect ? sanitizeEffect(e.effect) : null,
    effectMix: num(e.effectMix, 1, 0, 1),
    output: {
      format: oneOf(o.format, FORMATS, defaultOutput.format),
      resolution: oneOf(o.resolution, RESOLUTIONS, defaultOutput.resolution),
      audio: o.audio !== false,
      size: oneOf(o.size, SIZES, defaultOutput.size),
    },
  };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Output frame size: the short side shrinks to the chosen resolution, never enlarges, and stays even for the encoders. */
export function outputSize(width: number, height: number, resolution: Resolution) {
  const lines = RESOLUTIONS.find((r) => r.id === resolution)?.lines ?? 0;
  const short = Math.min(width, height);
  const scale = lines && lines < short ? lines / short : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

/** Sound bitrates (kb/s) a size-limited export picks from: what AAC and our MP3 encoder both make. */
const SOUND_KBPS = [320, 256, 192, 160, 128, 96] as const;

export type SizePlan = { readonly resolution: Resolution; readonly videoBitrate: number; readonly audioKbps: (typeof SOUND_KBPS)[number] };

/**
 * How a size-limited export spends its bytes: 92% of the limit (container and the
 * encoder's overshoot take the rest), times `shrink` when a first try came out too big;
 * the sound gets at most 15% of it; the picture the rest. With the Original resolution,
 * the frame steps down (1080p, 720p, 480p…) while the picture would get under 0.05 bits
 * per pixel, where it turns to blocks; a resolution chosen by hand is kept.
 */
export function sizePlan(bytes: number, seconds: number, width: number, height: number, fps: number, resolution: Resolution, sound: boolean, shrink = 1): SizePlan {
  const total = (bytes * 0.92 * shrink * 8) / Math.max(0.1, seconds);
  const audioKbps = SOUND_KBPS.find((k) => k * 1000 <= total * 0.15) ?? 96;
  const videoBitrate = Math.max(100_000, Math.round(total - (sound ? audioKbps * 1000 : 0)));
  let chosen = resolution;
  if (resolution === "original") {
    const steps = RESOLUTIONS.filter((r) => r.lines && r.lines < Math.min(width, height));
    for (const r of [{ id: "original" as Resolution }, ...steps.filter((r) => r.lines <= 1080)]) {
      chosen = r.id;
      const s = outputSize(width, height, r.id);
      if (videoBitrate / (s.width * s.height * fps) >= 0.05) break;
    }
  }
  return { resolution: chosen, videoBitrate, audioKbps };
}

/** Bits per pixel per frame of a source track (its size over its duration). */
export function sourceBitsPerPixel(bytes: number, seconds: number, width: number, height: number, fps: number) {
  return seconds > 0 && width * height * fps > 0 ? (bytes * 8) / seconds / (width * height * fps) : 0;
}

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov"];
export const isVideoFile = (f: { name: string; type: string }) =>
  f.type === "video/mp4" || f.type === "video/quicktime" || f.type === "video/x-m4v" || VIDEO_EXTENSIONS.includes(f.name.split(".").pop()?.toLowerCase() ?? "");
