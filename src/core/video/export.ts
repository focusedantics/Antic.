import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as MkvTarget, Muxer as MkvMuxer } from "webm-muxer";
import { drawFrameOverlay, type ExportFrame, frameLayout } from "@/core/export/frame";
import { drawWatermark, type Watermark, watermarkFont } from "@/core/export/watermark";
import { loadFonts } from "@/core/text/fonts";
import { track } from "@/lib/activity";
import { type Demuxed, SampleReader } from "./demux";
import { type Channels, SAMPLE_RATE } from "./dsp";
import { chooseEncoder, encodeOptions, type EncoderChoice } from "./encoder";
import { cpuFrame, type CpuFrame, cpuStore, type Frames, openFrames } from "./frames";
import { device } from "@/lib/device";
import type { ClipMedia } from "./media";
import { FORMATS, hasPlainPictures, outputSize, type VideoEdit } from "./model";
import { VideoRenderer } from "./renderer";
import { aacAudioSpecificConfig, aacObjectType } from "./aac";
import { audioParts, decodeClipAudio, Soundtrack } from "./soundtrack";
import { type ClipInfo, compile, frameAt, isUntouched } from "./timeline";
import { i420Frame, rotateI420, visibleI420 } from "./yuv";

export type ExportProgress = { readonly done: number; readonly total: number; readonly stage: string };
export type ExportResult = {
  readonly blob: Blob;
  readonly extension: "mkv" | "mp4";
  readonly frames: number;
  readonly lossless: boolean;
  readonly copied: boolean;
  /** Said to the user with the result: the clip has sound this device couldn't decode, so the file has none. */
  readonly note?: string;
};

const MICRO = 1e6;

/**
 * An MP4 track timescale (ticks per second) in which a frame at `fps` lasts a
 * whole number of ticks. mp4-muxer takes it as `frameRate`, which must be an
 * integer: 30 fps → 30, 29.97 → 2997 (100 ticks a frame), 28.96 → 2896.
 */
export function mp4Timescale(fps: number): number {
  for (const m of [1, 10, 100, 1000]) {
    const t = fps * m;
    if (Math.abs(t - Math.round(t)) < 1e-6 && Math.round(t) > 0) return Math.round(t);
  }
  return 90000;
}

/** VP9 level for a frame size (luma samples per frame). */
function vp9Level(width: number, height: number) {
  const area = width * height;
  const levels: [number, string][] = [
    [36864, "10"],
    [122880, "20"],
    [245760, "21"],
    [552960, "30"],
    [983040, "31"],
    [2228224, "40"],
    [8912896, "50"],
    [35651584, "60"],
  ];
  return levels.find(([max]) => area <= max)?.[1] ?? "62";
}

/**
 * Lossless VP9: profile 0, quantizer 0 on every frame. VP9 at base quantizer
 * index 0 switches to its lossless (Walsh–Hadamard) coding, so decoding gives
 * back exactly the YUV that went in.
 */
export async function losslessEncoder(width: number, height: number, framerate: number): Promise<EncoderChoice | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const config = { codec: `vp09.00.${vp9Level(width, height)}.08`, width, height, framerate, bitrateMode: "quantizer", latencyMode: "quality" } as VideoEncoderConfig;
  try {
    if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, mux: "vp9", quantizer: 0 };
  } catch {
    // Not supported.
  }
  return null;
}

/**
 * Renders an edit to a new file, losing as little as possible:
 *
 * - An MP4 of an untouched clip copies its compressed frames bit for bit.
 * - Lossless formats encode with lossless VP9. Frames shown as they are (no
 *   treatment, effect, watermark or resize) go to the encoder in their own
 *   decoded YUV (rotated exactly when the clip is stored sideways), so they
 *   come back bit-identical; treated frames are rendered on the GPU first.
 * - Every timeline frame is encoded exactly once and the count is checked:
 *   if the encoder returns fewer frames than it was given, the export fails
 *   instead of saving a file with dropped frames.
 */
export function exportEdit(
  own: ClipMedia,
  edit: VideoEdit,
  loadClip: (id: string) => Promise<ClipMedia | null>,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
  watermark?: Watermark,
  frame?: ExportFrame,
): Promise<ExportResult> {
  return track(run(own, edit, loadClip, onProgress, signal, watermark, frame));
}

async function run(
  own: ClipMedia,
  edit: VideoEdit,
  loadClip: (id: string) => Promise<ClipMedia | null>,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
  watermark?: Watermark,
  frame?: ExportFrame,
): Promise<ExportResult> {
  // Video takes solid frames over the picture's edges (stamped like the watermark); glass needs the picture under it.
  const framed = !!frame?.enabled && frame.style !== "glass";
  const stamped = !!watermark?.enabled || framed;
  if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") throw new Error("Video export needs WebCodecs (a recent Chrome, Edge, Firefox or Safari).");
  onProgress({ done: 0, total: 1, stage: "Reading video…" });
  const format = FORMATS.find((f) => f.id === edit.output.format)!;
  const lossless = format.id !== "mp4-h264";

  // Every clip the timeline uses.
  const clips = new Map<string, ClipMedia>([[own.id, own]]);
  for (const s of edit.segments) {
    if (!s.clip || clips.has(s.clip)) continue;
    const m = await loadClip(s.clip);
    if (!m) throw new Error("A clip used on the timeline is missing. Remove its segments and try again.");
    clips.set(s.clip, m);
  }
  const infoOf = (id: string): ClipInfo | undefined => clips.get(id)?.info;
  const fps = own.info.fps;
  const plan = compile(edit, own.id, infoOf, fps);
  if (!plan.frames) throw new Error("The timeline is empty.");
  signal.throwIfAborted();

  const size = outputSize(own.info.width, own.info.height, edit.output.resolution);
  const keepsSize = size.width === own.info.width && size.height === own.info.height;

  // An untouched clip saved as MP4: copy the original frames.
  if (format.extension === "mp4" && keepsSize && !stamped && isUntouched(edit, own.info)) {
    const copied = await copyVideo(own.media, edit.output.audio ? own.media.audio : null);
    if (copied) {
      onProgress({ done: 1, total: 1, stage: "Copying the original frames…" });
      return { blob: copied, extension: "mp4", frames: plan.frames, lossless: true, copied: true };
    }
  }

  const encoder = lossless ? await losslessEncoder(size.width, size.height, fps) : await chooseEncoder(size.width, size.height, Math.min(200e6, size.width * size.height * fps * 0.5), fps, 1);
  if (!encoder) throw new Error("This browser can't encode lossless VP9 video. Use Chrome, Edge or Firefox, or choose the Compatible (H.264) format.");

  // ── Audio ────────────────────────────────────────────────────────────────
  let soundtrack: Channels | null = null;
  let note: string | undefined;
  if (edit.output.audio) {
    onProgress({ done: 0, total: 1, stage: "Rendering the soundtrack…" });
    const engine = new Soundtrack();
    try {
      let any = false;
      for (const [id, m] of clips) {
        const audio = m.media.audio ? await decodeClipAudio(m.media) : null;
        any ||= !!audio;
        engine.setSource(id, audio);
      }
      if (any) soundtrack = await engine.render(audioParts(edit, plan, own.id, infoOf), plan.frames / fps);
    } finally {
      engine.dispose();
    }
    signal.throwIfAborted();
    // Sound the clips have but nothing here could decode: never a quietly silent file.
    if (!soundtrack && [...clips.values()].some((m) => m.media.audio)) note = "The sound couldn't be decoded on this device, so the video was saved without it.";
  }

  // ── Muxer ────────────────────────────────────────────────────────────────
  let audioCodec: { kind: "pcm" } | { kind: "aac" | "opus"; config: AudioEncoderConfig } | null = null;
  if (soundtrack) {
    if (format.extension === "mkv") audioCodec = { kind: "pcm" };
    else {
      for (const c of [
        { kind: "aac" as const, config: { codec: "mp4a.40.2", sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 320_000 } },
        { kind: "opus" as const, config: { codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 510_000 } },
      ]) {
        try {
          if (typeof AudioEncoder !== "undefined" && (await AudioEncoder.isConfigSupported(c.config)).supported) {
            audioCodec = c;
            break;
          }
        } catch {
          // Try the next codec.
        }
      }
      if (!audioCodec) throw new Error("This browser can't encode audio for MP4. Choose the Lossless master (.mkv) format, or turn audio off.");
    }
  }
  const mkvTarget = new MkvTarget();
  const mp4Target = new Mp4Target();
  const mkv =
    format.extension === "mkv"
      ? new MkvMuxer({
          target: mkvTarget,
          type: "matroska",
          firstTimestampBehavior: "offset",
          video: { codec: "V_VP9", width: size.width, height: size.height, frameRate: fps },
          ...(audioCodec ? { audio: { codec: "A_PCM/FLOAT/IEEE", sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitDepth: 32 } } : {}),
        })
      : null;
  const mp4 =
    format.extension === "mp4"
      ? new Mp4Muxer({
          target: mp4Target,
          fastStart: "in-memory",
          firstTimestampBehavior: "offset",
          // The MP4 time base must be a whole number: one that makes every frame duration exact.
          video: { codec: encoder.mux, width: size.width, height: size.height, frameRate: mp4Timescale(fps) },
          ...(audioCodec && audioCodec.kind !== "pcm" ? { audio: { codec: audioCodec.kind, numberOfChannels: 2, sampleRate: SAMPLE_RATE } } : {}),
        })
      : null;

  // ── Video ────────────────────────────────────────────────────────────────
  let failure: unknown = null;
  let chunks = 0;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      chunks++;
      if (mkv) mkv.addVideoChunk(chunk, meta);
      else mp4!.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      failure = e;
    },
  });
  videoEncoder.configure(encoder.config);

  // Decoded frames waiting to be encoded: far less on phones (lib/device), where a 4K frame is 12 MB.
  const budget = (id: string) => (device.lite ? 96 : id === own.id ? 768 : 256) * 1024 * 1024;
  const sources = new Map<string, Promise<Frames<CpuFrame>>>();
  const sourceOf = (id: string) => {
    let s = sources.get(id);
    if (!s) {
      s = openFrames(clips.get(id)!.media.video, cpuStore, budget(id));
      sources.set(id, s);
    }
    return s;
  };
  const canvas = new OffscreenCanvas(size.width, size.height);
  const renderer = new VideoRenderer(canvas);
  if (stamped) {
    const stamp = new OffscreenCanvas(size.width, size.height);
    const sctx = stamp.getContext("2d")!;
    if (framed && frame) drawFrameOverlay(sctx, size.width, size.height, frame);
    if (watermark?.enabled) {
      await loadFonts([watermarkFont(watermark)]);
      // The watermark sits inside the frame's opening.
      const L = frameLayout(size.width, size.height, framed && frame ? { ...frame, style: "solid", placement: "inside" } : null);
      sctx.save();
      sctx.translate(L.inner.x, L.inner.y);
      drawWatermark(sctx, L.inner.w, L.inner.h, watermark);
      sctx.restore();
    }
    renderer.setOverlay(stamp);
  }
  const globalFx = edit.effect && edit.effectMix > 0 ? [{ effect: edit.effect, mix: edit.effectMix }] : [];
  const step = MICRO / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  let exactFrames = 0;
  try {
    for (let k = 0; k < plan.frames; k++) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const ref = frameAt(plan, k, infoOf);
      if (!ref) throw new Error(`Timeline frame ${k} has no picture.`);
      const seg = edit.segments[ref.segment];
      const source = await sourceOf(ref.clip);
      const stored = await source.get(ref.frame);
      const timestamp = Math.round(k * step);
      const duration = Math.round(step);
      let out: VideoFrame | null = null;
      // Shown as it is: hand the decoder's own YUV to the encoder.
      const plain = ref.clip === own.id && hasPlainPictures(seg) && !globalFx.length && !stamped && keepsSize && stored.exact;
      if (plain) {
        const vis = { x: 0, y: 0, width: stored.init.codedWidth, height: stored.init.codedHeight };
        const planes = visibleI420(stored.data, stored.init.format, stored.init.layout ?? [], vis);
        if (planes) {
          const rotated = rotateI420(planes, source.rotation);
          if (rotated.width === size.width && rotated.height === size.height) {
            out = i420Frame(rotated, timestamp, duration, stored.init.colorSpace);
            exactFrames++;
          }
        }
      }
      if (!out) {
        const frame = cpuFrame(stored, 0);
        try {
          renderer.draw(frame, {
            sourceWidth: frame.displayWidth,
            sourceHeight: frame.displayHeight,
            rotation: source.rotation,
            width: size.width,
            height: size.height,
            visual: seg.visual,
            local: ref.local,
            time: k / fps,
            effects: [...(seg.effect && seg.effectMix > 0 ? [{ effect: seg.effect, mix: seg.effectMix }] : []), ...globalFx],
          });
        } finally {
          frame.close();
        }
        out = new VideoFrame(canvas, { timestamp, duration });
      }
      videoEncoder.encode(out, encodeOptions(encoder, k % keyEvery === 0));
      out.close();
      while (videoEncoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      onProgress({ done: k + 1, total: plan.frames, stage: "Rendering frames…" });
    }
    onProgress({ done: plan.frames, total: plan.frames, stage: "Finishing…" });
    await videoEncoder.flush();
    if (failure) throw failure;
    if (chunks !== plan.frames) throw new Error(`The encoder returned ${chunks} of ${plan.frames} frames; nothing was saved. Try again or choose another format.`);

    // ── Audio ──────────────────────────────────────────────────────────────
    if (soundtrack && audioCodec) {
      onProgress({ done: plan.frames, total: plan.frames, stage: "Writing audio…" });
      const block = 4800;
      const [l, r] = [soundtrack[0], soundtrack[1] ?? soundtrack[0]];
      if (audioCodec.kind === "pcm") {
        for (let i = 0; i < l.length; i += block) {
          const n = Math.min(block, l.length - i);
          const interleaved = new Float32Array(n * 2);
          for (let j = 0; j < n; j++) {
            interleaved[j * 2] = l[i + j];
            interleaved[j * 2 + 1] = r[i + j];
          }
          mkv!.addAudioChunkRaw(new Uint8Array(interleaved.buffer), "key", Math.round((i / SAMPLE_RATE) * MICRO));
        }
      } else {
        let audioFailure: unknown = null;
        // AAC: the AudioSpecificConfig is ours, not the encoder's (see aac.ts: Safari's is
        // wrong, and the MP4 it makes plays silent).
        const config = audioCodec.config;
        const objectType = aacObjectType(config.codec);
        const asc = objectType !== null ? aacAudioSpecificConfig(SAMPLE_RATE, 2, objectType) : null;
        const output = (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
          if (asc) meta = { ...meta, decoderConfig: { ...meta?.decoderConfig, codec: config.codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, description: asc } };
          mp4!.addAudioChunk(chunk, meta);
        };
        const audioEncoder = new AudioEncoder({ output, error: (e) => (audioFailure = e) });
        audioEncoder.configure(audioCodec.config);
        for (let i = 0; i < l.length; i += block) {
          const n = Math.min(block, l.length - i);
          const planar = new Float32Array(n * 2);
          planar.set(l.subarray(i, i + n), 0);
          planar.set(r.subarray(i, i + n), n);
          const data = new AudioData({ format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / SAMPLE_RATE) * MICRO), data: planar });
          audioEncoder.encode(data);
          data.close();
          if (audioFailure) throw audioFailure;
        }
        await audioEncoder.flush();
        audioEncoder.close();
        if (audioFailure) throw audioFailure;
      }
    }
    if (mkv) {
      mkv.finalize();
      return { blob: new Blob([mkvTarget.buffer], { type: "video/x-matroska" }), extension: "mkv", frames: chunks, lossless, copied: false, note };
    }
    mp4!.finalize();
    return { blob: new Blob([mp4Target.buffer], { type: "video/mp4" }), extension: "mp4", frames: chunks, lossless: lossless && exactFrames === plan.frames, copied: false, note };
  } finally {
    for (const s of sources.values()) void s.then((x) => x.dispose(), () => {});
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
 * Lossless copy of a whole clip: the original compressed video (and audio)
 * samples go into a new MP4 unchanged. Returns null for codecs the muxer
 * can't write.
 */
export async function copyVideo(media: Demuxed, audio: Demuxed["audio"]): Promise<Blob | null> {
  const v = media.video;
  const mux = COPY_MUX.find(([re]) => re.test(v.config.codec))?.[1];
  // The muxer needs a stated colour description to write VP9/AV1 configuration boxes.
  if (!mux || ((mux === "vp9" || mux === "av1") && !v.colorSpace)) return null;
  const ts = v.track.timescale;
  const pts = (i: number) => (v.samples[i].cts / ts) * MICRO;
  const origin = Math.min(...v.samples.map((_, i) => pts(i)));
  const target = new Mp4Target();
  const muxer = new Mp4Muxer({
    target,
    fastStart: "in-memory",
    // Video decode times start before its first presentation time when it has B-frames; shift both tracks together so they stay in sync.
    firstTimestampBehavior: "cross-track-offset",
    video: { codec: mux, width: v.config.codedWidth!, height: v.config.codedHeight!, ...(v.rotation ? { rotation: v.rotation } : {}) },
    ...(audio ? { audio: { codec: audio.codec, numberOfChannels: audio.config.numberOfChannels, sampleRate: audio.config.sampleRate } } : {}),
  });
  const decoderConfig = { codec: v.config.codec, codedWidth: v.config.codedWidth, codedHeight: v.config.codedHeight, description: v.config.description, ...(v.colorSpace ? { colorSpace: v.colorSpace } : {}) };
  // The samples are read from the file in order; the muxer keeps them, so each is copied out of the read window.
  const reader = new SampleReader(v.file);
  for (let i = 0; i < v.samples.length; i++) {
    const s = v.samples[i];
    const data = (await reader.read(s)).slice();
    muxer.addVideoChunkRaw(data, s.is_sync ? "key" : "delta", Math.max(0, pts(i) - origin), (s.duration / ts) * MICRO, i === 0 ? { decoderConfig } : undefined, ((s.cts - s.dts) / ts) * MICRO);
  }
  if (audio) {
    const ats = audio.track.timescale;
    const audioReader = new SampleReader(audio.file);
    let first = true;
    for (const s of audio.samples) {
      const t = (s.cts / ats) * MICRO;
      if (t < origin) continue;
      muxer.addAudioChunkRaw((await audioReader.read(s)).slice(), "key", t - origin, (s.duration / ats) * MICRO, first ? { decoderConfig: audio.config } : undefined);
      first = false;
    }
  }
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}
