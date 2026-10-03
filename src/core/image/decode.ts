import { decodeHeicImage } from "./heic";

/**
 * Decoding photos no larger than needed. A 48 MP iPhone photo is a 190 MB bitmap;
 * kept at 4096 px it is 50 MB, and at the Library's 2560 px preview size 20 MB.
 *
 * `createImageBitmap` can resize while it decodes. Browsers disagree on whether the
 * requested size applies before or after the EXIF orientation is applied, so only the
 * width is given: the browser then keeps the image's own aspect ratio and the result
 * is never distorted, whichever way round it reads the request. If the result
 * is much smaller than wanted (the request was read against the other side), the
 * other side is tried; if it is larger, it is kept (the caller scales it down further).
 */
export type DecodedImage = {
  readonly bitmap: ImageBitmap;
  /**
   * Full-resolution upright size when the bitmap was decoded smaller; null when the
   * bitmap is the full image.
   */
  readonly full: { readonly width: number; readonly height: number } | null;
};

const decodeOptions = { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "default" } as const;

/**
 * Decodes `blob` upright, with its long side close to `maxSide` when the image is larger.
 * `size` is the image's size in either orientation (stored or upright: from the catalog or
 * the file header); without it, or when the image is not larger, it decodes in full.
 */
export async function decodeAtMost(blob: Blob, heic: boolean, size: { width: number; height: number } | null | undefined, maxSide: number): Promise<DecodedImage> {
  const whole = async (): Promise<DecodedImage> => ({ bitmap: heic ? await decodeHeicImage(blob) : await createImageBitmap(blob, decodeOptions), full: null });
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  const long = Math.max(w, h);
  if (!w || !h || !Number.isFinite(maxSide) || long <= maxSide * 1.05) return whole();
  const scale = maxSide / long;
  let best: ImageBitmap | null = null;
  for (const side of w === h ? [w] : [w, h]) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob, { ...decodeOptions, resizeWidth: Math.max(1, Math.round(side * scale)), resizeQuality: "high" });
    } catch {
      break; // Not decodable this way here (HEIC outside Safari): decode it whole.
    }
    const got = Math.max(bitmap.width, bitmap.height);
    if (got < maxSide * 0.95) {
      bitmap.close(); // Read against the other side: too small.
      continue;
    }
    if (best && Math.max(best.width, best.height) <= got) {
      bitmap.close();
      continue;
    }
    best?.close();
    best = bitmap;
    if (got <= maxSide * 1.05) break;
  }
  if (!best) return whole();
  // The bitmap is upright and undistorted: its shape says which way round the full size is.
  const landscape = best.width >= best.height;
  const full = landscape === w >= h ? { width: w, height: h } : { width: h, height: w };
  // The two must agree in shape; if not, the size we were given is not this image's.
  if (Math.abs(best.width / best.height - full.width / full.height) > 0.02 * (full.width / full.height)) {
    best.close();
    return whole();
  }
  return { bitmap: best, full };
}

/**
 * Size of the stored image from its header (before any EXIF rotation), for JPEG, PNG,
 * WebP and HEIC; null when it can't be read cheaply.
 */
export function headerSize(bytes: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const le16 = (i: number) => bytes[i] | (bytes[i + 1] << 8);
  const le24 = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  if (bytes.length < 32) return null;
  // JPEG: walk the marker segments to the first start-of-frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return ok(u16(i + 7), u16(i + 5));
      if (marker === 0xda) return null;
      i += 2 + u16(i + 2);
    }
    return null;
  }
  // PNG: IHDR is the first chunk.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ok(u32(16), u32(20));
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (u32(0) === 0x52494646 && u32(8) === 0x57454250) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X") return ok(le24(24) + 1, le24(27) + 1);
    if (chunk === "VP8L") {
      const b = bytes.subarray(21, 25);
      return ok(1 + (((b[1] & 0x3f) << 8) | b[0]), 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)));
    }
    if (chunk === "VP8 ") return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    return null;
  }
  // HEIF/AVIF: the largest `ispe` property (tiles and thumbnails have their own, smaller ones).
  if (u32(4) === 0x66747970) {
    const limit = Math.min(bytes.length - 16, 1 << 20);
    let best: { width: number; height: number } | null = null;
    for (let i = 8; i < limit; i++)
      if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
        const size = ok(u32(i + 8), u32(i + 12));
        if (size && (!best || size.width * size.height > best.width * best.height)) best = size;
      }
    return best;
  }
  return null;
}
