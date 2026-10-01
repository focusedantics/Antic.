import { type AudioPiece, type Channels, SAMPLE_RATE, type SegmentAudioJob } from "./dsp";
import type { VideoEdit } from "./model";
import type { ClipInfo, Plan } from "./timeline";
import type { SoundtrackRequest, SoundtrackResponse } from "./soundtrack.worker";

/**
 * The edited soundtrack: source audio is decoded once per clip (at 48 kHz),
 * handed to a worker, and the timeline's audio is rendered there from the same
 * pieces the pictures use. Preview playback and export use the same result.
 */

/** Decodes a clip's audio track (null when it has none or it can't be decoded). */
export async function decodeClipAudio(file: Blob): Promise<Channels | null> {
  try {
    const context = new OfflineAudioContext(2, 1, SAMPLE_RATE);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    return Array.from({ length: buffer.numberOfChannels }, (_, k) => buffer.getChannelData(k).slice());
  } catch {
    return null;
  }
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

  /** Gives the worker a clip's decoded audio (null = silent). */
  setSource(clip: string, channels: Channels | null) {
    this.loaded.add(clip);
    const copy = channels?.map((c) => c.slice()) ?? null;
    this.worker.postMessage({ type: "source", clip, channels: copy } satisfies SoundtrackRequest, copy?.map((c) => c.buffer) ?? []);
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
