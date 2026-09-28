import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { track } from "@/lib/activity";
import { type Demuxed, demux } from "./demux";
import { outputFrameRate, outputSize, type VideoEdit, videoBitrate } from "./model";
import { VideoRenderer } from "./renderer";

export type ExportProgress = { readonly done: number; readonly total: number; readonly stage: string };

const MICRO = 1e6;

/** The first encoder this browser supports, best compatibility first (H.264 plays everywhere). */
async function chooseEncoder(width: number, height: number, bitrate: number, framerate: number) {
  const area = width * height;
  const avcLevel = area <= 921_600 ? "1f" : area <= 2_228_224 ? "2a" : area <= 8_912_896 ? "33" : "34";
  const candidates: { codec: string; mux: "avc" | "hevc" | "vp9" | "av1"; extra?: Partial<VideoEncoderConfig> }[] = [
    { codec: `avc1.6400${avcLevel}`, mux: "avc", extra: { avc: { format: "avc" } } as Partial<VideoEncoderConfig> },
    { codec: `avc1.4d00${avcLevel}`, mux: "avc", extra: { avc: { format: "avc" } } as Partial<VideoEncoderConfig> },
    { codec: "hvc1.1.6.L123.B0", mux: "hevc", extra: { hevc: { format: "hevc" } } as Partial<VideoEncoderConfig> },
    { codec: "vp09.00.41.08", mux: "vp9" },
    { codec: "av01.0.08M.08", mux: "av1" },
  ];
  for (const c of candidates) {
    const config: VideoEncoderConfig = { codec: c.codec, width, height, bitrate, framerate, latencyMode: "quality", ...c.extra };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { config: support.config ?? config, mux: c.mux };
    } catch {
      // Try the next codec.
    }
  }
  throw new Error("This browser can't encode video. Use a recent Chrome, Edge or Safari.");
}

/**
 * Renders an edited clip to a new MP4: frames are decoded with WebCodecs,
 * re-rendered on the GPU (scale, rotation, effect) and re-encoded; audio
 * packets inside the trim range are copied as they are.
 */
export function exportVideo(file: Blob, edit: VideoEdit, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<Blob> {
  return track(run(file, edit, onProgress, signal));
}

async function run(file: Blob, edit: VideoEdit, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<Blob> {
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
  const bitrate = videoBitrate(edit.output, size.width, size.height, fps);
  const encoder = await chooseEncoder(size.width, size.height, bitrate, fps);
  const audio = edit.output.audio ? media.audio : null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
    video: { codec: encoder.mux, width: size.width, height: size.height },
    ...(audio ? { audio: { codec: audio.codec, numberOfChannels: audio.config.numberOfChannels, sampleRate: audio.config.sampleRate } } : {}),
  });

  const start = edit.trimStart * MICRO;
  const end = edit.trimEnd * MICRO;
  const ts = v.track.timescale;
  const toMicro = (t: number) => (t / ts) * MICRO;
  // Decoding has to begin at the keyframe at or before the trim start.
  let first = 0;
  for (let i = 0; i < v.samples.length; i++) {
    if (v.samples[i].is_sync && toMicro(v.samples[i].cts) <= start) first = i;
    if (toMicro(v.samples[i].dts) > start) break;
  }
  const expected = Math.max(1, Math.round(((end - start) / MICRO) * fps));

  const canvas = new OffscreenCanvas(size.width, size.height);
  const renderer = new VideoRenderer(canvas);
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
    renderer.draw(frame, frame.displayWidth, frame.displayHeight, v.rotation, size.width, size.height, edit);
    frame.close();
    const stamp = Math.max(0, Math.round(t - start));
    const out = new VideoFrame(canvas, { timestamp: stamp, duration: Math.round(minStep || MICRO / v.fps) });
    const keyFrame = stamp - lastKey >= 2 * MICRO;
    if (keyFrame) lastKey = stamp;
    videoEncoder.encode(out, { keyFrame });
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
