import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { track } from "@/lib/activity";
import { type Demuxed, demux } from "./demux";
import { chooseEncoder, encodeOptions } from "./encoder";
import { outputFrameRate, outputSize, type VideoEdit, videoBitrate, videoQuality } from "./model";
import { VideoRenderer } from "./renderer";
import { drawWatermark, type Watermark, watermarkFont } from "@/core/export/watermark";
import { loadFonts } from "@/core/text/fonts";

export type ExportProgress = { readonly done: number; readonly total: number; readonly stage: string };

const MICRO = 1e6;

/**
 * Writes an edited clip to a new MP4, losing as little as possible:
 *
 * - **Copy**: at Maximum quality with nothing to render (no effect, watermark,
 *   resize or frame-rate change) and a trim that starts on a keyframe, the
 *   original compressed frames are copied as they are, bit for bit.
 * - **Passthrough**: with nothing to render otherwise, decoded frames go
 *   straight to the encoder in their native YUV, skipping the RGB round trip
 *   (and its colour rounding) through the GPU.
 * - **Render**: frames are decoded with WebCodecs, re-rendered on the GPU
 *   (scale, rotation, effect, watermark) and re-encoded.
 *
 * Audio packets inside the trim range are always copied as they are.
 */
export function exportVideo(file: Blob, edit: VideoEdit, onProgress: (p: ExportProgress) => void, signal: AbortSignal, watermark?: Watermark): Promise<Blob> {
  return track(run(file, edit, onProgress, signal, watermark));
}

async function run(file: Blob, edit: VideoEdit, onProgress: (p: ExportProgress) => void, signal: AbortSignal, watermark?: Watermark): Promise<Blob> {
  if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") throw new Error("Video export needs WebCodecs (a recent Chrome, Edge or Safari).");
  onProgress({ done: 0, total: 1, stage: "Reading video…" });
  const media: Demuxed = await demux(file);
  signal.throwIfAborted();
  const v = media.video;
  const decodeSupport = await VideoDecoder.isConfigSupported(v.config);
  if (!decodeSupport.supported) throw new Error(`This browser can't decode ${v.config.codec} video.`);

  const rotated = v.rotation === 90 || v.rotation === 270;
  const srcW = v.config.codedWidth!;
  const srcH = v.config.codedHeight!;
  const size = outputSize(rotated ? srcH : srcW, rotated ? srcW : srcH, edit.output.resolution);
  const fps = outputFrameRate(edit.output, v.fps);
  const audio = edit.output.audio ? media.audio : null;
  const start = edit.trimStart * MICRO;
  const end = edit.trimEnd * MICRO;
  const ts = v.track.timescale;
  const toMicro = (t: number) => (t / ts) * MICRO;

  // Nothing to draw: same size, same frame rate, no effect or watermark.
  const plain = !(edit.effect && edit.effectMix > 0) && !watermark?.enabled && size.width === (rotated ? srcH : srcW) && size.height === (rotated ? srcW : srcH) && fps >= v.fps - 0.01;
  if (plain && edit.output.quality === "maximum") {
    const copied = copyVideo(media, audio, start, end);
    if (copied) {
      onProgress({ done: 1, total: 1, stage: "Copying the original frames…" });
      return copied;
    }
  }
  // Passthrough encodes the unrotated decoded frames and flags the rotation in the file, like the original.
  const encW = plain ? srcW : size.width;
  const encH = plain ? srcH : size.height;
  const bitrate = videoBitrate(edit.output, size.width, size.height, fps, v.bitsPerPixel);
  const encoder = await chooseEncoder(encW, encH, bitrate, fps, videoQuality(edit.output));

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
    video: { codec: encoder.mux, width: encW, height: encH, ...(plain && v.rotation ? { rotation: v.rotation } : {}) },
    ...(audio ? { audio: { codec: audio.codec, numberOfChannels: audio.config.numberOfChannels, sampleRate: audio.config.sampleRate } } : {}),
  });
  // Decoding has to begin at the keyframe at or before the trim start.
  let first = 0;
  for (let i = 0; i < v.samples.length; i++) {
    if (v.samples[i].is_sync && toMicro(v.samples[i].cts) <= start) first = i;
    if (toMicro(v.samples[i].dts) > start) break;
  }
  const expected = Math.max(1, Math.round(((end - start) / MICRO) * fps));

  const canvas = new OffscreenCanvas(encW, encH);
  const renderer = new VideoRenderer(canvas);
  if (watermark?.enabled) {
    await loadFonts([watermarkFont(watermark)]);
    const stamp = new OffscreenCanvas(encW, encH);
    drawWatermark(stamp.getContext("2d")!, encW, encH, watermark);
    renderer.setOverlay(stamp);
  }
  let failure: unknown = null;
  let encoded = 0;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = e;
    },
  });
  videoEncoder.configure(encoder.config);

  const frames: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => frames.push(frame),
    error: (e) => {
      failure = e;
    },
  });
  decoder.configure(v.config);

  const minStep = fps < v.fps ? MICRO / fps : 0;
  let nextSlot = start;
  let lastKey = -Infinity;
  const handle = (frame: VideoFrame) => {
    const t = frame.timestamp;
    if (t < start - 1 || t >= end || (minStep && t + 1 < nextSlot)) {
      frame.close();
      return;
    }
    if (minStep) nextSlot = Math.max(nextSlot + minStep, t + minStep * 0.5);
    const stamp = Math.max(0, Math.round(t - start));
    const duration = Math.round(minStep || MICRO / v.fps);
    let out: VideoFrame;
    if (plain && frame.displayWidth === encW && frame.displayHeight === encH) {
      out = new VideoFrame(frame, { timestamp: stamp, duration });
    } else {
      renderer.draw(frame, frame.displayWidth, frame.displayHeight, plain ? 0 : v.rotation, encW, encH, edit, undefined, Math.max(0, t - start) / MICRO);
      out = new VideoFrame(canvas, { timestamp: stamp, duration });
    }
    frame.close();
    const keyFrame = stamp - lastKey >= 2 * MICRO;
    if (keyFrame) lastKey = stamp;
    videoEncoder.encode(out, encodeOptions(encoder, keyFrame));
    out.close();
    encoded++;
    onProgress({ done: encoded, total: expected, stage: "Rendering frames…" });
  };
  const drain = async () => {
    while (frames.length) {
      handle(frames.shift()!);
      // Let the encoder catch up so memory stays bounded.
      while (videoEncoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
    }
  };

  try {
    for (let i = first; i < v.samples.length; i++) {
      const s = v.samples[i];
      if (toMicro(s.dts) > end + MICRO) break;
      signal.throwIfAborted();
      if (failure) throw failure;
      decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: toMicro(s.cts), duration: toMicro(s.duration), data: s.data! }));
      while (decoder.decodeQueueSize > 8 || frames.length > 4) {
        await drain();
        await new Promise((r) => setTimeout(r, 0));
        if (failure) throw failure;
      }
      await drain();
    }
    await decoder.flush();
    await drain();
    if (failure) throw failure;
    signal.throwIfAborted();
    onProgress({ done: expected, total: expected, stage: "Finishing…" });
    await videoEncoder.flush();
    if (failure) throw failure;

    if (audio) {
      const ats = audio.track.timescale;
      let firstAudio = true;
      for (const s of audio.samples) {
        const t = (s.cts / ats) * MICRO;
        if (t < start || t >= end) continue;
        muxer.addAudioChunkRaw(s.data!, "key", t - start, (s.duration / ats) * MICRO, firstAudio ? { decoderConfig: audio.config } : undefined);
        firstAudio = false;
      }
    }
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    for (const f of frames) f.close();
    if (decoder.state !== "closed") decoder.close();
    if (videoEncoder.state !== "closed") videoEncoder.close();
    renderer.dispose();
  }
}

const COPY_MUX: [RegExp, "avc" | "hevc" | "vp9" | "av1"][] = [
  [/^avc[13]\./, "avc"],
  [/^(hvc1|hev1)\./, "hevc"],
  [/^vp09\./, "vp9"],
  [/^av01\./, "av1"],
];

/**
 * Lossless trim: copies the original compressed video (and audio) samples
 * into a new MP4. Only possible when the trim starts on a keyframe (within
 * half a frame); returns null otherwise, or for codecs the muxer can't write.
 */
function copyVideo(media: Demuxed, audio: Demuxed["audio"], start: number, end: number): Blob | null {
  const v = media.video;
  const mux = COPY_MUX.find(([re]) => re.test(v.config.codec))?.[1];
  // The muxer needs a stated colour description to write VP9/AV1 configuration boxes.
  if (!mux || !v.samples.every((s) => s.data) || ((mux === "vp9" || mux === "av1") && !v.colorSpace)) return null;
  const ts = v.track.timescale;
  const pts = (i: number) => (v.samples[i].cts / ts) * MICRO;
  const half = MICRO / v.fps / 2;
  const key = v.samples.findIndex((s, i) => s.is_sync && Math.abs(pts(i) - start) <= half);
  if (key < 0) return null;
  const origin = pts(key);
  // Everything shown before the trim end, plus any frame decoded in between (B-frame references).
  let cut = key;
  for (let i = key; i < v.samples.length; i++) if (pts(i) < end - half) cut = i;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: "in-memory",
    // Video decode times start before its first presentation time when it has B-frames; shift both tracks together so they stay in sync.
    firstTimestampBehavior: "cross-track-offset",
    video: { codec: mux, width: v.config.codedWidth!, height: v.config.codedHeight!, ...(v.rotation ? { rotation: v.rotation } : {}) },
    ...(audio ? { audio: { codec: audio.codec, numberOfChannels: audio.config.numberOfChannels, sampleRate: audio.config.sampleRate } } : {}),
  });
  let first = true;
  for (let i = key; i <= cut; i++) {
    const s = v.samples[i];
    const t = pts(i) - origin;
    if (t < 0) continue; // leading frames of an open GOP belong before the keyframe
    const decoderConfig = { codec: v.config.codec, codedWidth: v.config.codedWidth, codedHeight: v.config.codedHeight, description: v.config.description, ...(v.colorSpace ? { colorSpace: v.colorSpace } : {}) };
    muxer.addVideoChunkRaw(s.data!, s.is_sync ? "key" : "delta", t, (s.duration / ts) * MICRO, first ? { decoderConfig } : undefined, ((s.cts - s.dts) / ts) * MICRO);
    first = false;
  }
  if (audio) {
    const ats = audio.track.timescale;
    let firstAudio = true;
    for (const s of audio.samples) {
      const t = (s.cts / ats) * MICRO;
      if (t < origin || t >= end) continue;
      muxer.addAudioChunkRaw(s.data!, "key", t - origin, (s.duration / ats) * MICRO, firstAudio ? { decoderConfig: audio.config } : undefined);
      firstAudio = false;
    }
  }
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}
