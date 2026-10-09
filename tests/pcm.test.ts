import { describe, expect, it } from "vitest";
import { audible, pcm24 } from "@/core/video/pcm";

describe("24-bit PCM for the lossless MKV", () => {
  it("interleaves left and right as little-endian signed 24-bit samples", () => {
    const bytes = pcm24(new Float32Array([0, 1, -1]), new Float32Array([0.5, -0.5, 2]));
    const sample = (k: number) => {
      const v = bytes[k * 3] | (bytes[k * 3 + 1] << 8) | (bytes[k * 3 + 2] << 16);
      return v & 0x800000 ? v - 0x1000000 : v;
    };
    expect(bytes.length).toBe(3 * 2 * 3);
    // L0 R0 L1 R1 L2 R2; out-of-range values clip.
    expect([0, 1, 2, 3, 4, 5].map(sample)).toEqual([0, 4194304, 8388607, -4194303, -8388607, 8388607]);
  });

  it("tells sound from silence", () => {
    expect(audible([new Float32Array(48000)])).toBe(false);
    const quiet = new Float32Array(48000);
    quiet[30000] = 0.001;
    expect(audible([new Float32Array(10), quiet])).toBe(true);
  });
});
