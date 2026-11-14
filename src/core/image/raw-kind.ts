/**
 * The main image of a TIFF-based RAW (DNG and kin): its size, and whether it is "linear raw"
 * (PhotometricInterpretation 34892): pixels already demosaiced to RGB, as iPhone
 * ProRAW and other phones' computational RAWs do. LibRaw can't decode those at half
 * size (that skips demosaicing, and there is none), so a 48-megapixel one takes about
 * a gigabyte inside the decoder: more than iOS lets a web page have.
 *
 * Reads tags only (IFD0, the IFDs chained after it and their SubIFDs), never pixels.
 */
export function rawImageInfo(bytes: Uint8Array): { linear: boolean; width: number; height: number } | null {
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(2) !== 42) return null;
  let best = { width: 0, height: 0, photometric: 0 };
  const seen = new Set<number>();
  const walk = (offset: number, depth: number) => {
    for (let ifd = offset; ifd > 0 && ifd + 2 <= bytes.length && !seen.has(ifd) && depth < 4; ) {
      seen.add(ifd);
      const count = u16(ifd);
      if (ifd + 2 + count * 12 + 4 > bytes.length) return;
      let width = 0;
      let height = 0;
      let photometric = 0;
      const subs: number[] = [];
      for (let i = 0; i < count; i++) {
        const at = ifd + 2 + i * 12;
        const tag = u16(at);
        const type = u16(at + 2);
        const n = u32(at + 4);
        // SHORT or LONG values that fit in the entry.
        const value = type === 3 ? u16(at + 8) : u32(at + 8);
        if (tag === 256) width = value;
        else if (tag === 257) height = value;
        else if (tag === 262) photometric = type === 3 ? u16(at + 8) : value;
        else if (tag === 330) {
          // SubIFDs: one offset in the entry, or a list of LONG offsets elsewhere.
          if (n === 1) subs.push(u32(at + 8));
          else for (let j = 0, list = u32(at + 8); j < n && list + j * 4 + 4 <= bytes.length; j++) subs.push(u32(list + j * 4));
        }
      }
      if (width * height > best.width * best.height) best = { width, height, photometric };
      for (const sub of subs) walk(sub, depth + 1);
      ifd = u32(ifd + 2 + count * 12);
    }
  };
  try {
    walk(u32(4), 0);
  } catch {
    return null;
  }
  return best.width ? { linear: best.photometric === 34892, width: best.width, height: best.height } : null;
}
