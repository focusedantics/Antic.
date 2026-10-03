/**
 * Test helper: rewrites an MP4 the way iPhones write .MOV files, with the index
 * (`moov`) after the media data (`mdat`). Chunk offsets (stco) move back by the
 * size of the index, which now follows the data.
 */
export function moovAtEnd(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: { type: string; start: number; size: number }[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = view.getUint32(at);
    boxes.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, size });
    at += size;
  }
  const moov = boxes.find((b) => b.type === "moov")!;
  const others = boxes.filter((b) => b !== moov);
  const index = bytes.slice(moov.start, moov.start + moov.size);
  const iv = new DataView(index.buffer);
  // Every stco box inside the index: version/flags, count, then 32-bit offsets.
  for (let i = 4; i + 4 <= index.length; i++) {
    if (index[i] !== 0x73 || index[i + 1] !== 0x74 || index[i + 2] !== 0x63 || index[i + 3] !== 0x6f) continue;
    const count = iv.getUint32(i + 8);
    for (let k = 0; k < count; k++) iv.setUint32(i + 12 + k * 4, iv.getUint32(i + 12 + k * 4) - moov.size);
  }
  const out = new Uint8Array(bytes.length);
  let at = 0;
  for (const b of others) {
    out.set(bytes.subarray(b.start, b.start + b.size), at);
    at += b.size;
  }
  out.set(index, at);
  return out;
}

/**
 * Test helper: turns an index-at-the-end MP4 (see `moovAtEnd`) into a QuickTime file
 * whose audio is described the way iPhones and QuickTime write AAC: brand `qt  `, a
 * version 1 sound description, and the esds inside a `wave` box rather than directly
 * in the sample entry. The audio samples themselves are untouched (only the index is
 * read in tests). The AudioSpecificConfig is AAC-LC, 48 kHz, stereo: 0x11 0x90.
 */
export function quickTimeAac(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = bytes.slice();
  out.set([0x71, 0x74, 0x20, 0x20], 8); // ftyp major brand "qt  "
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const box = (type: string, body: number[]) => [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
  const asc = [0x11, 0x90];
  const decoderConfig = [0x40, 0x15, 0, 0, 0, ...u32(128000), ...u32(128000), 0x05, asc.length, ...asc];
  const esDescriptor = [0, 0, 0, 0x04, decoderConfig.length, ...decoderConfig, 0x06, 1, 0x02];
  const esds = box("esds", [0, 0, 0, 0, 0x03, esDescriptor.length, ...esDescriptor]);
  const wave = box("wave", [...box("frma", [..."mp4a"].map((c) => c.charCodeAt(0))), ...esds]);
  const entry = box("mp4a", [
    0, 0, 0, 0, 0, 0, ...u16(1), // reserved, data reference index
    ...u16(1), ...u16(0), ...u32(0), // sound description version 1, revision, vendor
    ...u16(2), ...u16(16), ...u16(0xfffe), ...u16(0), ...u32(48000 * 65536), // channels, sample size, compression id, packet size, rate
    ...u32(1024), ...u32(0), ...u32(0), ...u32(2), // v1: samples per packet, bytes per packet / frame / sample
    ...wave,
  ]);
  // Find the Opus entry and every box that contains it (moov > trak > mdia > minf > stbl > stsd).
  const view = new DataView(out.buffer);
  const type = (at: number) => String.fromCharCode(...out.subarray(at + 4, at + 8));
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
  const path: number[] = [];
  const find = (from: number, to: number): number | null => {
    for (let at = from; at < to; ) {
      const size = view.getUint32(at);
      const t = type(at);
      if (t === "stsd") {
        const first = at + 16;
        if (type(first) === "Opus") {
          path.push(at);
          return first;
        }
      } else if (containers.has(t)) {
        path.push(at);
        const found = find(at + 8, at + size);
        if (found !== null) return found;
        path.pop();
      }
      at += size;
    }
    return null;
  };
  const opus = find(0, out.length);
  if (opus === null) throw new Error("No Opus sample entry to replace");
  const oldSize = view.getUint32(opus);
  const delta = entry.length - oldSize;
  for (const at of path) view.setUint32(at, view.getUint32(at) + delta);
  const result = new Uint8Array(out.length + delta);
  result.set(out.subarray(0, opus));
  result.set(entry, opus);
  result.set(out.subarray(opus + oldSize), opus + entry.length);
  return result;
}
