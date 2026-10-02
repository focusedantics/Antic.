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
