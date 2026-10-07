import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { balloon } from "./standin";

/**
 * A stand-in video clip for the trailer when trailer/kit/ has no clip.mp4: the balloon
 * rising over the edited lake while the camera drifts in, 3 s of 1280 × 720 at 30 fps,
 * MP4 encoded here with WebCodecs. Runs in the page; returns base64.
 */
export async function drawStandInClip(backdropUrl: string): Promise<string> {
  const W = 1280;
  const H = 720;
  const FPS = 30;
  const FRAMES = 90;
  const backdrop = await createImageBitmap(await (await fetch(backdropUrl)).blob());
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d")!;
  // H.264 where the browser has it, else VP9 (Chromium without proprietary codecs).
  let chosen: { config: VideoEncoderConfig; mux: "avc" | "vp9" } | null = null;
  for (const [codec, mux] of [["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["vp09.00.41.08", "vp9"]] as const) {
    const config: VideoEncoderConfig = { codec, width: W, height: H, bitrate: 10_000_000, framerate: FPS, ...(mux === "avc" ? { avc: { format: "avc" } } : {}) };
    if ((await VideoEncoder.isConfigSupported(config)).supported) {
      chosen = { config, mux };
      break;
    }
  }
  if (!chosen) throw new Error("This browser can't encode video.");
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: chosen.mux, width: W, height: H }, fastStart: "in-memory" });
  let failure: unknown = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
  encoder.configure(chosen.config);
  const ease = (x: number) => 1 - (1 - x) ** 3;
  for (let i = 0; i < FRAMES; i++) {
    const t = i / (FRAMES - 1);
    // The camera drifts in a little; the balloon rises into the light and sways.
    const zoom = 1 + 0.08 * t;
    const sw = backdrop.width / zoom;
    const sh = sw * (H / W);
    g.drawImage(backdrop, (backdrop.width - sw) * 0.55, (backdrop.height - sh) * 0.5, sw, sh, 0, 0, W, H);
    const k = 0.24 * zoom;
    g.save();
    // The basket's foot: from just below the frame up to the lower third.
    g.translate(W * 0.42 + Math.sin(t * Math.PI * 1.5) * 18, H + 440 - ease(t) * (H * 0.24 + 440));
    g.rotate(Math.sin(t * Math.PI * 2) * 0.025);
    g.scale(k, k);
    balloon(g, 0, -1700, 560);
    g.restore();
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    encoder.encode(frame, { keyFrame: i % 30 === 0 });
    frame.close();
  }
  await encoder.flush();
  if (failure) throw failure;
  muxer.finalize();
  const bytes = new Uint8Array(muxer.target.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
