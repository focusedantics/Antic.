/// <reference lib="webworker" />
import { type Channels, mixSoundtrack, renderSegment, SAMPLE_RATE, type SegmentAudioJob } from "./dsp";

export type SoundtrackRequest =
  | { type: "source"; clip: string; channels: Float32Array[] | null }
  | { type: "render"; id: number; duration: number; parts: { start: number; job: SegmentAudioJob }[] };

export type SoundtrackResponse = { type: "rendered"; id: number; channels: Float32Array[] } | { type: "error"; id: number; message: string };

const sources = new Map<string, Channels | null>();
/**
 * Rendered segments by their job (a segment re-renders only when it changes), least
 * recently used first out once they hold more than `budget` bytes: an unedited segment
 * is a full copy of its clip's sound, so a count of entries says little.
 */
const cache = new Map<string, Channels>();
let cachedBytes = 0;
const sizeOf = (c: Channels) => c.reduce((sum, ch) => sum + ch.byteLength, 0);
const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const budget = phone ? 96 * 1024 * 1024 : 512 * 1024 * 1024;

function remember(key: string, channels: Channels) {
  const old = cache.get(key);
  if (old) cachedBytes -= sizeOf(old);
  cache.delete(key);
  cache.set(key, channels);
  cachedBytes += sizeOf(channels);
  for (const [k, v] of cache) {
    if (cachedBytes <= budget || cache.size <= 1) break;
    cache.delete(k);
    cachedBytes -= sizeOf(v);
  }
}

self.onmessage = (e: MessageEvent<SoundtrackRequest>) => {
  const m = e.data;
  if (m.type === "source") {
    sources.set(m.clip, m.channels);
    for (const [key, value] of [...cache]) {
      if (!key.startsWith(`${m.clip}|`)) continue;
      cache.delete(key);
      cachedBytes -= sizeOf(value);
    }
    return;
  }
  try {
    const parts = m.parts.map(({ start, job }) => {
      const key = `${job.clip}|${JSON.stringify(job)}`;
      const channels = cache.get(key) ?? renderSegment(sources.get(job.clip) ?? null, job, SAMPLE_RATE);
      // Stored, or moved to the most recently used end.
      remember(key, channels);
      return { start, channels };
    });
    const out = mixSoundtrack(parts, m.duration, SAMPLE_RATE);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "rendered", id: m.id, channels: out } satisfies SoundtrackResponse, out.map((c) => c.buffer));
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "error", id: m.id, message: error instanceof Error ? error.message : String(error) } satisfies SoundtrackResponse);
  }
};
