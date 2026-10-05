/**
 * AAC's AudioSpecificConfig (ISO 14496-3 §1.6.2.1): the two bytes an MP4's `esds`
 * carries so players know the audio's profile, sample rate and channels.
 *
 * Exports write their own instead of the AudioEncoder's: Safari's AAC encoder reports
 * a wrong one (WebKit bug 302253: it reads as object type 0, 22050 Hz, 0 channels), and
 * an MP4 muxed with it plays silent everywhere, though the audio frames themselves are
 * fine. Everything it says is fixed by the encoder's configuration.
 */
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig for raw AAC frames; `objectType` 2 is AAC-LC ("mp4a.40.2"). */
export function aacAudioSpecificConfig(sampleRate: number, channels: number, objectType = 2): Uint8Array {
  const bits: [number, number][] = [[objectType, 5]];
  const index = RATES.indexOf(sampleRate);
  if (index >= 0) bits.push([index, 4]);
  else bits.push([15, 4], [sampleRate, 24]); // explicit rate
  // Channel configuration, then frameLengthFlag, dependsOnCoreCoder, extensionFlag (all 0).
  bits.push([channels, 4], [0, 3]);
  const total = bits.reduce((n, [, size]) => n + size, 0);
  const out = new Uint8Array(Math.ceil(total / 8));
  let at = 0;
  for (const [value, size] of bits)
    for (let b = size - 1; b >= 0; b--, at++) if ((value >>> b) & 1) out[at >> 3] |= 0x80 >> (at & 7);
  return out;
}

/** The AAC-LC object type of a WebCodecs codec string ("mp4a.40.2" → 2), else null. */
export function aacObjectType(codec: string): number | null {
  const m = /^mp4a\.40\.(\d+)$/.exec(codec);
  return m ? Number(m[1]) : null;
}
