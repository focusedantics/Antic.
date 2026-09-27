/** Canvas helpers that work on OffscreenCanvas, in workers and on the main thread. */

export type Orientable = ImageBitmap | OffscreenCanvas;

/** Draws `source` with an EXIF orientation (1..8) applied. */
export function orient(source: Orientable, orientation = 1): OffscreenCanvas | Orientable {
  if (orientation <= 1 || orientation > 8) return source;
  const w = source.width;
  const h = source.height;
  const swap = orientation >= 5;
  const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
  const ctx = canvas.getContext("2d")!;
  switch (orientation) {
    case 2: ctx.setTransform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.setTransform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.setTransform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.setTransform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.setTransform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.setTransform(0, -1, -1, 0, h, w); break;
    case 8: ctx.setTransform(0, -1, 1, 0, 0, w); break;
  }
  ctx.drawImage(source, 0, 0);
  return canvas;
}

/**
 * Downscales so the longer side is at most `maxSide`, halving repeatedly first
 * so a 60 MP photo never aliases into a 400 px thumbnail.
 */
export function downscale(source: Orientable, maxSide: number): Orientable {
  let current: Orientable = source;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  const targetW = Math.max(1, Math.round(source.width * scale));
  const targetH = Math.max(1, Math.round(source.height * scale));
  while (current.width / 2 > targetW && current.height / 2 > targetH) {
    const half = new OffscreenCanvas(Math.round(current.width / 2), Math.round(current.height / 2));
    const ctx = half.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  const out = new OffscreenCanvas(targetW, targetH);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(current, 0, 0, targetW, targetH);
  return out;
}

function toCanvas(source: Orientable) {
  if (source instanceof OffscreenCanvas) return source;
  const canvas = new OffscreenCanvas(source.width, source.height);
  canvas.getContext("2d")!.drawImage(source, 0, 0);
  return canvas;
}

export async function encodeJpeg(source: Orientable, quality = 0.85): Promise<Blob> {
  return toCanvas(source).convertToBlob({ type: "image/jpeg", quality });
}

/** Keeps transparency: WebP where the browser can encode it, PNG otherwise. */
export async function encodeWithAlpha(source: Orientable, quality = 0.85): Promise<Blob> {
  const blob = await toCanvas(source).convertToBlob({ type: "image/webp", quality });
  return blob.type === "image/webp" ? blob : toCanvas(source).convertToBlob({ type: "image/png" });
}
