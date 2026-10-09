import { PAIR_TABLES, QUAD_A, QUAD_B, WINDOW_X2 } from "./mp3-tables";

/**
 * A small MP3 encoder (MPEG-1 Layer III, 48 kHz stereo, 320 kb/s constant bitrate) for
 * video exports in browsers that have no AAC encoder. MP3 in an MP4 plays everywhere a
 * video is watched, Discord's apps and iPhones included, where Opus and FLAC do not; its
 * patents have expired.
 *
 * Long blocks only, no psychoacoustic model: at 320 kb/s every frame has room to spare,
 * so each granule takes the finest quantizer whose code fits its share of the frame
 * (ISO/IEC 11172-3 for the bitstream; tables in mp3-tables.ts).
 */

export const MP3_FRAME = 1152;
const RATE = 48000;
const KBPS = 320;
/** Bytes of one frame: 144 × bitrate / sample rate (exact at 48 kHz, so never padded). */
const FRAME_BYTES = (144 * KBPS * 1000) / RATE;
const SIDE_BYTES = 32;
const MAIN_BITS = (FRAME_BYTES - 4 - SIDE_BYTES) * 8;

/** Long-block scalefactor band edges at 48 kHz. */
const SFB = [0, 4, 8, 12, 16, 20, 24, 30, 36, 42, 50, 60, 72, 88, 106, 128, 156, 190, 230, 276, 330, 384, 576];

// ─── Filterbank ─────────────────────────────────────────────────────────────

/**
 * Analysis window C[i] = D[i] / 32 (D from the standard synthesis window), with the
 * encoder's overall gain folded in: this filterbank and MDCT give decoded sound 4.5 times
 * the input, measured by decoding (so the window is scaled by 1/4.5).
 */
const C = Float64Array.from(WINDOW_X2, (v) => v / 2 / 65536 / 32 / 4.5);
/** Analysis matrix M[i][k] = cos((2i+1)(k−16)π/64). */
const M = Array.from({ length: 32 }, (_, i) => Float64Array.from({ length: 64 }, (_, k) => Math.cos(((2 * i + 1) * (k - 16) * Math.PI) / 64)));
/** MDCT window and cosines for long blocks (36 in, 18 out). */
const MDCT_WIN = Float64Array.from({ length: 36 }, (_, i) => Math.sin((Math.PI / 36) * (i + 0.5)));
const MDCT_COS = Array.from({ length: 18 }, (_, m) => Float64Array.from({ length: 36 }, (_, i) => Math.cos((Math.PI / 72) * (2 * i + 1 + 18) * (2 * m + 1))));
/** Alias-reduction butterflies. */
const CI = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
const CS = CI.map((c) => 1 / Math.sqrt(1 + c * c));
const CA = CI.map((c) => c / Math.sqrt(1 + c * c));

/** One channel's filterbank state: the 512-sample window and the previous granule per subband. */
class Channel {
  private readonly x = new Float64Array(512);
  private readonly prev = Array.from({ length: 32 }, () => new Float64Array(18));
  private readonly z = new Float64Array(512);
  private readonly y = new Float64Array(64);

  /** 576 new samples → 576 MDCT coefficients (frequency order), alias-reduced. */
  granule(input: Float32Array, from: number): Float64Array {
    const sub = Array.from({ length: 32 }, () => new Float64Array(18));
    for (let t = 0; t < 18; t++) {
      // Shift in 32 samples, newest at x[0].
      this.x.copyWithin(32, 0, 480);
      for (let i = 0; i < 32; i++) this.x[31 - i] = input[from + t * 32 + i] ?? 0;
      for (let i = 0; i < 512; i++) this.z[i] = C[i] * this.x[i];
      for (let k = 0; k < 64; k++) {
        let s = 0;
        for (let j = 0; j < 8; j++) s += this.z[k + 64 * j];
        this.y[k] = s;
      }
      for (let i = 0; i < 32; i++) {
        let s = 0;
        const row = M[i];
        for (let k = 0; k < 64; k++) s += row[k] * this.y[k];
        // Frequency inversion: odd subbands, odd samples.
        sub[i][t] = i & 1 && t & 1 ? -s : s;
      }
    }
    const xr = new Float64Array(576);
    const z = new Float64Array(36);
    for (let sb = 0; sb < 32; sb++) {
      z.set(this.prev[sb], 0);
      z.set(sub[sb], 18);
      this.prev[sb].set(sub[sb]);
      for (let i = 0; i < 36; i++) z[i] *= MDCT_WIN[i];
      for (let m = 0; m < 18; m++) {
        let s = 0;
        const row = MDCT_COS[m];
        for (let i = 0; i < 36; i++) s += row[i] * z[i];
        xr[sb * 18 + m] = s;
      }
    }
    for (let sb = 0; sb < 31; sb++)
      for (let i = 0; i < 8; i++) {
        const u = xr[sb * 18 + 17 - i];
        const d = xr[(sb + 1) * 18 + i];
        xr[sb * 18 + 17 - i] = u * CS[i] + d * CA[i];
        xr[(sb + 1) * 18 + i] = d * CS[i] - u * CA[i];
      }
    return xr;
  }
}

// ─── Quantization and Huffman coding ────────────────────────────────────────

const LINBITS_16 = [1, 2, 3, 4, 6, 8, 10, 13] as const;
const LINBITS_24 = [4, 5, 6, 7, 8, 9, 11, 13] as const;

/** A table choice: the number written, the code table it uses, its linbits. */
type Choice = { table: number; base: number; linbits: number };

const ZERO: Choice = { table: 0, base: 0, linbits: 0 };
/** Tables without linbits, and the largest value each codes. */
const PLAIN: [number, number][] = [
  [1, 1], [2, 2], [3, 2], [5, 3], [6, 3], [7, 5], [8, 5], [9, 5], [10, 7], [11, 7], [12, 7], [13, 15], [15, 15],
];

type Coded = {
  bits: number;
  bigValues: number;
  count1End: number;
  tables: [Choice, Choice, Choice];
  region0: number;
  region1: number;
  quadB: boolean;
};

/**
 * The cheapest layout (region split, a table per region, count1 table) for quantized
 * values `ix`; null if they can't be coded. Costs are summed per scalefactor band once,
 * so every region split is a few additions.
 */
function layout(ix: Int32Array): Coded | null {
  let end = 576;
  while (end > 0 && ix[end - 1] === 0 && ix[end - 2] === 0) end -= 2;
  // count1: quads of 0/1 at the top of the non-zero part.
  let big = end;
  while (big >= 4 && ix[big - 1] <= 1 && ix[big - 2] <= 1 && ix[big - 3] <= 1 && ix[big - 4] <= 1) big -= 4;
  if (big / 2 > 288) return null;
  let quadA = 0;
  let quadB = 0;
  for (let i = big; i < end; i += 4) {
    const q = ix[i] * 8 + ix[i + 1] * 4 + ix[i + 2] * 2 + ix[i + 3];
    const signs = ix[i] + ix[i + 1] + ix[i + 2] + ix[i + 3];
    quadA += QUAD_A[q * 2 + 1] + signs;
    quadB += QUAD_B[q * 2 + 1] + signs;
  }
  // Chunks: scalefactor bands cut at `big`. Per chunk: largest value, and the bits each table takes.
  const edges = [0];
  for (const e of SFB.slice(1)) {
    if (e >= big) break;
    edges.push(e);
  }
  edges.push(big);
  const n = edges.length - 1;
  const max = new Int32Array(n);
  const plain = PLAIN.map(() => new Float64Array(n + 1)); // prefix sums
  const esc = { 16: new Float64Array(n + 1), 24: new Float64Array(n + 1) };
  const escapes = new Float64Array(n + 1);
  for (let c = 0; c < n; c++) {
    let m = 0;
    let signs = 0;
    let escCount = 0;
    for (let i = edges[c]; i < edges[c + 1]; i++) {
      const v = ix[i];
      if (v > m) m = v;
      if (v) signs++;
      if (v >= 15) escCount++;
    }
    max[c] = m;
    PLAIN.forEach(([t, top], k) => {
      let bits = Infinity;
      if (m <= top) {
        const { size, codes } = PAIR_TABLES[t];
        bits = signs;
        for (let i = edges[c]; i < edges[c + 1]; i += 2) bits += codes[(ix[i] * size + ix[i + 1]) * 2 + 1];
      }
      plain[k][c + 1] = plain[k][c] + bits;
    });
    for (const base of [16, 24] as const) {
      const { size, codes } = PAIR_TABLES[base];
      let bits = signs;
      for (let i = edges[c]; i < edges[c + 1]; i += 2) bits += codes[(Math.min(ix[i], 15) * size + Math.min(ix[i + 1], 15)) * 2 + 1];
      esc[base][c + 1] = esc[base][c] + bits;
    }
    escapes[c + 1] = escapes[c] + escCount;
  }
  if (Math.max(0, ...max) > 15 + 8191) return null;
  /** The best table for chunks [a, b), and its bits. */
  const best = (a: number, b: number): { bits: number; choice: Choice } => {
    if (b <= a) return { bits: 0, choice: ZERO };
    let m = 0;
    for (let c = a; c < b; c++) if (max[c] > m) m = max[c];
    if (m === 0) return { bits: 0, choice: ZERO };
    let pick = { bits: Infinity, choice: ZERO };
    if (m <= 15) {
      PLAIN.forEach(([t], k) => {
        const bits = plain[k][b] - plain[k][a];
        if (bits < pick.bits) pick = { bits, choice: { table: t, base: t, linbits: 0 } };
      });
    } else {
      for (const [base, list] of [[16, LINBITS_16], [24, LINBITS_24]] as const) {
        const i = list.findIndex((l) => m - 15 < 2 ** l);
        if (i < 0) continue;
        const bits = esc[base][b] - esc[base][a] + (escapes[b] - escapes[a]) * list[i];
        if (bits < pick.bits) pick = { bits, choice: { table: base + i, base, linbits: list[i] } };
      }
    }
    return pick;
  };
  /** The chunk index where scalefactor band edge `sfb` falls (clamped to the end). */
  const chunkAt = (sfb: number) => {
    const e = SFB[sfb];
    let c = 0;
    while (c < n && edges[c + 1] <= e) c++;
    return c;
  };
  let pick: Coded | null = null;
  for (let r0 = 0; r0 < 16; r0++)
    for (let r1 = 0; r1 < 8; r1++) {
      if (r0 + r1 + 2 > 22) continue;
      const c0 = chunkAt(r0 + 1);
      const c1 = chunkAt(r0 + r1 + 2);
      const a = best(0, c0);
      const b = best(c0, c1);
      const c = best(c1, n);
      const bits = a.bits + b.bits + c.bits + Math.min(quadA, quadB);
      if (!pick || bits < pick.bits) pick = { bits, bigValues: big / 2, count1End: end, tables: [a.choice, b.choice, c.choice], region0: r0, region1: r1, quadB: quadB < quadA };
      if (c1 >= n) break;
    }
  return pick;
}

/** Quantizes with a global gain: |ix| = nint(|xr|^¾ · 2^(−3(gain−210)/16) − 0.0946). */
function quantize(xr: Float64Array, gain: number, ix: Int32Array) {
  const step = 2 ** ((-3 * (gain - 210)) / 16);
  for (let i = 0; i < 576; i++) ix[i] = Math.floor(Math.abs(xr[i]) ** 0.75 * step + 0.4054);
}

type Granule = { coded: Coded; ix: Int32Array; sign: Uint8Array; gain: number };

/** The finest quantizer (lowest gain) whose code fits in `budget` bits. */
function encodeGranule(xr: Float64Array, budget: number): Granule {
  const sign = Uint8Array.from(xr, (v) => (v < 0 ? 1 : 0));
  const ix = new Int32Array(576);
  let lo = 0;
  let hi = 255;
  let found: { coded: Coded; gain: number } | null = null;
  while (lo <= hi) {
    const gain = (lo + hi) >> 1;
    quantize(xr, gain, ix);
    const coded = layout(ix);
    if (coded && coded.bits <= budget) {
      found = { coded, gain };
      hi = gain - 1;
    } else lo = gain + 1;
  }
  if (!found) {
    ix.fill(0);
    found = { coded: layout(ix)!, gain: 255 };
  }
  quantize(xr, found.gain, ix);
  return { coded: found.coded, ix, sign, gain: found.gain };
}

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

function writeGranule(w: Bits, g: Granule) {
  const { ix, sign, coded } = g;
  const big = coded.bigValues * 2;
  const e0 = Math.min(big, SFB[coded.region0 + 1]);
  const e1 = Math.min(big, SFB[coded.region0 + coded.region1 + 2]);
  const regions: [number, number, Choice][] = [
    [0, e0, coded.tables[0]],
    [e0, e1, coded.tables[1]],
    [e1, big, coded.tables[2]],
  ];
  for (const [from, to, c] of regions) {
    if (c.table === 0) continue;
    const { size, codes } = PAIR_TABLES[c.base];
    for (let i = from; i < to; i += 2) {
      const x = ix[i];
      const y = ix[i + 1];
      const k = (Math.min(x, 15) * size + Math.min(y, 15)) * 2;
      w.put(codes[k], codes[k + 1]);
      for (const [v, s] of [
        [x, sign[i]],
        [y, sign[i + 1]],
      ]) {
        if (v >= 15 && c.linbits) w.put(v - 15, c.linbits);
        if (v) w.put(s, 1);
      }
    }
  }
  const quad = coded.quadB ? QUAD_B : QUAD_A;
  for (let i = big; i < coded.count1End; i += 4) {
    const q = ix[i] * 8 + ix[i + 1] * 4 + ix[i + 2] * 2 + ix[i + 3];
    w.put(quad[q * 2], quad[q * 2 + 1]);
    for (let j = 0; j < 4; j++) if (ix[i + j]) w.put(sign[i + j], 1);
  }
}

/**
 * Encodes stereo audio at 48 kHz as MP3 frames of 1152 samples, enough frames to hold all
 * of it. The filterbanks delay the decoded sound by `MP3_DELAY` samples; the encoder reads
 * that far ahead so the sound lines up with the video (losing its first 22 ms).
 */
export function encodeMp3(left: Float32Array, right: Float32Array): Uint8Array[] {
  const channels = [new Channel(), new Channel()];
  const inputs = [left, right];
  const total = left.length;
  const frames: Uint8Array[] = [];
  for (let start = MP3_DELAY; start < total + MP3_DELAY; start += MP3_FRAME) {
    const granules: Granule[][] = [[], []];
    let left = MAIN_BITS;
    let remaining = 4;
    for (let gr = 0; gr < 2; gr++)
      for (let ch = 0; ch < 2; ch++) {
        const xr = channels[ch].granule(window(inputs[ch], start + gr * 576), 0);
        const g = encodeGranule(xr, Math.floor(left / remaining));
        granules[gr][ch] = g;
        left -= g.coded.bits;
        remaining--;
      }
    const w = new Bits(FRAME_BYTES);
    // Header: MPEG-1 Layer III, no CRC, 320 kb/s, 48 kHz, stereo.
    w.put(0xfffb, 16);
    w.put(0b1110, 4);
    w.put(0b01, 2);
    w.put(0, 2);
    w.put(0, 8);
    // Side information: no bit reservoir, no scalefactor sharing.
    w.put(0, 9);
    w.put(0, 3);
    w.put(0, 8);
    for (let gr = 0; gr < 2; gr++)
      for (let ch = 0; ch < 2; ch++) {
        const { coded, gain } = granules[gr][ch];
        w.put(coded.bits, 12); // part2_3_length (no scalefactors)
        w.put(coded.bigValues, 9);
        w.put(gain, 8);
        w.put(0, 4); // scalefac_compress
        w.put(0, 1); // long blocks
        for (const c of coded.tables) w.put(c.table, 5);
        w.put(coded.region0, 4);
        w.put(coded.region1, 3);
        w.put(0, 1); // preflag
        w.put(0, 1); // scalefac_scale
        w.put(coded.quadB ? 1 : 0, 1);
      }
    for (let gr = 0; gr < 2; gr++) for (let ch = 0; ch < 2; ch++) writeGranule(w, granules[gr][ch]);
    frames.push(w.bytes);
  }
  return frames;
}

/** Samples a channel needs from `start` (zeros outside the sound). */
function window(c: Float32Array, start: number): Float32Array {
  const out = new Float32Array(576);
  for (let i = 0; i < 576; i++) {
    const at = start + i;
    if (at >= 0 && at < c.length) out[i] = c[at];
  }
  return out;
}

/**
 * The delay from encoder input to decoder output, in samples: one granule for the
 * overlapped MDCT (576) and 481 for the polyphase filters. Measured by encoding and decoding.
 */
export const MP3_DELAY = 1057;

// ─── MP4 ────────────────────────────────────────────────────────────────────

const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];

/** The `mp4a` sample entry for MP3 (an `esds` with object type 0x6B, MPEG-1 audio). */
export function mp3SampleEntry(): Uint8Array {
  const bitrate = u32(KBPS * 1000);
  const decoderConfig = [0x04, 13, 0x6b, 0x15, 0, (FRAME_BYTES >> 8) & 0xff, FRAME_BYTES & 0xff, ...bitrate, ...bitrate];
  const sl = [0x06, 1, 0x02];
  const es = [0x03, 3 + decoderConfig.length + sl.length, 0, 1, 0, ...decoderConfig, ...sl];
  const esds = box("esds", [0, 0, 0, 0, ...es]);
  return new Uint8Array(
    box("mp4a", [
      0, 0, 0, 0, 0, 0, 0, 1, // reserved, data reference index 1
      0, 0, 0, 0, 0, 0, 0, 0, // reserved
      0, 2, 0, 16, // two channels, 16-bit
      0, 0, 0, 0, // pre-defined, reserved
      ...u32(RATE * 0x10000),
      ...esds,
    ]),
  );
}
