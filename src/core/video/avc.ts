/**
 * H.264 encoder output made fit for MP4. Encoders are asked for the "avc" bitstream (NAL
 * units with length prefixes, parameter sets in the decoder description), but some hand
 * back "annexb" instead (start codes, SPS and PPS inside the frames, no description),
 * and an MP4 muxed from that has no avcC and won't play. This turns such output into
 * the avc form: the description is built from the stream's own SPS and PPS.
 */

/** The NAL units of an Annex B stream (without their start codes), or null if it isn't one. */
export function annexBUnits(data: Uint8Array): Uint8Array[] | null {
  const starts: [number, number][] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push([i, i + 3]);
        i += 2;
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        starts.push([i, i + 4]);
        i += 3;
      }
    }
  }
  if (!starts.length || starts[0][0] !== 0) return null;
  return starts.map(([, from], k) => data.subarray(from, k + 1 < starts.length ? starts[k + 1][0] : data.length)).filter((n) => n.length);
}

/** An AVCDecoderConfigurationRecord (avcC) for one SPS and one PPS. */
export function avcDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profile = sps[1];
  const out = [1, profile, sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps];
  // High profiles add chroma format and bit depths (4:2:0, 8-bit) and no SPS extensions.
  if ([100, 110, 122, 144].includes(profile)) out.push(0xfd, 0xf8, 0xf8, 0);
  return new Uint8Array(out);
}

/** Rewrites encoder chunks in Annex B form as avc samples, with the description they lack. */
export class AvcFixer {
  private description: Uint8Array | null = null;

  /** The sample's bytes and metadata to mux; avc output passes through untouched. */
  fix(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): { data: Uint8Array; meta?: EncodedVideoChunkMetadata } {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const units = meta?.decoderConfig?.description ? null : annexBUnits(data);
    if (!units) return { data, meta };
    const sps = units.find((n) => (n[0] & 0x1f) === 7);
    const pps = units.find((n) => (n[0] & 0x1f) === 8);
    let out = meta;
    if (sps && pps && !this.description) {
      this.description = avcDescription(sps, pps);
      out = { ...meta, decoderConfig: { ...meta?.decoderConfig, codec: meta?.decoderConfig?.codec ?? `avc1.${[...sps.subarray(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`, description: this.description } };
    }
    // Parameter sets live in the description; delimiters aren't needed in MP4.
    const keep = units.filter((n) => ![7, 8, 9].includes(n[0] & 0x1f));
    const sample = new Uint8Array(keep.reduce((s, n) => s + 4 + n.length, 0));
    let at = 0;
    for (const n of keep) {
      new DataView(sample.buffer).setUint32(at, n.length);
      sample.set(n, at + 4);
      at += 4 + n.length;
    }
    return { data: sample, meta: out };
  }
}
