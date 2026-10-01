/// <reference lib="webworker" />
import { type Channels, mixSoundtrack, renderSegment, SAMPLE_RATE, type SegmentAudioJob } from "./dsp";

export type SoundtrackRequest =
  | { type: "source"; clip: string; channels: Float32Array[] | null }
  | { type: "render"; id: number; duration: number; parts: { start: number; job: SegmentAudioJob }[] };

export type SoundtrackResponse = { type: "rendered"; id: number; channels: Float32Array[] } | { type: "error"; id: number; message: string };

const sources = new Map<string, Channels | null>();
/** Rendered segments by their job (a segment re-renders only when it changes). */
const cache = new Map<string, Channels>();
const MAX_CACHE = 96;

self.onmessage = (e: MessageEvent<SoundtrackRequest>) => {
  const m = e.data;
  if (m.type === "source") {
    sources.set(m.clip, m.channels);
    for (const key of [...cache.keys()]) if (key.startsWith(`${m.clip}|`)) cache.delete(key);
    return;
  }
  try {
    const parts = m.parts.map(({ start, job }) => {
      const key = `${job.clip}|${JSON.stringify(job)}`;
      let channels = cache.get(key);
      if (!channels) {
        channels = renderSegment(sources.get(job.clip) ?? null, job, SAMPLE_RATE);
        cache.set(key, channels);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
      } else {
        // Refresh its place in the LRU order.
        cache.delete(key);
        cache.set(key, channels);
      }
      return { start, channels };
    });
    const out = mixSoundtrack(parts, m.duration, SAMPLE_RATE);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "rendered", id: m.id, channels: out } satisfies SoundtrackResponse, out.map((c) => c.buffer));
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "error", id: m.id, message: error instanceof Error ? error.message : String(error) } satisfies SoundtrackResponse);
  }
};
