import { type AudioPiece, type Channels, SAMPLE_RATE, type SegmentAudioJob } from "./dsp";
import { device } from "@/lib/device";
import { audible } from "./pcm";
import { type Demuxed, type DemuxedAudio, SampleReader } from "./demux";
import type { VideoEdit } from "./model";
import type { ClipInfo, Plan } from "./timeline";
import type { SoundtrackRequest, SoundtrackResponse } from "./soundtrack.worker";

/**
 * The edited soundtrack: source audio is decoded once per clip (at 48 kHz),
 * handed to a worker, and the timeline's audio is rendered there from the same
 * pieces the pictures use. Preview playback and export use the same result.
 */

/**
 * An ADTS stream (raw AAC frames, each with a 7-byte header) for an MP4 AAC
 * track: something every browser's decodeAudioData reads, without handing it
 * the whole video file. Null when the AudioSpecificConfig can't be expressed
 * in ADTS (explicit sample rates, AAC object types above 4).
 */
export async function adtsStream(audio: DemuxedAudio): Promise<Uint8Array | null> {
  const d = audio.config.description;
  const asc = !d ? null : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  if (!asc || asc.length < 2) return null;
  const objectType = asc[0] >> 3;
  const freqIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const channelConfig = (asc[1] >> 3) & 15;
  if (objectType < 1 || objectType > 4 || freqIndex > 12 || !channelConfig) return null;
  const reader = new SampleReader(audio.file);
  const total = audio.samples.reduce((n, s) => n + s.size + 7, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const s of audio.samples) {
    const len = s.size + 7;
    out[at] = 0xff;
    out[at + 1] = 0xf1; // MPEG-4, layer 0, no CRC
    out[at + 2] = ((objectType - 1) << 6) | (freqIndex << 2) | (channelConfig >> 2);
    out[at + 3] = ((channelConfig & 3) << 6) | (len >> 11);
    out[at + 4] = (len >> 3) & 0xff;
    out[at + 5] = ((len & 7) << 5) | 0x1f;
    out[at + 6] = 0xfc;
    out.set(await reader.read(s), at + 7);
    at += len;
  }
  return out;
}

/** Most bytes handed to decodeAudioData as a whole file (it is held in memory twice). */
const WHOLE_FILE_LIMIT = () => (device.lite ? 300e6 : 2e9);

/** Copies a clip's audio out of an AudioBuffer from `skip` seconds (the encoder's priming). */
function channelsOf(buffer: AudioBuffer, skip = 0): Channels {
  const from = Math.min(buffer.length, Math.round(skip * buffer.sampleRate));
  return Array.from({ length: buffer.numberOfChannels }, (_, k) => buffer.getChannelData(k).slice(from));
}

/**
 * Decodes an audio track sample by sample with WebCodecs, reading only the track's own
 * bytes (so a 4K iPhone clip of any size works), and resamples to 48 kHz. Null when
 * the browser has no AudioDecoder for the codec.
 */
export async function decodeTrackWithWebCodecs(audio: DemuxedAudio): Promise<Channels | null> {
  if (typeof AudioDecoder === "undefined" || !audio.samples.length) return null;
  const config: AudioDecoderConfig = { ...audio.config, codec: audio.codec === "opus" ? "opus" : audio.config.codec };
  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return null;
  const blocks: Float32Array[][] = [];
  let rate = config.sampleRate;
  let failure: unknown = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      rate = data.sampleRate;
      const planes: Float32Array[] = [];
      for (let c = 0; c < data.numberOfChannels; c++) {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        planes.push(plane);
      }
      blocks.push(planes);
      data.close();
    },
    error: (e) => {
      failure = e;
    },
  });
  try {
    decoder.configure(config);
    const reader = new SampleReader(audio.file);
    const ts = audio.track.timescale;
    for (const s of audio.samples) {
      // Keep the queue short: decoding runs ahead of reading otherwise.
      while (decoder.decodeQueueSize > 32 && !failure) await new Promise((r) => setTimeout(r, 0));
      if (failure) throw failure;
      const data = (await reader.read(s)).slice();
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((s.cts / ts) * 1e6), duration: Math.round((s.duration / ts) * 1e6), data }));
    }
    await decoder.flush();
    if (failure) throw failure;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  const channels = Math.max(1, ...blocks.map((b) => b.length));
  const length = blocks.reduce((n, b) => n + (b[0]?.length ?? 0), 0);
  if (!length) return null;
  const joined = Array.from({ length: channels }, () => new Float32Array(length));
  let at = 0;
  for (const b of blocks) {
    for (let c = 0; c < channels; c++) joined[c].set(b[Math.min(c, b.length - 1)], at);
    at += b[0].length;
  }
  const skip = Math.round(audio.skip * rate);
  const trimmed = joined.map((c) => c.subarray(Math.min(c.length, skip)));
  if (rate === SAMPLE_RATE) return trimmed.map((c) => c.slice());
  // Resample to 48 kHz through an offline audio graph.
  const frames = trimmed[0].length;
  const offline = new OfflineAudioContext(channels, Math.max(1, Math.ceil((frames * SAMPLE_RATE) / rate)), SAMPLE_RATE);
  const buffer = offline.createBuffer(channels, Math.max(1, frames), rate);
  trimmed.forEach((c, k) => buffer.copyToChannel(c, k));
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return channelsOf(await offline.startRendering());
}

/**
 * Decodes a clip's audio track at 48 kHz (null when it has none or nothing here can
 * decode it). AAC tries a small ADTS stream of the track alone, then WebCodecs, then
 * the whole file; Opus the whole file (its edit list applied by the browser), then
 * WebCodecs for files too large to load at once.
 */
export async function decodeClipAudio(media: Demuxed): Promise<Channels | null> {
  const audio = media.audio;
  if (!audio) return null;
  const context = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  // A way that decodes to pure silence is treated as failing (a decoder that
  // misreads the track can do that), unless every way does: then the clip is silent.
  let quiet: Channels | null = null;
  const attempt = async (decode: () => Promise<Channels | null>) => {
    try {
      const c = await decode();
      if (!c || !c.length || !c[0].length) return null;
      if (audible(c)) return c;
      quiet ??= c;
      return null;
    } catch {
      return null;
    }
  };
  const whole = () =>
    attempt(async () => (media.video.file.size > WHOLE_FILE_LIMIT() ? null : channelsOf(await context.decodeAudioData(await media.video.file.arrayBuffer()))));
  if (audio.codec === "aac") {
    return (
      (await attempt(async () => {
        const adts = await adtsStream(audio);
        return adts ? channelsOf(await context.decodeAudioData(adts.buffer as ArrayBuffer), audio.skip) : null;
      })) ??
      (await attempt(() => decodeTrackWithWebCodecs(audio))) ??
      (await whole()) ??
      quiet
    );
  }
  return (await whole()) ?? (await attempt(() => decodeTrackWithWebCodecs(audio))) ?? quiet;
}


/** The audio jobs of a compiled plan: one per segment, positioned on the timeline. */
export function audioParts(edit: VideoEdit, plan: Plan, ownClip: string, infoOf: (clip: string) => ClipInfo | undefined): { start: number; job: SegmentAudioJob }[] {
  return edit.segments.map((s, index) => {
    const span = plan.spans[index];
    const clip = s.clip ?? ownClip;
    const fps = infoOf(clip)?.fps ?? 30;
    const pieces: AudioPiece[] = plan.pieces
      .filter((p) => p.segment === index)
      .map((p) => {
        const reverse = p.to < p.from;
        return {
          from: (reverse ? p.to : p.from) / fps,
          to: (reverse ? p.from : p.to) / fps,
          reverse,
          rate: p.rate,
          offset: p.start - span.start,
          duration: p.duration,
        };
      });
    return {
      start: span.start,
      job: { clip, pieces, duration: span.end - span.start, keepPitch: s.keepPitch, pitch: s.pitch, volume: s.volume, mute: s.mute, fx: s.audio },
    };
  });
}

export class Soundtrack {
  private readonly worker = new Worker(new URL("./soundtrack.worker.ts", import.meta.url), { type: "module", name: "soundtrack" });
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (c: Channels) => void; reject: (e: Error) => void }>();
  private readonly loaded = new Set<string>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<SoundtrackResponse>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === "rendered") p.resolve(m.channels);
      else p.reject(new Error(m.message));
    };
  }

  hasSource(clip: string) {
    return this.loaded.has(clip);
  }

  /**
   * Gives the worker a clip's decoded audio (null = silent). The arrays are transferred,
   * not copied (a 5-minute clip is 115 MB): the caller must not use them afterwards.
   */
  setSource(clip: string, channels: Channels | null) {
    this.loaded.add(clip);
    const own = channels?.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice())) ?? null;
    this.worker.postMessage({ type: "source", clip, channels: own } satisfies SoundtrackRequest, own?.map((c) => c.buffer) ?? []);
  }

  render(parts: { start: number; job: SegmentAudioJob }[], duration: number): Promise<Channels> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "render", id, duration, parts } satisfies SoundtrackRequest);
    });
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("Stopped"));
    this.pending.clear();
  }
}
