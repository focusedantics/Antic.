/** Raw sound helpers for video export. */

/** Interleaved little-endian 24-bit PCM of two channels. */
export function pcm24(l: Float32Array, r: Float32Array): Uint8Array {
  const out = new Uint8Array(l.length * 6);
  for (let j = 0, at = 0; j < l.length; j++) {
    for (const v of [l[j], r[j]]) {
      const x = Math.round(Math.max(-1, Math.min(1, v)) * 8388607);
      out[at++] = x & 0xff;
      out[at++] = (x >> 8) & 0xff;
      out[at++] = (x >> 16) & 0xff;
    }
  }
  return out;
}

/** True when the sound has anything to hear (above about −100 dBFS). */
export function audible(channels: readonly Float32Array[]): boolean {
  for (const c of channels) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > 1e-5) return true;
  return false;
}
