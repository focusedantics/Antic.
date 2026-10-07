import "@fontsource/bebas-neue/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import { animate } from "motion";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { type Assets, type ClipPlan, DURATION, FPS, framesAt, type Image, type Rect, render, SNOW_FRAMES, STILLS } from "./scenes";

/**
 * The trailer player (`npm run dev`, then /trailer/index.html). `?v=vertical` is the
 * 9:16 cut; `?motion=reduced` (or the system's reduced-motion setting) the version without
 * movement; `?motion=full` overrides the system setting. Motion's `animate` drives live
 * playback; `window.trailer.encode()` renders every frame to an MP4 (trailer/render.trailer.ts).
 */

const params = new URLSearchParams(location.search);
const vertical = params.get("v") === "vertical";
const W = vertical ? 1080 : 1920;
const H = vertical ? 1920 : 1080;
const reduced = params.get("motion") === "reduced" || (params.get("motion") !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
const canvas = document.getElementById("stage") as HTMLCanvasElement;
// The film is laid out at 1920 × 1080 (or 1080 × 1920); ?scale=0.6667 renders it smaller (720p).
const scale = Number(params.get("scale") ?? 1);
const PW = Math.round((W * scale) / 2) * 2;
const PH = Math.round((H * scale) / 2) * 2;
canvas.width = PW;
canvas.height = PH;
const g = canvas.getContext("2d", { alpha: false })!;
// Served by the dev server next to this page.
const shots = new URL("shots/", location.href);

const fetchBlob = async (name: string) => {
  const res = await fetch(new URL(name, shots));
  if (!res.ok) throw new Error(`Missing trailer/shots/${name}: run npm run trailer:capture first.`);
  return res.blob();
};

/** The part of an image that isn't transparent. */
function opaqueBox(img: Image): Rect {
  const c = new OffscreenCanvas(img.width, img.height);
  const x = c.getContext("2d")!;
  x.drawImage(img, 0, 0);
  const { data } = x.getImageData(0, 0, img.width, img.height);
  let [x0, y0, x1, y1] = [img.width, img.height, 0, 0];
  for (let y = 0; y < img.height; y++)
    for (let i = 0; i < img.width; i++)
      if (data[(y * img.width + i) * 4 + 3] > 24) {
        x0 = Math.min(x0, i);
        x1 = Math.max(x1, i);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: img.width, h: img.height };
}

/** Moving frames stay encoded until drawn; a few decoded ones are kept. */
function frameSource(names: string[]) {
  const blobs = new Map<number, Promise<Blob>>();
  const decoded = new Map<number, Image>();
  let last: Image | null = null;
  return {
    async prepare(ks: number[]) {
      for (const k of ks) {
        if (decoded.has(k)) continue;
        if (!blobs.has(k)) blobs.set(k, fetchBlob(names[k]));
        decoded.set(k, await createImageBitmap(await blobs.get(k)!));
      }
      // Keep the most recent dozen.
      for (const k of [...decoded.keys()].slice(0, Math.max(0, decoded.size - 12))) {
        decoded.get(k)!.close();
        decoded.delete(k);
      }
    },
    get(k: number): Image {
      const hit = decoded.get(k);
      if (hit) last = hit;
      return (hit ?? last)!;
    },
  };
}

async function loadAssets(): Promise<{ assets: Assets; prepare: (t: number) => Promise<void> }> {
  const plan = JSON.parse(await (await fetchBlob("clip.json")).text()) as ClipPlan;
  const still: Record<string, Image> = {};
  await Promise.all(STILLS.map(async (name) => (still[name] = await createImageBitmap(await fetchBlob(`${name}.png`)))));
  const pad = (k: number) => String(k).padStart(3, "0");
  const snow = frameSource(Array.from({ length: SNOW_FRAMES }, (_, k) => `snow-${pad(k)}.jpg`));
  const clip = frameSource(Array.from({ length: plan.frames }, (_, k) => `clip-${pad(k)}.jpg`));
  await Promise.all([document.fonts.load(`100px "Bebas Neue"`), document.fonts.load(`500 40px Inter`), document.fonts.load(`600 40px Inter`), document.fonts.load(`700 40px Inter`)]);
  const assets: Assets = { still, plan, snow: (k) => snow.get(k), clip: (k) => clip.get(k), balloonBox: opaqueBox(still.balloon) };
  const prepare = async (t: number) => {
    const need = framesAt(t, plan);
    await Promise.all([snow.prepare(need.snow), clip.prepare(need.clip)]);
  };
  return { assets, prepare };
}

const ready = loadAssets();

async function draw(t: number) {
  const { assets, prepare } = await ready;
  await prepare(t);
  g.setTransform(PW / W, 0, 0, PH / H, 0, 0);
  render({ g, W, H, vertical, reduced, t, a: assets });
}

// ─── Live playback ──────────────────────────────────────────────────────────

const play = document.getElementById("play") as HTMLButtonElement;
const seek = document.getElementById("seek") as HTMLInputElement;
const time = document.getElementById("time")!;
document.getElementById("note")!.textContent = `${vertical ? "9:16" : "16:9"}${reduced ? " · reduced motion" : ""} · silent (add music in your editor)`;
let drawing = false;
let pending: number | null = null;
/** Draws the latest requested time; requests that arrive while drawing collapse into one. */
function show(t: number) {
  time.textContent = `${t.toFixed(2)} s`;
  seek.value = String(t);
  if (drawing) {
    pending = t;
    return;
  }
  drawing = true;
  void draw(t).finally(() => {
    drawing = false;
    if (pending !== null) {
      const next = pending;
      pending = null;
      show(next);
    }
  });
}
const playback = animate(0, DURATION, { duration: DURATION, ease: "linear", autoplay: false, onUpdate: show });
play.onclick = () => {
  if (playback.state === "running") {
    playback.pause();
    play.textContent = "Play";
  } else {
    if (playback.time >= DURATION) playback.time = 0;
    playback.play();
    play.textContent = "Pause";
  }
};
seek.oninput = () => {
  playback.pause();
  play.textContent = "Play";
  playback.time = Number(seek.value);
  show(Number(seek.value));
};
window.addEventListener("keydown", (e) => {
  if (e.key === " ") {
    e.preventDefault();
    play.click();
  }
});
// Rendering (?render): no live drawing, the encoder draws every frame itself.
if (params.has("render")) document.body.dataset.render = "";
else void ready.then(() => show(Number(params.get("t") ?? 0)));

// ─── Rendering to a file ────────────────────────────────────────────────────

type H264Wasm = {
  width: number;
  height: number;
  frameRate: number;
  quantizationParameter: number;
  speed: number;
  outputFilename: string;
  initialize(): void;
  addFrameRgba(data: Uint8ClampedArray): void;
  finalize(): void;
  FS: { readFile(name: string): Uint8Array };
  delete(): void;
};

/**
 * Every frame, in order, to an MP4 at 30 fps. H.264 through WebCodecs where the browser
 * has it (Chrome, Edge and Safari do); else a local H.264 WebAssembly encoder when one
 * was loaded (`window.HME`, see trailer/README.md); else VP9. Returns the codec used and
 * downloads the file.
 */
async function encode(name: string, onProgress?: (done: number) => void): Promise<string> {
  await ready;
  const total = Math.round(DURATION * FPS);
  let bytes: Uint8Array;
  let used: string;
  const hme = (window as unknown as { HME?: { createH264MP4Encoder(): Promise<H264Wasm> } }).HME;
  const webcodecs = await pickCodec();
  if (!webcodecs?.startsWith("avc") && hme) {
    const enc = await hme.createH264MP4Encoder();
    // Quantizer 21 by default; ?qp= trades size for quality (higher is smaller).
    Object.assign(enc, { width: PW, height: PH, frameRate: FPS, quantizationParameter: Number(params.get("qp") ?? 21), speed: 2 });
    enc.initialize();
    for (let i = 0; i < total; i++) {
      await draw(i / FPS);
      enc.addFrameRgba(g.getImageData(0, 0, PW, PH).data);
      onProgress?.(i + 1);
    }
    enc.finalize();
    bytes = enc.FS.readFile(enc.outputFilename);
    enc.delete();
    used = "H.264 (WebAssembly)";
  } else {
    if (!webcodecs) throw new Error("This browser can't encode video.");
    const avc = webcodecs.startsWith("avc");
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: avc ? "avc" : "vp9", width: PW, height: PH, frameRate: FPS }, fastStart: "in-memory" });
    let failure: unknown = null;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
    encoder.configure(config(webcodecs));
    for (let i = 0; i < total; i++) {
      await draw(i / FPS);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
      if (failure) throw failure;
      onProgress?.(i + 1);
    }
    await encoder.flush();
    muxer.finalize();
    bytes = new Uint8Array(muxer.target.buffer);
    used = avc ? "H.264" : "VP9";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "video/mp4" }));
  a.download = name;
  a.click();
  return used;
}

const config = (codec: string): VideoEncoderConfig => ({
  codec,
  width: PW,
  height: PH,
  framerate: FPS,
  // 16 Mb/s at 1080p, less for a higher ?qp= or a smaller ?scale=.
  bitrate: Math.round(16_000_000 * scale * scale * 0.8 ** (Number(params.get("qp") ?? 21) - 21)),
  latencyMode: "quality",
  ...(codec.startsWith("avc") ? { avc: { format: "avc" } } : {}),
});

async function pickCodec(): Promise<string | null> {
  for (const codec of ["avc1.640034", "avc1.4d0034", "vp09.00.41.08"])
    if ((await VideoEncoder.isConfigSupported(config(codec)).catch(() => ({ supported: false }))).supported) return codec;
  return null;
}

Object.assign(window, { trailer: { ready, draw, encode, duration: DURATION, fps: FPS, width: PW, height: PH } });
