import type { AudioFx } from "./model";

/**
 * Audio DSP for the video timeline: pure functions over Float32Array
 * channels, deterministic, so the soundtrack you preview is sample for sample
 * the one that is exported. Runs in a worker (soundtrack.worker.ts).
 *
 * Time-stretching uses WSOLA (waveform-similarity overlap-add): fixed-size
 * Hann windows are overlap-added at a steady output hop while the input hop
 * follows the stretch factor; each window's input position is nudged within a
 * small tolerance to the offset whose waveform best continues the previous
 * window, which avoids the phasiness of plain overlap-add. Pitch shifting is a
 * time-stretch followed by resampling. Algorithm after Verhelst & Roelands
 * (1993); written for this project.
 */

export const SAMPLE_RATE = 48000;
export type Channels = Float32Array[];

/** One contiguous play of source audio inside a segment (seconds). */
export type AudioPiece = {
  /** Source range, seconds; `reverse` plays it backwards. Ignored for holds. */
  readonly from: number;
  readonly to: number;
  readonly reverse: boolean;
  /** Playback rate (segment speed); 0 = silent hold. */
  readonly rate: number;
  /** Offset inside the segment and length on the timeline, seconds. */
  readonly offset: number;
  readonly duration: number;
};

export type SegmentAudioJob = {
  readonly clip: string;
  readonly pieces: readonly AudioPiece[];
  readonly duration: number;
  readonly keepPitch: boolean;
  readonly pitch: number;
  readonly volume: number;
  readonly mute: boolean;
  readonly fx: AudioFx;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Linear-interpolated resample: plays `x` at `rate` (2 = twice as fast, an octave up). */
export function resample(x: Float32Array, rate: number, length = Math.max(0, Math.round(x.length / rate))): Float32Array {
  const out = new Float32Array(length);
  if (!x.length) return out;
  const last = x.length - 1;
  for (let i = 0; i < length; i++) {
    const p = i * rate;
    const j = Math.floor(p);
    if (j >= last) {
      out[i] = x[last];
      continue;
    }
    const f = p - j;
    out[i] = x[j] + (x[j + 1] - x[j]) * f;
  }
  return out;
}

const WINDOW = 1536; // 32 ms at 48 kHz: long enough for voices
const HOP = WINDOW / 2;
const TOLERANCE = 480; // ±10 ms search
let hann: Float32Array | null = null;
function window(): Float32Array {
  if (!hann) {
    hann = new Float32Array(WINDOW);
    // Periodic Hann: overlapping at half a window it sums to exactly 1.
    for (let i = 0; i < WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
  }
  return hann;
}

/**
 * WSOLA time-stretch of all channels together (one offset search on the mono
 * mix, applied to every channel so the stereo image stays put). `factor` 2 =
 * twice as long, same pitch.
 */
export function stretch(channels: Channels, factor: number): Channels {
  const length = channels[0]?.length ?? 0;
  const outLength = Math.max(0, Math.round(length * factor));
  if (!length || Math.abs(factor - 1) < 1e-4) return channels.map((c) => resample(c, 1, outLength));
  const w = window();
  const mono = new Float32Array(length);
  for (const c of channels) for (let i = 0; i < length; i++) mono[i] += c[i] / channels.length;
  const out = channels.map(() => new Float32Array(outLength + WINDOW));
  const analysisHop = HOP / factor;
  let previous = 0;
  for (let m = 0; ; m++) {
    const outPos = m * HOP;
    if (outPos >= outLength) break;
    const nominal = Math.round(m * analysisHop);
    let best = nominal;
    if (m > 0) {
      // Where the previous window would naturally continue.
      const natural = previous + HOP;
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - TOLERANCE);
      const hi = Math.min(length - WINDOW, nominal + TOLERANCE);
      for (let d = lo; d <= hi; d += 2) {
        let score = 0;
        for (let i = 0; i < HOP; i += 4) {
          const a = natural + i;
          if (a >= length) break;
          score += mono[a] * mono[d + i];
        }
        if (score > bestScore) {
          bestScore = score;
          best = d;
        }
      }
      if (hi < lo) best = Math.max(0, Math.min(nominal, length - 1));
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < WINDOW; i++) {
        const j = best + i;
        if (j >= length) break;
        dst[outPos + i] += src[j] * w[i];
      }
    }
    previous = best;
  }
  return out.map((c) => c.subarray(0, outLength).slice());
}

/** Pitch shift by `semitones` keeping the length (stretch, then resample back). */
export function pitchShift(channels: Channels, semitones: number): Channels {
  if (!semitones) return channels;
  const ratio = 2 ** (semitones / 12);
  const length = channels[0]?.length ?? 0;
  return stretch(channels, ratio).map((c) => resample(c, ratio, length));
}

/** Short fades at both ends so cuts don't click (1.5 ms; stutters still sound hard-cut). */
function declick(c: Float32Array) {
  const n = Math.min(72, c.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    c[i] *= g;
    c[c.length - 1 - i] *= g;
  }
}

function slice(source: Channels, from: number, to: number, reverse: boolean, sampleRate: number): Channels {
  const a = clamp(Math.round(from * sampleRate), 0, source[0].length);
  const b = clamp(Math.round(to * sampleRate), a, source[0].length);
  return source.map((c) => {
    const s = c.slice(a, b);
    if (reverse) s.reverse();
    return s;
  });
}

// ─── Treatments ─────────────────────────────────────────────────────────────

/** Reads `c` at fractional position `p` (0 outside). */
const at = (c: Float32Array, p: number) => {
  const j = Math.floor(p);
  if (j < 0 || j + 1 >= c.length) return j >= 0 && j < c.length ? c[j] : 0;
  return c[j] + (c[j + 1] - c[j]) * (p - j);
};

/** Pitch wobble: a delay line swept by a 6 Hz sine (wet only). */
export function vibrato(c: Float32Array, depth: number, sampleRate: number): Float32Array {
  const out = new Float32Array(c.length);
  const base = 0.006 * sampleRate;
  const swing = depth * 0.004 * sampleRate;
  const w = (2 * Math.PI * 6) / sampleRate;
  for (let i = 0; i < c.length; i++) out[i] = at(c, i - base - swing * Math.sin(w * i));
  return out;
}

/** Three slowly swept, slightly delayed voices under the dry signal. */
export function chorus(c: Float32Array, mix: number, sampleRate: number, phase = 0): Float32Array {
  const out = new Float32Array(c.length);
  const voices = [
    [0.02, 0.6],
    [0.027, 0.8],
    [0.033, 1.1],
  ];
  for (let i = 0; i < c.length; i++) {
    let wet = 0;
    for (const [delay, rate] of voices) wet += at(c, i - (delay + 0.003 * Math.sin((2 * Math.PI * rate * i) / sampleRate + phase)) * sampleRate);
    out[i] = c[i] * (1 - mix * 0.4) + (wet / voices.length) * mix;
  }
  return out;
}

/** Feedback echo; repeats decay, `time` seconds apart. */
export function echo(c: Float32Array, mix: number, time: number, sampleRate: number): Float32Array {
  const d = Math.max(1, Math.round(time * sampleRate));
  const feedback = 0.3 + 0.4 * mix;
  const line = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) line[i] = (i >= d ? (c[i - d] + line[i - d] * feedback) : 0);
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = c[i] + line[i] * mix;
  return out;
}

/** Small Schroeder/Freeverb-style reverb: four damped combs and two all-passes. */
export function reverb(c: Float32Array, mix: number, sampleRate: number, spread = 0): Float32Array {
  const scale = sampleRate / 44100;
  const combs = [1116, 1188, 1277, 1356].map((n) => Math.round((n + spread) * scale));
  const wet = new Float32Array(c.length);
  for (const n of combs) {
    const buf = new Float32Array(n);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < c.length; i++) {
      const y = buf[idx];
      store = y * 0.8 + store * 0.2;
      buf[idx] = c[i] * 0.015 + store * 0.84;
      idx = (idx + 1) % n;
      wet[i] += y;
    }
  }
  for (const n of [556, 441].map((k) => Math.round((k + spread) * scale))) {
    const buf = new Float32Array(n);
    let idx = 0;
    for (let i = 0; i < c.length; i++) {
      const b = buf[idx];
      const y = -wet[i] + b;
      buf[idx] = wet[i] + b * 0.5;
      idx = (idx + 1) % n;
      wet[i] = y;
    }
  }
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = c[i] * (1 - mix * 0.3) + wet[i] * mix * 3;
  return out;
}

/** Fewer bits and a sample-and-hold rate drop. */
export function bitcrush(c: Float32Array, amount: number): Float32Array {
  const levels = 2 ** Math.round(16 - amount * 13);
  const hold = 1 + Math.round(amount * 15);
  const out = new Float32Array(c.length);
  let v = 0;
  for (let i = 0; i < c.length; i++) {
    if (i % hold === 0) v = Math.round(c[i] * levels) / levels;
    out[i] = v;
  }
  return out;
}

/** "Ear rape": up to +30 dB of gain into a hard clipper. */
export function earrape(c: Float32Array, amount: number): Float32Array {
  const gain = 10 ** ((amount * 30) / 20);
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = clamp(c[i] * gain, -1, 1) * 0.98;
  return out;
}

/** Suspended-fourth harmonizer: the voice plus copies a fourth (+5) and a fifth (+7) up. */
export function sus(channels: Channels, mix: number): Channels {
  const fourth = pitchShift(channels, 5);
  const fifth = pitchShift(channels, 7);
  const norm = 1 / (1 + mix * 1.2);
  return channels.map((c, k) => {
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = (c[i] + (fourth[k][i] + fifth[k][i]) * 0.6 * mix) * norm;
    return out;
  });
}

// ─── Segments ───────────────────────────────────────────────────────────────

/**
 * Renders one segment's audio: its pieces (sliced, reversed, sped up or
 * stretched), pitch shift, then the treatments. `source` is the clip's audio
 * at `sampleRate` (null = silent clip). Length = the segment's timeline length.
 */
export function renderSegment(source: Channels | null, job: SegmentAudioJob, sampleRate = SAMPLE_RATE, channels = 2): Channels {
  const length = Math.max(0, Math.round(job.duration * sampleRate));
  let out: Channels = Array.from({ length: channels }, () => new Float32Array(length));
  if (!source || !source.length || !source[0].length || job.mute || !length) return out;
  const src = Array.from({ length: channels }, (_, k) => source[Math.min(k, source.length - 1)]);
  for (const p of job.pieces) {
    if (p.rate === 0) continue;
    const at0 = Math.round(p.offset * sampleRate);
    const want = Math.round(p.duration * sampleRate);
    let piece = slice(src, p.from, p.to, p.reverse, sampleRate);
    piece = job.keepPitch && p.rate !== 1 ? stretch(piece, 1 / p.rate).map((c) => resample(c, 1, want)) : piece.map((c) => resample(c, p.rate, want));
    for (let k = 0; k < channels; k++) {
      declick(piece[k]);
      out[k].set(piece[k].subarray(0, Math.max(0, Math.min(want, length - at0))), at0);
    }
  }
  const fx = job.fx;
  if (job.pitch) out = pitchShift(out, job.pitch);
  if (fx.sus > 0) out = sus(out, fx.sus);
  if (fx.vibrato > 0) out = out.map((c) => vibrato(c, fx.vibrato, sampleRate));
  if (fx.chorus > 0) out = out.map((c, k) => chorus(c, fx.chorus, sampleRate, k * 1.3));
  if (fx.echo > 0) out = out.map((c) => echo(c, fx.echo, fx.echoTime, sampleRate));
  if (fx.reverb > 0) out = out.map((c, k) => reverb(c, fx.reverb, sampleRate, k * 23));
  if (fx.bitcrush > 0) out = out.map((c) => bitcrush(c, fx.bitcrush));
  if (fx.earrape > 0) out = out.map((c) => earrape(c, fx.earrape));
  if (job.volume) {
    const g = 10 ** (job.volume / 20);
    for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
  }
  return out;
}

/** Sums rendered segments into one soundtrack, clipping to ±1. */
export function mixSoundtrack(parts: readonly { start: number; channels: Channels }[], totalSeconds: number, sampleRate = SAMPLE_RATE, channels = 2): Channels {
  const length = Math.max(0, Math.round(totalSeconds * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  for (const part of parts) {
    const at0 = Math.round(part.start * sampleRate);
    for (let k = 0; k < channels; k++) {
      const c = part.channels[k];
      const dst = out[k];
      const n = Math.min(c.length, length - at0);
      for (let i = 0; i < n; i++) dst[at0 + i] += c[i];
    }
  }
  for (const c of out) for (let i = 0; i < c.length; i++) c[i] = clamp(c[i], -1, 1);
  return out;
}
