import type { DemuxedVideo } from "./demux";

/**
 * Frame-accurate, random-access frames of one clip, decoded with WebCodecs.
 *
 * Frames are addressed by presentation index (0 … frames−1). Reading the next
 * frames continues the running decoder; jumping elsewhere (a seek, a reverse
 * play, a stutter) restarts at the keyframe before the wanted frame and
 * decodes forward. Every decoded frame is converted by `store` (a scaled
 * bitmap for the viewer, an exact CPU copy of the planes for export) and kept
 * in an LRU cache, so playing backwards decodes each group of pictures once.
 *
 * Chunk timestamps are the presentation indices themselves, so each decoded
 * frame says exactly which frame it is.
 */
export type FrameStore<T> = {
  /** Converts a decoded frame (the store closes nothing; the source closes it after). */
  convert(frame: VideoFrame): Promise<T>;
  bytes(value: T): number;
  release(value: T): void;
};

export class FrameSource<T> {
  private readonly order: number[];
  private readonly presOf: Int32Array;
  /** For each presentation index, the decode index of the keyframe to start from. */
  private readonly keyOf: Int32Array;
  private decoder: VideoDecoder | null = null;
  private cursor = 0;
  private runStart = -1;
  private lastOut = -1;
  private ended = false;
  private failure: Error | null = null;
  private readonly cache = new Map<number, T>();
  private cachedBytes = 0;
  private readonly converting = new Map<number, Promise<void>>();
  private wake: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;

  readonly frames: number;

  constructor(
    private readonly video: DemuxedVideo,
    private readonly store: FrameStore<T>,
    private readonly budget: number,
  ) {
    const samples = video.samples;
    this.frames = samples.length;
    this.order = samples.map((_, i) => i).sort((a, b) => samples[a].cts - samples[b].cts || a - b);
    this.presOf = new Int32Array(samples.length);
    this.order.forEach((s, p) => (this.presOf[s] = p));
    this.keyOf = new Int32Array(samples.length);
    let key = 0;
    const keyForSample = new Int32Array(samples.length);
    for (let s = 0; s < samples.length; s++) {
      if (samples[s].is_sync) key = s;
      keyForSample[s] = key;
    }
    for (let p = 0; p < samples.length; p++) this.keyOf[p] = keyForSample[this.order[p]];
  }

  /** The cached frame, if any (no decoding). */
  peek(index: number): T | null {
    const v = this.cache.get(this.clampIndex(index));
    if (v === undefined) return null;
    this.touch(this.clampIndex(index), v);
    return v;
  }

  /** Frame `index`, decoding as needed. Requests run one at a time, in order. */
  get(index: number): Promise<T> {
    const i = this.clampIndex(index);
    const hit = this.cache.get(i);
    if (hit !== undefined) {
      this.touch(i, hit);
      return Promise.resolve(hit);
    }
    const run = this.queue.then(() => this.fetch(i));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Decodes `indices` into the cache in the background. A later `cancelPrefetch`
   * (or a new prefetch) drops whatever has not started yet.
   */
  prefetch(indices: readonly number[]) {
    const generation = ++this.generation;
    for (const index of indices) {
      const i = this.clampIndex(index);
      if (this.cache.has(i)) continue;
      const run = this.queue.then(() => (generation === this.generation && !this.disposed ? this.fetch(i) : undefined));
      this.queue = run.catch(() => undefined);
    }
  }

  cancelPrefetch() {
    this.generation++;
  }

  private clampIndex(i: number) {
    return Math.max(0, Math.min(this.frames - 1, Math.round(i)));
  }

  private touch(i: number, v: T) {
    this.cache.delete(i);
    this.cache.set(i, v);
  }

  private put(i: number, v: T) {
    const old = this.cache.get(i);
    if (old !== undefined) {
      this.cachedBytes -= this.store.bytes(old);
      this.store.release(old);
      this.cache.delete(i);
    }
    this.cache.set(i, v);
    this.cachedBytes += this.store.bytes(v);
    for (const [k, value] of this.cache) {
      if (this.cachedBytes <= this.budget || this.cache.size <= 2) break;
      if (k === i) continue;
      this.cache.delete(k);
      this.cachedBytes -= this.store.bytes(value);
      this.store.release(value);
    }
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== "closed") return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const i = frame.timestamp;
        this.lastOut = Math.max(this.lastOut, i);
        const done = this.store
          .convert(frame)
          .then((v) => {
            if (this.disposed) this.store.release(v);
            else this.put(i, v);
          })
          .catch((e) => {
            this.failure = e instanceof Error ? e : new Error(String(e));
          })
          .finally(() => {
            frame.close();
            this.converting.delete(i);
            this.notify();
          });
        this.converting.set(i, done);
        this.notify();
      },
      error: (e) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
        this.notify();
      },
    });
    return this.decoder;
  }

  private notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private waitForEvent(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      // Never hang on a missed wake-up.
      setTimeout(resolve, 50);
    });
  }

  /** Starts a fresh decode run at the keyframe for presentation index `i`. */
  private restart(i: number) {
    const decoder = this.ensureDecoder();
    if (decoder.state === "configured") decoder.reset();
    decoder.configure(this.video.config);
    this.cursor = this.keyOf[i];
    this.runStart = this.presOf[this.cursor];
    this.lastOut = -1;
    this.ended = false;
  }

  private async fetch(i: number): Promise<T> {
    if (this.disposed) throw new Error("Frame source closed");
    const hit = this.cache.get(i);
    if (hit !== undefined) return hit;
    const pending = this.converting.get(i);
    if (pending) {
      await pending;
      const v = this.cache.get(i);
      if (v !== undefined) return v;
    }
    // Continue the running decode when frame i is still ahead of it in the
    // group being decoded; otherwise jump straight to its keyframe.
    const continuing = this.decoder?.state === "configured" && !this.ended && this.runStart <= i && this.lastOut < i && this.keyOf[i] <= this.cursor;
    if (!continuing) this.restart(i);
    let restarts = 0;
    const decoder = this.decoder!;
    const samples = this.video.samples;
    const ts = this.video.track.timescale;
    for (;;) {
      if (this.failure) throw this.failure;
      const v = this.cache.get(i);
      if (v !== undefined) return v;
      const converting = this.converting.get(i);
      if (converting) {
        await converting;
        continue;
      }
      if (this.ended || restarts > 1) {
        // The decoder never produced this frame (a damaged file): use the nearest earlier one.
        for (let k = i - 1; k >= 0; k--) {
          const near = this.cache.get(k);
          if (near !== undefined) return near;
        }
        throw new Error(`Frame ${i} could not be decoded.`);
      }
      if (this.lastOut > i && !this.converting.size) {
        // Already passed without being kept (evicted, or never output): decode the group again, once.
        this.restart(i);
        restarts++;
        continue;
      }
      if (this.cursor < samples.length && decoder.decodeQueueSize < 6 && this.converting.size < 6) {
        const s = samples[this.cursor];
        decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: this.presOf[this.cursor], duration: Math.max(1, Math.round((s.duration / ts) * 1e6)), data: s.data! }));
        this.cursor++;
        continue;
      }
      if (this.cursor >= samples.length) {
        await decoder.flush().catch((e) => {
          this.failure ??= e instanceof Error ? e : new Error(String(e));
        });
        await Promise.all(this.converting.values());
        this.ended = true;
        continue;
      }
      await this.waitForEvent();
    }
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    for (const v of this.cache.values()) this.store.release(v);
    this.cache.clear();
    this.cachedBytes = 0;
  }
}

// ─── Stores ─────────────────────────────────────────────────────────────────

/** Viewer frames: bitmaps no larger than `maxSide` on their long side. */
export function bitmapStore(maxSide: number): FrameStore<ImageBitmap> {
  return {
    convert: (frame) => {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      return createImageBitmap(frame, { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(h * scale)), resizeQuality: "medium" });
    },
    bytes: (b) => b.width * b.height * 4,
    release: (b) => b.close(),
  };
}

/** An exact CPU copy of a decoded frame's planes (or, for opaque formats, RGBA pixels). */
export type CpuFrame = {
  readonly init: VideoFrameBufferInit;
  readonly data: Uint8Array;
  /** True when the planes are the decoder's own YUV, untouched. */
  readonly exact: boolean;
};

export const cpuStore: FrameStore<CpuFrame> = {
  convert: async (frame) => {
    // copyTo writes the visible area only, tightly packed: that is the stored frame.
    const vis = frame.visibleRect;
    const base = {
      timestamp: 0,
      codedWidth: vis?.width ?? frame.codedWidth,
      codedHeight: vis?.height ?? frame.codedHeight,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      colorSpace: frame.colorSpace?.toJSON(),
    };
    if (frame.format) {
      const data = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(data);
      return { init: { ...base, format: frame.format, layout }, data, exact: true };
    }
    // Opaque (some hardware) frames: go through RGBA.
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(frame, 0, 0);
    const data = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
    return { init: { timestamp: 0, codedWidth: w, codedHeight: h, format: "RGBA" }, data, exact: false };
  },
  bytes: (f) => f.data.byteLength,
  release: () => {},
};

/** A VideoFrame for a stored CPU frame (the caller closes it). */
export const cpuFrame = (f: CpuFrame, timestamp: number, duration?: number) => new VideoFrame(f.data, { ...f.init, timestamp, ...(duration ? { duration } : {}) });
