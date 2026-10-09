/**
 * A small FLAC encoder (lossless audio) for video exports, and the MP4 boxes that carry
 * it. Exports use it where the browser has no AAC encoder: Opus in an MP4 plays in
 * browsers but not in Windows' players, QuickTime or the iPhone, which show the picture
 * and stay silent. FLAC in MP4 plays in all of those, in every browser and in VLC.
 *
 * Fixed blocks of 4096 samples, 16-bit stereo at the export's rate; each channel is
 * coded with the best of FLAC's fixed predictors (orders 0–4) and partitioned Rice
 * codes for the residual (FLAC format, https://www.rfc-editor.org/rfc/rfc9639).
 */

export const FLAC_BLOCK = 4096;
const BITS = 16;

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private bytes = 0;
  private acc = 0;
  private n = 0;

  private grow(extra: number) {
    if (this.bytes + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.bytes + extra));
    next.set(this.buf.subarray(0, this.bytes));
    this.buf = next;
  }

  /** The low `count` bits of `value` (count ≤ 24 at a time). */
  bits(value: number, count: number) {
    if (count > 24) {
      this.bits(Math.floor(value / 0x1000000) & ((1 << (count - 24)) - 1), count - 24);
      this.bits(value & 0xffffff, 24);
      return;
    }
    this.acc = (this.acc << count) | (value & ((1 << count) - 1));
    this.n += count;
    this.grow(4);
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.bytes++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }

  /** `q` zeros, then a one. */
  unary(q: number) {
    while (q >= 24) {
      this.bits(0, 24);
      q -= 24;
    }
    this.bits(1, q + 1);
  }

  /** Pads with zeros to a whole byte. */
  align() {
    if (this.n) this.bits(0, 8 - this.n);
  }

  get length() {
    return this.bytes;
  }

  bytesView() {
    return this.buf.subarray(0, this.bytes);
  }
}

function crc8(data: Uint8Array) {
  let crc = 0;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function crc16(data: Uint8Array) {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The residual of fixed predictor `order` at sample `n` (n ≥ order). */
function residual(x: Int32Array, n: number, order: number) {
  switch (order) {
    case 0:
      return x[n];
    case 1:
      return x[n] - x[n - 1];
    case 2:
      return x[n] - 2 * x[n - 1] + x[n - 2];
    case 3:
      return x[n] - 3 * x[n - 1] + 3 * x[n - 2] - x[n - 3];
    default:
      return x[n] - 4 * x[n - 1] + 6 * x[n - 2] - 4 * x[n - 3] + x[n - 4];
  }
}

const zigzag = (r: number) => (r >= 0 ? r * 2 : -r * 2 - 1);

/** Bits a Rice code with parameter k takes for these (zigzagged) values. */
function riceBits(u: Uint32Array, from: number, to: number, k: number) {
  let bits = 0;
  for (let i = from; i < to; i++) bits += 1 + k + Math.floor(u[i] / 2 ** k);
  return bits;
}

/** The best Rice parameter (0–30) for a run of values, and its cost. */
function bestRice(u: Uint32Array, from: number, to: number) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += u[i];
  const mean = to > from ? sum / (to - from) : 0;
  const guess = mean > 1 ? Math.floor(Math.log2(mean)) : 0;
  let best = { k: 0, bits: Infinity };
  for (let k = Math.max(0, guess - 1); k <= Math.min(30, guess + 1); k++) {
    const bits = riceBits(u, from, to, k);
    if (bits < best.bits) best = { k, bits };
  }
  return best;
}

/** One channel of one block as a FLAC subframe. */
function subframe(w: BitWriter, x: Int32Array) {
  const n = x.length;
  if (x.every((v) => v === x[0])) {
    w.bits(0, 8); // constant
    w.bits(x[0], BITS);
    return;
  }
  // The fixed predictor with the smallest residual.
  let order = 0;
  let least = Infinity;
  for (let o = 0; o <= Math.min(4, n - 1); o++) {
    let sum = 0;
    for (let i = o; i < n; i++) sum += Math.abs(residual(x, i, o));
    if (sum < least) {
      least = sum;
      order = o;
    }
  }
  const u = new Uint32Array(n);
  for (let i = order; i < n; i++) u[i] = zigzag(residual(x, i, order));
  // The partition order (0–6) with the fewest bits; partitions must split the block evenly.
  let plan = { p: 0, ks: [0], bits: Infinity };
  for (let p = 0; p <= 6; p++) {
    const parts = 1 << p;
    if (n % parts || n / parts <= order) break;
    const size = n / parts;
    const ks: number[] = [];
    let bits = 0;
    for (let i = 0; i < parts; i++) {
      const r = bestRice(u, i === 0 ? order : i * size, (i + 1) * size);
      ks.push(r.k);
      bits += r.bits + 5;
    }
    if (bits < plan.bits) plan = { p, ks, bits };
  }
  // Rice parameters above 14 need the 5-bit form (RICE2).
  const wide = plan.ks.some((k) => k > 14);
  w.bits((0x08 | order) << 1, 8); // fixed predictor, no wasted bits
  for (let i = 0; i < order; i++) w.bits(x[i], BITS);
  w.bits(wide ? 1 : 0, 2);
  w.bits(plan.p, 4);
  const size = n >> plan.p;
  plan.ks.forEach((k, part) => {
    w.bits(k, wide ? 5 : 4);
    for (let i = part === 0 ? order : part * size; i < (part + 1) * size; i++) {
      w.unary(Math.floor(u[i] / 2 ** k));
      if (k) w.bits(u[i] % 2 ** k, k);
    }
  });
}

/** Frame number in FLAC's UTF-8-like coding. */
function frameNumber(w: BitWriter, n: number) {
  if (n < 0x80) return w.bits(n, 8);
  const bytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  const lead = (0xff << (8 - bytes)) & 0xff;
  w.bits(lead | Math.floor(n / 2 ** (6 * (bytes - 1))), 8);
  for (let i = bytes - 2; i >= 0; i--) w.bits(0x80 | (Math.floor(n / 2 ** (6 * i)) & 0x3f), 8);
}

const RATE_CODES: Record<number, number> = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

/** Float samples as 16-bit integers. */
function toInt16(c: Float32Array, from: number, n: number) {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(c[from + i] * 32767)));
  return out;
}

export type FlacFrame = { readonly data: Uint8Array; readonly samples: number };

/**
 * Encodes two channels as FLAC frames; `streamInfo` is the 34-byte STREAMINFO block
 * (MD5 left as zeros, which FLAC allows: "not computed").
 */
export function encodeFlac(left: Float32Array, right: Float32Array, sampleRate: number): { frames: FlacFrame[]; streamInfo: Uint8Array } {
  const rateCode = RATE_CODES[sampleRate];
  if (rateCode === undefined) throw new Error(`FLAC export doesn't support ${sampleRate} Hz.`);
  const total = left.length;
  const frames: FlacFrame[] = [];
  let minFrame = Infinity;
  let maxFrame = 0;
  for (let start = 0, index = 0; start < total; start += FLAC_BLOCK, index++) {
    const n = Math.min(FLAC_BLOCK, total - start);
    const w = new BitWriter();
    w.bits(0xfff8, 16); // sync, fixed block size
    w.bits(n === FLAC_BLOCK ? 0b1100 : 0b0111, 4); // 4096, or 16-bit size at the end of the header
    w.bits(rateCode, 4);
    w.bits(0b0001, 4); // two independent channels
    w.bits(0b100, 3); // 16 bits per sample
    w.bits(0, 1);
    frameNumber(w, index);
    if (n !== FLAC_BLOCK) w.bits(n - 1, 16);
    w.bits(crc8(w.bytesView()), 8);
    subframe(w, toInt16(left, start, n));
    subframe(w, toInt16(right, start, n));
    w.align();
    w.bits(crc16(w.bytesView()), 16);
    const data = w.bytesView().slice();
    frames.push({ data, samples: n });
    minFrame = Math.min(minFrame, data.length);
    maxFrame = Math.max(maxFrame, data.length);
  }
  const info = new BitWriter();
  info.bits(FLAC_BLOCK, 16);
  info.bits(FLAC_BLOCK, 16);
  info.bits(frames.length ? minFrame : 0, 24);
  info.bits(maxFrame, 24);
  info.bits(sampleRate, 20);
  info.bits(2 - 1, 3);
  info.bits(BITS - 1, 5);
  info.bits(total, 36);
  for (let i = 0; i < 16; i++) info.bits(0, 8);
  return { frames, streamInfo: info.bytesView().slice() };
}

/** A whole .flac file (for tests and checks): the marker, STREAMINFO, then the frames. */
export function flacFile(frames: readonly FlacFrame[], streamInfo: Uint8Array): Uint8Array {
  const head = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  const out = new Uint8Array(head.length + 34 + frames.reduce((n, f) => n + f.data.length, 0));
  out.set(head);
  out.set(streamInfo, head.length);
  let at = head.length + 34;
  for (const f of frames) {
    out.set(f.data, at);
    at += f.data.length;
  }
  return out;
}

// ─── MP4 ────────────────────────────────────────────────────────────────────

const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];

/** The `fLaC` sample entry (with its `dfLa` box) for an MP4's audio track. */
export function flacSampleEntry(streamInfo: Uint8Array, sampleRate: number, channels = 2): Uint8Array {
  const dfLa = box("dfLa", [0, 0, 0, 0, 0x80, 0, 0, 34, ...streamInfo]); // full box; last block: STREAMINFO
  return new Uint8Array(
    box("fLaC", [
      0, 0, 0, 0, 0, 0, 0, 1, // reserved, data reference index 1
      0, 0, 0, 0, 0, 0, 0, 0, // reserved
      0, channels, 0, BITS, // channel count, sample size
      0, 0, 0, 0, // pre-defined, reserved
      ...u32(Math.min(sampleRate, 0xffff) * 0x10000), // 16.16 sample rate
      ...dfLa,
    ]),
  );
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/**
 * Swaps an MP4's `Opus` sample entry for `fLaC` (the muxer writes FLAC frames into an
 * Opus-shaped track, as it knows no FLAC): rewrites the sample description, the sizes
 * of the boxes around it, and the chunk offsets the size change moves.
 */
export function opusTrackToFlac(mp4: Uint8Array, entry: Uint8Array): Uint8Array {
  const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  const type = (at: number) => String.fromCharCode(mp4[at + 4], mp4[at + 5], mp4[at + 6], mp4[at + 7]);
  // Find the Opus entry and the boxes it sits in.
  let found: { at: number; size: number; parents: number[] } | null = null;
  let moov = -1;
  const walk = (from: number, to: number, parents: number[]) => {
    for (let at = from; at + 8 <= to && !found; ) {
      const size = view.getUint32(at);
      if (size < 8) return;
      const t = type(at);
      if (t === "moov") moov = at;
      if (CONTAINERS.has(t)) walk(at + 8, at + size, [...parents, at]);
      else if (t === "stsd") walk(at + 16, at + size, [...parents, at]);
      else if (t === "Opus") found = { at, size, parents };
      at += size;
    }
  };
  walk(0, mp4.length, []);
  if (!found || moov < 0) throw new Error("The MP4 has no Opus track to turn into FLAC.");
  const { at, size, parents } = found as { at: number; size: number; parents: number[] };
  const delta = entry.length - size;
  const out = new Uint8Array(mp4.length + delta);
  out.set(mp4.subarray(0, at));
  out.set(entry, at);
  out.set(mp4.subarray(at + size), at + entry.length);
  const o = new DataView(out.buffer);
  for (const p of parents) o.setUint32(p, o.getUint32(p) + delta);
  // Media data after the moov moved by delta: shift every chunk offset that points past it.
  const moovEnd = moov + o.getUint32(moov);
  if (delta) {
    const fix = (from: number, to: number) => {
      for (let b = from; b + 8 <= to; ) {
        const s = o.getUint32(b);
        if (s < 8) return;
        const t = String.fromCharCode(out[b + 4], out[b + 5], out[b + 6], out[b + 7]);
        if (CONTAINERS.has(t)) fix(b + 8, b + s);
        else if (t === "stco") {
          const count = o.getUint32(b + 12);
          for (let i = 0; i < count; i++) {
            const p = b + 16 + i * 4;
            const v = o.getUint32(p);
            if (v >= moovEnd - delta) o.setUint32(p, v + delta);
          }
        } else if (t === "co64") {
          const count = o.getUint32(b + 12);
          for (let i = 0; i < count; i++) {
            const p = b + 16 + i * 8;
            const v = Number(o.getBigUint64(p));
            if (v >= moovEnd - delta) o.setBigUint64(p, BigInt(v + delta));
          }
        }
        b += s;
      }
    };
    fix(moov + 8, moovEnd);
  }
  return out;
}
