import { GIFEncoder, type GifEncoderInstance, type Palette, quantize } from "gifenc";

/**
 * Animated GIF encoding for compositions with animated effects.
 *
 * Every frame shares one global palette, built from frames sampled across the
 * loop, so colours don't shimmer from frame to frame. Frames are mapped to the
 * palette with optional Floyd–Steinberg error diffusion (photos look banded
 * without it). Frames arrive flattened (opaque); GIF's 1-bit transparency is
 * not used. The encoder itself is gifenc (MIT); palette mapping and dithering
 * are ours.
 */

/** Builds a palette of up to 256 colours from opaque RGBA samples (a few frames of the loop). */
export function buildPalette(samples: readonly Uint8ClampedArray[], maxPixels = 400_000): Palette {
  const total = samples.reduce((n, s) => n + s.length / 4, 0);
  const step = Math.max(1, Math.ceil(total / maxPixels));
  const pooled = new Uint8Array(Math.ceil(total / step) * 4 + 4);
  let o = 0;
  let k = 0;
  for (const s of samples) {
    for (let i = 0; i < s.length; i += 4, k++) {
      if (k % step) continue;
      pooled[o] = s[i];
      pooled[o + 1] = s[i + 1];
      pooled[o + 2] = s[i + 2];
      pooled[o + 3] = 255;
      o += 4;
    }
  }
  const palette = quantize(pooled.subarray(0, Math.max(4, o)), 256, { format: "rgb565" });
  return palette.length ? palette : [[0, 0, 0]];
}

/** Nearest palette entry, memoised on a 5-bit-per-channel grid (32 768 cells). */
export class PaletteMatcher {
  private readonly cache = new Int16Array(32768).fill(-1);
  private readonly r: Int32Array;
  private readonly g: Int32Array;
  private readonly b: Int32Array;

  constructor(readonly palette: Palette) {
    this.r = Int32Array.from(palette, (c) => c[0]);
    this.g = Int32Array.from(palette, (c) => c[1]);
    this.b = Int32Array.from(palette, (c) => c[2]);
  }

  nearest(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = this.cache[key];
    if (hit >= 0) return hit;
    // Match the cell centre so every colour in the cell shares one answer.
    const cr = (r & 0xf8) | 4;
    const cg = (g & 0xf8) | 4;
    const cb = (b & 0xf8) | 4;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.r.length; i++) {
      const dr = this.r[i] - cr;
      const dg = this.g[i] - cg;
      const db = this.b[i] - cb;
      // Perceptual-ish weights (green matters most).
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.cache[key] = best;
    return best;
  }
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Maps opaque RGBA pixels to palette indices, with Floyd–Steinberg dithering when `dither` is set. */
export function indexPixels(rgba: Uint8ClampedArray, width: number, height: number, matcher: PaletteMatcher, dither: boolean): Uint8Array {
  const out = new Uint8Array(width * height);
  const { palette } = matcher;
  if (!dither) {
    for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = matcher.nearest(rgba[i], rgba[i + 1], rgba[i + 2]);
    return out;
  }
  // Error rows for the current and next line (3 channels, 1 px padding each side).
  let cur = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  for (let y = 0; y < height; y++) {
    next.fill(0);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const e = (x + 1) * 3;
      const r = clampByte(rgba[i] + cur[e]);
      const g = clampByte(rgba[i + 1] + cur[e + 1]);
      const b = clampByte(rgba[i + 2] + cur[e + 2]);
      const index = matcher.nearest(r, g, b);
      out[y * width + x] = index;
      const c = palette[index];
      const er = r - c[0];
      const eg = g - c[1];
      const eb = b - c[2];
      // 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right.
      cur[e + 3] += er * 0.4375;
      cur[e + 4] += eg * 0.4375;
      cur[e + 5] += eb * 0.4375;
      next[e - 3] += er * 0.1875;
      next[e - 2] += eg * 0.1875;
      next[e - 1] += eb * 0.1875;
      next[e] += er * 0.3125;
      next[e + 1] += eg * 0.3125;
      next[e + 2] += eb * 0.3125;
      next[e + 3] += er * 0.0625;
      next[e + 4] += eg * 0.0625;
      next[e + 5] += eb * 0.0625;
    }
    [cur, next] = [next, cur];
  }
  return out;
}

/**
 * Delay of frame `i` in ms. GIF stores whole centiseconds, so 15 fps can't be
 * 66.7 ms per frame; spreading the rounding (60, 70, 70, …) keeps the loop at
 * its true length.
 */
export const gifDelay = (i: number, fps: number) => (Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)) * 10;

/** Streams frames into a looping GIF that shares `palette`. */
export class GifWriter {
  private readonly encoder: GifEncoderInstance = GIFEncoder();
  private readonly matcher: PaletteMatcher;
  private frames = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    palette: Palette,
    private readonly fps: number,
    private readonly dither: boolean,
  ) {
    this.matcher = new PaletteMatcher(palette);
  }

  add(rgba: Uint8ClampedArray) {
    const index = indexPixels(rgba, this.width, this.height, this.matcher, this.dither);
    const delay = gifDelay(this.frames, this.fps);
    this.encoder.writeFrame(index, this.width, this.height, this.frames === 0 ? { palette: this.matcher.palette, delay, repeat: 0 } : { delay });
    this.frames++;
  }

  finish(): Uint8Array {
    this.encoder.finish();
    return this.encoder.bytes();
  }
}
