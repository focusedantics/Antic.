/**
 * Finds the largest JPEG embedded in a camera RAW (or any container) without a
 * RAW decoder. Nearly every format stores one: ARW/NEF/CR2/DNG/PEF in TIFF IFDs,
 * CR3 in its PRVW box, RAF in its header, RW2 as JpgFromRaw. Scanning for JPEG
 * start-of-image markers and walking segments to the end-of-image marker is
 * format-agnostic and fast (tens of ms on a 60 MB file).
 *
 * This is what lets the Library show a photograph immediately, while the real
 * RAW development happens later, in Develop.
 */
export type EmbeddedJpeg = { offset: number; length: number; width: number; height: number };

function readSize(bytes: Uint8Array, start: number, limit: number): EmbeddedJpeg | null {
  // Walk marker segments from after SOI until SOF gives the size and SOS starts the scan.
  let i = start + 2;
  let width = 0;
  let height = 0;
  while (i + 4 <= limit) {
    if (bytes[i] !== 0xff) return null;
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < limit) {
      i++;
      marker = bytes[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && i + 9 < limit) {
      height = (bytes[i + 5] << 8) | bytes[i + 6];
      width = (bytes[i + 7] << 8) | bytes[i + 8];
      // Lossless JPEG (SOF3) is how many RAWs store sensor data; that is not a preview.
      if (marker === 0xc3) return null;
    }
    if (marker === 0xda) {
      if (!width || !height) return null;
      // Find EOI after the entropy-coded scan (0xFF followed by 0xD9, not stuffed 0xFF00).
      let j = i + 2 + length;
      while (j + 1 < limit) {
        if (bytes[j] === 0xff) {
          const next = bytes[j + 1];
          if (next === 0xd9) return { offset: start, length: j + 2 - start, width, height };
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            j += 2;
            continue;
          }
          // Another marker between scans (progressive JPEGs): skip its segment.
          if (next !== 0xff && j + 3 < limit) {
            const segment = (bytes[j + 2] << 8) | bytes[j + 3];
            j += 2 + segment;
            continue;
          }
        }
        j++;
      }
      return null;
    }
    i += 2 + length;
  }
  return null;
}

export function findEmbeddedJpegs(bytes: Uint8Array): EmbeddedJpeg[] {
  const found: EmbeddedJpeg[] = [];
  const limit = bytes.length;
  let i = 0;
  while (i + 3 < limit) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      const jpeg = readSize(bytes, i, limit);
      if (jpeg && jpeg.width >= 64 && jpeg.height >= 64) {
        found.push(jpeg);
        i += jpeg.length;
        continue;
      }
    }
    i++;
  }
  return found;
}

/** The largest embedded JPEG by pixel count, or null. */
export function largestEmbeddedJpeg(bytes: Uint8Array): EmbeddedJpeg | null {
  let best: EmbeddedJpeg | null = null;
  for (const j of findEmbeddedJpegs(bytes)) {
    if (!best || j.width * j.height > best.width * best.height) best = j;
  }
  return best;
}
