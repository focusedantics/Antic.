import { SPECTRAL_BOOKS } from "./aac-tables";
import { Mdct } from "./mdct";

/**
 * A small AAC-LC encoder (48 kHz stereo) for video exports in browsers that have no AAC
 * encoder (Chrome and Firefox on Linux). AAC is the one sound every player takes from an
 * MP4: Discord's apps play neither MP3 nor FLAC from one.
 *
 * Long blocks with the sine window, no psychoacoustic model and no stereo coding: every
 * band shares one quantizer, the finest whose code fits the frame's share of the bitrate,
 * with unused bits carried to later frames. Codebooks are chosen per band and merged into
 * sections by a trellis (ISO/IEC 14496-3 for the bitstream; tables in aac-tables.ts).
 */

export const AAC_FRAME = 1024;
const RATE = 48000;
/** The largest frame a decoder must accept: 6144 bits per channel. */
const MAX_FRAME_BITS = 2 * 6144;

/** Long-window scalefactor band edges at 48 kHz. */
const SWB = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264,
  292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024,
];
const BANDS = SWB.length - 1;

interface Book {
  dim: 2 | 4;
  lav: number;
  signed: boolean;
  codes: Uint32Array;
  lens: Uint8Array;
}
const LAV = [0, 1, 1, 2, 2, 4, 4, 7, 7, 12, 12, 16];
const BOOKS: Book[] = SPECTRAL_BOOKS.map((text, i) => {
  const cb = i + 1;
  const words = text.split(" ");
  return {
    dim: cb <= 4 ? 4 : 2,
    lav: LAV[cb],
    signed: cb <= 2 || cb === 5 || cb === 6,
    codes: Uint32Array.from(words, (w) => parseInt(w, 2)),
    lens: Uint8Array.from(words, (w) => w.length),
  };
});
const book = (cb: number) => BOOKS[cb - 1];

/** Index of a tuple of quantized values in a book; values above 15 escape in book 11. */
function tupleIndex(b: Book, q: Int32Array, at: number): number {
  const mod = b.signed ? 2 * b.lav + 1 : b.lav + 1;
  let idx = 0;
  for (let j = 0; j < b.dim; j++) {
    const v = q[at + j];
    idx = idx * mod + (b.signed ? v + b.lav : Math.min(Math.abs(v), 16));
  }
  return idx;
}

/** Bits of a band coded with book `cb` (Infinity when its values don't fit). */
function bandBits(q: Int32Array, from: number, to: number, cb: number, peak: number): number {
  if (cb === 0) return peak === 0 ? 0 : Infinity;
  const b = book(cb);
  if (peak > b.lav && cb !== 11) return Infinity;
  let bits = 0;
  for (let k = from; k < to; k += b.dim) {
    bits += b.lens[tupleIndex(b, q, k)];
    if (b.signed) continue;
    for (let j = 0; j < b.dim; j++) {
      const v = Math.abs(q[k + j]);
      if (v) bits++;
      if (cb === 11 && v >= 16) bits += 2 * (31 - Math.clz32(v)) - 3;
    }
  }
  return bits;
}

/** The books worth trying for a band whose largest value is `peak`. */
function candidates(peak: number): number[] {
  if (peak === 0) return [0];
  if (peak <= 1) return [1, 2, 3, 4];
  if (peak <= 2) return [3, 4, 5, 6];
  if (peak <= 4) return [5, 6, 7, 8];
  if (peak <= 7) return [7, 8, 9, 10];
  if (peak <= 12) return [9, 10, 11];
  return [11];
}

/** Bits to start a section of `length` bands: the book, then the length in 5-bit steps. */
const sectionBits = (length: number) => 4 + 5 * (Math.floor(length / 31) + 1);

interface Coded {
  q: Int32Array;
  maxSfb: number;
  /** The book of each band below maxSfb. */
  books: Int8Array;
  bits: number;
}

/** Chooses books for one channel's quantized spectrum and counts its bits. */
function code(q: Int32Array): Coded {
  const peaks = new Int32Array(BANDS);
  let maxSfb = 0;
  for (let s = 0; s < BANDS; s++) {
    let p = 0;
    for (let k = SWB[s]; k < SWB[s + 1]; k++) p = Math.max(p, Math.abs(q[k]));
    peaks[s] = p;
    if (p) maxSfb = s + 1;
  }
  // Trellis over bands: the cost of each book so far, where changing book starts a section.
  const SWITCH = sectionBits(1);
  let cost = new Float64Array(12).fill(Infinity);
  const from = Array.from({ length: maxSfb }, () => new Int8Array(12));
  for (let s = 0; s < maxSfb; s++) {
    const next = new Float64Array(12).fill(Infinity);
    let best = 0;
    for (let b = 1; b < 12; b++) if (cost[b] < cost[best]) best = b;
    const tries = peaks[s] === 0 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : candidates(peaks[s]);
    for (const b of tries) {
      // A zero band costs its scalefactor-free nothing in book 0, or zero codewords elsewhere.
      const own = bandBits(q, SWB[s], SWB[s + 1], b, peaks[s]) + (b === 0 ? 0 : 1);
      if (own === Infinity) continue;
      const stay = cost[b];
      const move = s === 0 ? SWITCH : cost[best] + SWITCH;
      next[b] = Math.min(stay, move) + own;
      from[s][b] = stay <= move ? b : s === 0 ? -1 : best;
    }
    cost = next;
  }
  const books = new Int8Array(maxSfb);
  let bits = 0;
  if (maxSfb) {
    let b = 0;
    for (let i = 1; i < 12; i++) if (cost[i] < cost[b]) b = i;
    for (let s = maxSfb - 1; s >= 0; s--) {
      books[s] = b;
      b = from[s][b];
    }
    // Exact count: section headers, a 1-bit scalefactor ("no change") per coded band, spectra.
    for (let s = 0; s < maxSfb; ) {
      let e = s;
      while (e < maxSfb && books[e] === books[s]) e++;
      bits += sectionBits(e - s);
      for (let t = s; t < e; t++) if (books[t]) bits += 1 + bandBits(q, SWB[t], SWB[t + 1], books[t], peaks[t]);
      s = e;
    }
  }
  // global_gain, ics_info, the section data above, then pulse, TNS and gain-control flags.
  return { q, maxSfb, books, bits: bits + 8 + 11 + 3 };
}

/** One channel: its MDCT spectrum raised to 3/4 for quantizing. */
class Channel {
  readonly x = new Float64Array(AAC_FRAME);
  readonly pow = new Float64Array(AAC_FRAME);
  readonly q = new Int32Array(AAC_FRAME);
  peak = 0;

  analyze(mdct: Mdct, input: Float32Array, start: number) {
    const block = new Float64Array(2 * AAC_FRAME);
    for (let n = 0; n < block.length; n++) {
      const at = start + n;
      if (at >= 0 && at < input.length) block[n] = input[at] * WINDOW[n] * SCALE;
    }
    mdct.forward(block, this.x);
    this.peak = 0;
    for (let k = 0; k < AAC_FRAME; k++) {
      this.pow[k] = Math.abs(this.x[k]) ** 0.75;
      this.peak = Math.max(this.peak, this.pow[k]);
    }
  }

  /** Quantizes at scalefactor `gain`: q = ⌊(|x|·2^(−(gain−100)/4))^¾ + 0.4054⌋. */
  quantize(gain: number): Coded {
    const step = 2 ** ((-3 * (gain - 100)) / 16);
    for (let k = 0; k < AAC_FRAME; k++) {
      const v = Math.floor(this.pow[k] * step + 0.4054);
      this.q[k] = this.x[k] < 0 ? -v : v;
    }
    return code(this.q.slice());
  }

  /** The smallest gain whose values stay within the codebooks' range (8191). */
  floor(): number {
    if (this.peak === 0) return 0;
    // (peak·step) + 0.4054 < 8192 ⇔ gain > 100 + (16/3)·log2(peak / 8191.5946).
    return Math.max(0, Math.ceil(100 + (16 / 3) * Math.log2(this.peak / 8191.5946) + 1e-9));
  }
}

/** The sine window over the 2048 samples of a long block. */
const WINDOW = Float64Array.from({ length: 2 * AAC_FRAME }, (_, n) => Math.sin((Math.PI / (2 * AAC_FRAME)) * (n + 0.5)));
/**
 * Samples in [−1, 1] decode to [−1, 1] with the spectrum in 16-bit units and the MDCT's
 * 2/N folded in: 2^16 (measured by decoding).
 */
const SCALE = 65536;

class Bits {
  readonly bytes: Uint8Array;
  pos = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }
  put(value: number, count: number) {
    for (let b = count - 1; b >= 0; b--, this.pos++) if ((value >>> b) & 1) this.bytes[this.pos >> 3] |= 0x80 >> (this.pos & 7);
  }
}

function writeChannel(w: Bits, c: Coded, gain: number) {
  const { q, maxSfb, books } = c;
  w.put(gain, 8);
  // ics_info: reserved bit, ONLY_LONG_SEQUENCE, sine window, max_sfb, no prediction.
  w.put(0, 1);
  w.put(0, 2);
  w.put(0, 1);
  w.put(maxSfb, 6);
  w.put(0, 1);
  for (let s = 0; s < maxSfb; ) {
    let e = s;
    while (e < maxSfb && books[e] === books[s]) e++;
    w.put(books[s], 4);
    let length = e - s;
    for (; length >= 31; length -= 31) w.put(31, 5);
    w.put(length, 5);
    s = e;
  }
  // Every scalefactor equals global_gain: a difference of 0 is the 1-bit code "0".
  for (let s = 0; s < maxSfb; s++) if (books[s]) w.put(0, 1);
  w.put(0, 3); // no pulse data, TNS or gain control
  for (let s = 0; s < maxSfb; s++) {
    const cb = books[s];
    if (!cb) continue;
    const b = book(cb);
    for (let k = SWB[s]; k < SWB[s + 1]; k += b.dim) {
      const idx = tupleIndex(b, q, k);
      w.put(b.codes[idx], b.lens[idx]);
      if (b.signed) continue;
      for (let j = 0; j < b.dim; j++) if (q[k + j]) w.put(q[k + j] < 0 ? 1 : 0, 1);
      if (cb !== 11) continue;
      for (let j = 0; j < 2; j++) {
        const v = Math.abs(q[k + j]);
        if (v < 16) continue;
        const n = 31 - Math.clz32(v) - 4; // 2^(n+4) ≤ v < 2^(n+5)
        w.put((1 << n) - 1, n); // n ones…
        w.put(0, 1); // …then a zero
        w.put(v - (1 << (n + 4)), n + 4);
      }
    }
  }
}

/**
 * Encodes stereo audio at 48 kHz as raw AAC-LC frames of 1024 samples, enough frames to
 * hold all of it. Frame i's block starts at sample 1024·i, so frame i decodes to samples
 * 1024·i to 1024·(i + 1) and the sound lines up with the video without an edit list (the
 * first frame, which has no block before it to overlap, fades in over its 21 ms).
 */
export function encodeAac(left: Float32Array, right: Float32Array, kbps = 192, onProgress?: (done: number, total: number) => void): Uint8Array[] {
  const total = Math.ceil(left.length / AAC_FRAME);
  const average = Math.floor((kbps * 1000 * AAC_FRAME) / RATE);
  // CPE header (element id, tag, no common window) and the END element.
  const OVERHEAD = 3 + 4 + 1 + 3;
  const mdct = new Mdct(2 * AAC_FRAME);
  const channels = [new Channel(), new Channel()];
  const inputs = [left, right];
  const frames: Uint8Array[] = [];
  let reservoir = 0;
  for (let start = 0; start < left.length; start += AAC_FRAME) {
    for (let ch = 0; ch < 2; ch++) channels[ch].analyze(mdct, inputs[ch], start);
    const budget = Math.min(average + reservoir, MAX_FRAME_BITS - 8) - OVERHEAD;
    const fits = (gain: number) => {
      const coded = channels.map((c) => c.quantize(gain));
      return { coded, bits: coded[0].bits + coded[1].bits };
    };
    // The finest gain that fits: bits fall as the gain rises.
    let lo = Math.max(channels[0].floor(), channels[1].floor());
    let hi = 255;
    let found = fits(hi);
    if (lo < hi) {
      const first = fits(lo);
      if (first.bits <= budget) {
        found = first;
        hi = lo;
      }
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const at = fits(mid);
      if (at.bits <= budget) {
        hi = mid;
        found = at;
      } else lo = mid;
    }
    const gain = hi;
    const w = new Bits(MAX_FRAME_BITS / 8 + 8);
    w.put(0b001, 3); // channel pair element
    w.put(0, 4);
    w.put(0, 1); // separate windows per channel
    for (const c of found.coded) writeChannel(w, c, gain);
    w.put(0b111, 3); // END
    const used = found.bits + OVERHEAD;
    const bytes = Math.ceil(w.pos / 8);
    if (w.pos !== used) throw new Error(`AAC frame bit count ${w.pos} ≠ ${used}`);
    reservoir = Math.max(0, Math.min(reservoir + average - bytes * 8, MAX_FRAME_BITS - average));
    frames.push(w.bytes.slice(0, bytes));
    if (onProgress && frames.length % 64 === 0) onProgress(frames.length, total);
  }
  return frames;
}
