import { describe, expect, it } from "vitest";
import { AAC_FRAME, encodeAac } from "@/core/video/aac-encoder";
import { decodeAac } from "./fixtures/aac-decoder";

/** Music-like: tones under a moving envelope, a little noise, a click to time by. */
function music(seconds: number) {
  const n = Math.round(48000 * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 5;
  const noise = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / 48000;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t);
    l[i] = env * (0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 660 * t) + 0.08 * Math.sin(2 * Math.PI * 1760 * t)) + 0.01 * noise();
    r[i] = 0.4 * Math.sin(2 * Math.PI * 330 * t) * env + 0.01 * noise();
  }
  for (let i = 36000; i < 36040; i++) l[i] += 0.5;
  return [l, r];
}

function compare(src: Float32Array, out: Float32Array) {
  let lag = 0;
  let best = -Infinity;
  for (let k = -40; k <= 40; k++) {
    let s = 0;
    for (let i = 30000; i < 42000; i++) s += src[i] * out[i + k];
    if (s > best) [best, lag] = [s, k];
  }
  let sd = 0;
  let ss = 0;
  let err = 0;
  for (let i = 2048; i < src.length - 2048; i++) {
    sd += src[i] * out[i];
    ss += src[i] * src[i];
    err += (out[i] - src[i]) ** 2;
  }
  return { lag, gain: sd / ss, snr: 10 * Math.log10(ss / err) };
}

describe("AAC encoder", () => {
  const [l, r] = music(1.5);

  for (const [kbps, snr] of [
    [320, 30],
    [128, 20],
  ] as const)
    it(`decodes at ${kbps} kb/s to the same sound, level and time`, () => {
      const frames = encodeAac(l, r, kbps);
      expect(frames.length).toBe(Math.ceil(l.length / AAC_FRAME));
      const bits = frames.reduce((n, f) => n + f.length * 8, 0);
      expect(bits / ((frames.length * AAC_FRAME) / 48000) / 1000).toBeLessThanOrEqual(kbps);
      // No frame is larger than a decoder's buffer (6144 bits a channel).
      expect(Math.max(...frames.map((f) => f.length * 8))).toBeLessThanOrEqual(2 * 6144);
      const [dl, dr] = decodeAac(frames);
      for (const [src, out] of [
        [l, dl],
        [r, dr],
      ]) {
        const m = compare(src, out);
        expect(m.lag).toBe(0);
        expect(m.gain).toBeGreaterThan(0.98);
        expect(m.gain).toBeLessThan(1.02);
        expect(m.snr).toBeGreaterThan(snr);
      }
    });

  it("codes silence in a few bytes and full-scale sound (escape codes) without error", () => {
    const n = 48000 / 2;
    const quiet = new Float32Array(n);
    const silent = encodeAac(quiet, quiet, 320);
    // The element headers alone: 55 bits.
    expect(Math.max(...silent.map((f) => f.length))).toBe(7);
    // A full-scale square wave at 50 Hz: large low coefficients that need book 11's escapes.
    const loud = Float32Array.from({ length: n }, (_, i) => (Math.floor(i / 480) % 2 ? 1 : -1));
    const [out] = decodeAac(encodeAac(loud, quiet, 320));
    expect(compare(loud, out).snr).toBeGreaterThan(20);
  });
});
