import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { chooseEncoder } from "@/core/video/export";
import { drawWatermark, type Watermark } from "./watermark";
import { buildPalette } from "./gif";
import type { GifWorkerRequest, GifWorkerResponse } from "./gif.worker";

/** Renders frame `index` of the loop (straight-alpha pixels at the export size). */
export type FrameSource = (index: number) => ImageData | Promise<ImageData>;
export type FrameProgress = (done: number, total: number, stage: string) => void;

type AnimatedOptions = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly background: string;
  readonly watermark?: Watermark;
  readonly signal: AbortSignal;
  readonly onProgress: FrameProgress;
};

/** Composites rendered frames onto an opaque background (GIF and H.264 have no alpha) and stamps the watermark. */
class Flattener {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly scratch: OffscreenCanvas;
  private readonly stamp: OffscreenCanvas | null;

  constructor(width: number, height: number, private readonly background: string, watermark?: Watermark) {
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    this.scratch = new OffscreenCanvas(1, 1);
    this.stamp = watermark?.enabled ? new OffscreenCanvas(width, height) : null;
    if (this.stamp && watermark) drawWatermark(this.stamp.getContext("2d")!, width, height, watermark);
  }

  draw(pixels: ImageData): OffscreenCanvas {
    if (this.scratch.width !== pixels.width || this.scratch.height !== pixels.height) {
      this.scratch.width = pixels.width;
      this.scratch.height = pixels.height;
    }
    this.scratch.getContext("2d")!.putImageData(pixels, 0, 0);
    const { ctx, canvas } = this;
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.scratch, 0, 0);
    if (this.stamp) ctx.drawImage(this.stamp, 0, 0);
    return canvas;
  }

  pixels(): Uint8ClampedArray {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
  }
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/**
 * Encodes one seamless loop as a GIF. A handful of frames spread over the loop
 * build the shared palette first; then every frame is rendered here (GPU) and
 * mapped/compressed in a worker, a few frames in flight at a time.
 */
export async function encodeGif(render: FrameSource, o: AnimatedOptions & { readonly dither: boolean }): Promise<Blob> {
  const flat = new Flattener(o.width, o.height, o.background, o.watermark);
  const sampleCount = Math.min(o.frames, 8);
  const samples: Uint8ClampedArray[] = [];
  for (let s = 0; s < sampleCount; s++) {
    o.signal.throwIfAborted();
    flat.draw(await render(Math.floor((s * o.frames) / sampleCount)));
    samples.push(flat.pixels());
    o.onProgress(s / sampleCount, o.frames + 1, "Choosing colours…");
    await yieldToUi();
  }
  const palette = buildPalette(samples);
  samples.length = 0;

  const worker = new Worker(new URL("./gif.worker.ts", import.meta.url), { type: "module", name: "gif" });
  try {
    let inFlight = 0;
    let written = 0;
    let settle: (() => void) | null = null;
    let failure: string | null = null;
    let result: ArrayBuffer | null = null;
    worker.onmessage = (e: MessageEvent<GifWorkerResponse>) => {
      const m = e.data;
      if (m.type === "frame-done") {
        inFlight--;
        written++;
        o.onProgress(1 + written, o.frames + 1, `Encoding frame ${written} of ${o.frames}`);
      } else if (m.type === "done") result = m.bytes;
      else failure = m.message;
      settle?.();
    };
    worker.onerror = (e) => {
      failure = e.message || "The GIF encoder stopped.";
      settle?.();
    };
    const wait = () => new Promise<void>((r) => (settle = r));
    const send = (m: GifWorkerRequest, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

    send({ type: "start", width: o.width, height: o.height, palette, fps: o.fps, dither: o.dither });
    for (let i = 0; i < o.frames; i++) {
      o.signal.throwIfAborted();
      while (inFlight >= 3 && !failure) await wait();
      if (failure) throw new Error(failure);
      flat.draw(await render(i));
      const buffer = flat.pixels().buffer as ArrayBuffer;
      inFlight++;
      send({ type: "frame", pixels: buffer }, [buffer]);
      await yieldToUi();
    }
    while (inFlight > 0 && !failure) await wait();
    send({ type: "finish" });
    while (!result && !failure) await wait();
    if (failure) throw new Error(failure);
    return new Blob([result!], { type: "image/gif" });
  } finally {
    worker.terminate();
  }
}

/** Encodes the loop, played `repeats` times, as an H.264 (or VP9/AV1) MP4. */
export async function encodeLoopVideo(render: FrameSource, o: AnimatedOptions & { readonly repeats: number; readonly bitrate: number }): Promise<Blob> {
  if (typeof VideoEncoder === "undefined") throw new Error("MP4 export needs WebCodecs (a recent Chrome, Edge or Safari).");
  // Video encoders want even dimensions; the frame is cropped by at most a pixel.
  const width = o.width - (o.width % 2);
  const height = o.height - (o.height % 2);
  const encoder = await chooseEncoder(width, height, o.bitrate, o.fps);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, fastStart: "in-memory", video: { codec: encoder.mux, width, height, frameRate: o.fps } });
  let failure: unknown = null;
  const video = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = e;
    },
  });
  video.configure(encoder.config);
  const flat = new Flattener(width, height, o.background, o.watermark);
  const total = o.frames * o.repeats;
  const step = 1e6 / o.fps;
  try {
    for (let n = 0; n < total; n++) {
      o.signal.throwIfAborted();
      if (failure) throw failure;
      while (video.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      const canvas = flat.draw(await render(n % o.frames));
      const frame = new VideoFrame(canvas, { timestamp: Math.round(n * step), duration: Math.round(step) });
      video.encode(frame, { keyFrame: n % (o.fps * 2) === 0 });
      frame.close();
      o.onProgress(n + 1, total + 1, `Encoding frame ${n + 1} of ${total}`);
      if (n % 4 === 3) await yieldToUi();
    }
    await video.flush();
    if (failure) throw failure;
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    if (video.state !== "closed") video.close();
  }
}
