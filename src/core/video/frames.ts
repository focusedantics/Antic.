import { type DemuxedVideo, SampleReader } from "./demux";

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

/** Random-access frames of one clip, whichever way they are decoded. */
export interface Frames<T> {
  readonly frames: number;
  /** Clockwise rotation still to apply to the frames (0 when they come out upright). */
  readonly rotation: 0 | 90 | 180 | 270;
  get(index: number): Promise<T>;
  peek(index: number): T | null;
  prefetch(indices: readonly number[]): void;
  cancelPrefetch(): void;
  dispose(): void;
}

export class FrameSource<T> implements Frames<T> {
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
  /** Samples come from the file on demand (see demux). */
  private readonly reader: SampleReader;

  readonly frames: number;

  constructor(
    private readonly video: DemuxedVideo,
    private readonly store: FrameStore<T>,
    private readonly budget: number,
  ) {
    const samples = video.samples;
    this.reader = new SampleReader(video.file);
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

  get rotation() {
    return this.video.rotation;
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
        const data = await this.reader.read(s);
        if (this.disposed || decoder.state !== "configured") throw new Error("Frame source closed");
        decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: this.presOf[this.cursor], duration: Math.max(1, Math.round((s.duration / ts) * 1e6)), data }));
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

// ─── Fallback: the browser's own video player ──────────────────────────────

/**
 * Frames grabbed from a hidden <video> element, for clips WebCodecs can't
 * decode in this browser but its player can (HEVC from iPhones in some
 * browsers). Each frame is a seek to the middle of its presentation time, so
 * it is slower than WebCodecs and exact only as far as the player's seeking
 * is, but every feature works. The player shows frames upright, so they need
 * no further rotation.
 */
export class ElementFrameSource<T> implements Frames<T> {
  readonly frames: number;
  readonly rotation = 0 as const;
  private readonly times: Float64Array;
  private readonly el: HTMLVideoElement;
  private readonly url: string;
  private readonly cache = new Map<number, T>();
  private cachedBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;

  constructor(
    video: DemuxedVideo,
    private readonly store: FrameStore<T>,
    private readonly budget: number,
  ) {
    const ts = video.track.timescale;
    const cts = video.samples.map((s) => s.cts).sort((a, b) => a - b);
    const first = cts[0] ?? 0;
    const frame = 1 / Math.max(1, video.fps);
    // The middle of each frame's display time, on the player's clock (which starts at the first frame).
    this.times = Float64Array.from(cts, (c) => (c - first) / ts + frame / 2);
    this.frames = cts.length;
    this.url = URL.createObjectURL(video.file);
    this.el = document.createElement("video");
    this.el.muted = true;
    this.el.playsInline = true;
    this.el.preload = "auto";
    this.el.src = this.url;
  }

  peek(index: number): T | null {
    return this.cache.get(this.clamp(index)) ?? null;
  }

  get(index: number): Promise<T> {
    const i = this.clamp(index);
    const hit = this.cache.get(i);
    if (hit !== undefined) return Promise.resolve(hit);
    const run = this.queue.then(() => this.grab(i));
    this.queue = run.catch(() => undefined);
    return run;
  }

  prefetch(indices: readonly number[]) {
    const generation = ++this.generation;
    for (const index of indices) {
      const i = this.clamp(index);
      if (this.cache.has(i)) continue;
      const run = this.queue.then(() => (generation === this.generation && !this.disposed && !this.cache.has(i) ? this.grab(i) : undefined));
      this.queue = run.catch(() => undefined);
    }
  }

  cancelPrefetch() {
    this.generation++;
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.el.removeAttribute("src");
    this.el.load();
    URL.revokeObjectURL(this.url);
    for (const v of this.cache.values()) this.store.release(v);
    this.cache.clear();
  }

  private clamp(i: number) {
    return Math.max(0, Math.min(this.frames - 1, Math.round(i)));
  }

  private event(name: string, ms = 8000) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.el.removeEventListener(name, done);
        this.el.removeEventListener("error", fail);
        resolve();
      };
      const fail = () => {
        clearTimeout(timer);
        this.el.removeEventListener(name, done);
        reject(new Error("The browser's video player could not read this clip."));
      };
      const timer = setTimeout(fail, ms);
      this.el.addEventListener(name, done, { once: true });
      this.el.addEventListener("error", fail, { once: true });
    });
  }

  private async grab(i: number): Promise<T> {
    if (this.disposed) throw new Error("Frame source closed");
    const hit = this.cache.get(i);
    if (hit !== undefined) return hit;
    if (this.el.readyState < 1) await this.event("loadedmetadata");
    const t = Math.min(this.times[i], Math.max(0, (this.el.duration || this.times[i]) - 1e-3));
    if (Math.abs(this.el.currentTime - t) > 1e-4 || this.el.readyState < 2) {
      const seeked = this.event("seeked");
      this.el.currentTime = t;
      await seeked;
    }
    // A bitmap of the frame as the player shows it (upright), wrapped for the store.
    const bitmap = await createImageBitmap(this.el);
    const frame = new VideoFrame(bitmap, { timestamp: i });
    try {
      const value = await this.store.convert(frame);
      if (this.disposed) {
        this.store.release(value);
        throw new Error("Frame source closed");
      }
      this.cache.set(i, value);
      this.cachedBytes += this.store.bytes(value);
      for (const [k, v] of this.cache) {
        if (this.cachedBytes <= this.budget || this.cache.size <= 2) break;
        if (k === i) continue;
        this.cache.delete(k);
        this.cachedBytes -= this.store.bytes(v);
        this.store.release(v);
      }
      return value;
    } finally {
      frame.close();
      bitmap.close();
    }
  }
}

/** How this browser decodes a clip: WebCodecs, its video player, or not at all. */
export type Decoding = "webcodecs" | "element" | null;

const decodings = new WeakMap<DemuxedVideo, Promise<Decoding>>();

/** Whether the browser's video player can show this file (metadata loads and a frame has a size). */
export function elementPlays(file: Blob, ms = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "metadata";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    el.onloadedmetadata = () => done(el.videoWidth > 0);
    el.onerror = () => done(false);
    el.src = url;
  });
}

export function decodingFor(video: DemuxedVideo): Promise<Decoding> {
  let d = decodings.get(video);
  if (!d) {
    d = (async (): Promise<Decoding> => {
      let forced: string | null = null;
      try {
        forced = localStorage.getItem("focused:video-decoder");
      } catch {
        // No override.
      }
      if (forced !== "element" && typeof VideoDecoder !== "undefined") {
        const ok = await VideoDecoder.isConfigSupported(video.config).then((r) => r.supported === true, () => false);
        if (ok) return "webcodecs";
      }
      return (await elementPlays(video.file)) ? "element" : null;
    })();
    decodings.set(video, d);
  }
  return d;
}

/** What to tell someone whose browser can't decode this clip at all. */
export function cannotDecode(codec: string): string {
  if (/^(hvc1|hev1|dvh1|dvhe)/.test(codec))
    return "This video is HEVC (the iPhone camera's “High Efficiency” format), which this browser can't decode. Open Focused in Safari, or in Chrome or Edge on a Mac, on Android, or on Windows with HEVC support. On an iPhone you can also record compatible video: Settings → Camera → Formats → Most Compatible.";
  return `This browser can't decode ${codec} video. Try a recent Safari, Chrome or Edge.`;
}

/** Frames of a clip through WebCodecs when it can, else through the video player. Throws when neither can. */
export async function openFrames<T>(video: DemuxedVideo, store: FrameStore<T>, budget: number): Promise<Frames<T>> {
  const how = await decodingFor(video);
  if (how === "webcodecs") return new FrameSource(video, store, budget);
  if (how === "element") return new ElementFrameSource(video, store, budget);
  throw new Error(cannotDecode(video.config.codec));
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
