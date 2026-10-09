import { SPECTRAL_BOOKS } from "../../src/core/video/aac-tables";

/**
 * A reference AAC-LC decoder for the subset our encoder writes (long blocks, sine window,
 * SCE/CPE without a common window, every scalefactor equal to global_gain, no pulse, TNS or
 * gain control), for tests: this test browser has no AAC decoder. It follows ISO/IEC 14496-3
 * directly (a slow IMDCT, no shortcuts), and decodes at the level faad2 and browsers do.
 */
const SWB = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264,
  292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024,
];
const LAV = [0, 1, 1, 2, 2, 4, 4, 7, 7, 12, 12, 16];
const BOOKS = SPECTRAL_BOOKS.map((text) => new Map(text.split(" ").map((code, index) => [code, index])));

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  bit() {
    if (this.pos >= this.bytes.length * 8) throw new Error("AAC frame ended early");
    const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  read(n: number) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  code(book: Map<string, number>) {
    let s = "";
    while (s.length < 20) {
      s += this.bit();
      const v = book.get(s);
      if (v !== undefined) return v;
    }
    throw new Error("Not a codeword");
  }
}

function channelStream(r: Reader): Float64Array {
  const gain = r.read(8);
  if (r.read(1)) throw new Error("ics_reserved_bit set");
  if (r.read(2) !== 0) throw new Error("Only long blocks are supported");
  if (r.read(1) !== 0) throw new Error("Only the sine window is supported");
  const maxSfb = r.read(6);
  if (r.read(1)) throw new Error("Prediction is not AAC-LC");
  const books: number[] = [];
  while (books.length < maxSfb) {
    const cb = r.read(4);
    let length = 0;
    for (let inc = r.read(5); ; inc = r.read(5)) {
      length += inc;
      if (inc !== 31) break;
    }
    if (!length || books.length + length > maxSfb) throw new Error("Bad section length");
    for (let i = 0; i < length; i++) books.push(cb);
  }
  for (const cb of books) {
    if (cb > 11) throw new Error(`Book ${cb} is not supported`);
    if (cb && r.bit() !== 0) throw new Error("Only unchanged scalefactors are supported");
  }
  if (r.read(3)) throw new Error("Pulse data, TNS and gain control are not supported");
  const spec = new Float64Array(1024);
  books.forEach((cb, s) => {
    if (!cb) return;
    const dim = cb <= 4 ? 4 : 2;
    const lav = LAV[cb];
    const signed = cb <= 2 || cb === 5 || cb === 6;
    const mod = signed ? 2 * lav + 1 : lav + 1;
    const scale = 2 ** ((gain - 100) / 4);
    for (let k = SWB[s]; k < SWB[s + 1]; k += dim) {
      let idx = r.code(BOOKS[cb - 1]);
      const q: number[] = [];
      for (let j = dim - 1; j >= 0; j--, idx = Math.floor(idx / mod)) q[j] = (idx % mod) - (signed ? lav : 0);
      if (!signed) for (let j = 0; j < dim; j++) if (q[j] && r.bit()) q[j] = -q[j];
      if (cb === 11)
        for (let j = 0; j < dim; j++) {
          if (Math.abs(q[j]) !== 16) continue;
          let n = 0;
          while (r.bit()) n++;
          q[j] = Math.sign(q[j]) * (2 ** (n + 4) + r.read(n + 4));
        }
      for (let j = 0; j < dim; j++) spec[k + j] = Math.sign(q[j]) * Math.abs(q[j]) ** (4 / 3) * scale;
    }
  });
  return spec;
}

const N = 2048;
const WINDOW = Float64Array.from({ length: N }, (_, n) => Math.sin((Math.PI / N) * (n + 0.5)));
let COS: Float64Array | null = null;

/** x[n] = (2/N) Σ spec[k] cos(2π/N (n + n0)(k + ½)), windowed (ISO/IEC 14496-3 §4.6.11). */
function imdct(spec: Float64Array): Float64Array {
  COS ??= Float64Array.from({ length: N * 1024 }, (_, i) => Math.cos(((2 * Math.PI) / N) * (Math.floor(i / 1024) + N / 4 + 0.5) * ((i % 1024) + 0.5)));
  const out = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (let k = 0; k < 1024; k++) if (spec[k]) s += spec[k] * COS[n * 1024 + k];
    out[n] = ((2 / N) * s * WINDOW[n]) / 32768;
  }
  return out;
}

/** Decodes raw AAC-LC frames into channels of 1024·frames samples (frame i → samples 1024·i…). */
export function decodeAac(frames: Uint8Array[], channels = 2): Float32Array[] {
  const out = Array.from({ length: channels }, () => new Float32Array(frames.length * 1024));
  const overlap = Array.from({ length: channels }, () => new Float64Array(1024));
  frames.forEach((frame, f) => {
    const r = new Reader(frame);
    const specs: Float64Array[] = [];
    for (let id = r.read(3); id !== 7; id = r.read(3)) {
      r.read(4); // element_instance_tag
      if (id === 0) specs.push(channelStream(r));
      else if (id === 1) {
        if (r.read(1)) throw new Error("Common windows are not supported");
        specs.push(channelStream(r), channelStream(r));
      } else throw new Error(`Element ${id} is not supported`);
    }
    if (specs.length !== channels) throw new Error(`${specs.length} channels in frame ${f}`);
    if (Math.ceil(r.pos / 8) !== frame.length) throw new Error(`Frame ${f} has ${frame.length * 8 - r.pos} bits left over`);
    specs.forEach((spec, c) => {
      const y = imdct(spec);
      for (let n = 0; n < 1024; n++) out[c][f * 1024 + n] = overlap[c][n] + y[n];
      overlap[c] = y.slice(1024);
    });
  });
  return out;
}
