import type { ExifSummary, FileKind } from "@/core/catalog/types";
import { largestEmbeddedJpeg } from "./embedded-preview";
import { decodeAtMost, headerSize } from "./decode";
import { decodeRaw } from "./libraw";
import { readMetadata } from "./metadata";
import { downscale, encodeJpeg, encodeWithAlpha, orient } from "./raster";
import { decodeTiffToBitmap } from "./tiff";

export const THUMB_SIZE = 480;
export const PREVIEW_SIZE = 2560;

export type Analysis = {
  width?: number;
  height?: number;
  orientation?: number;
  captureTime?: number;
  exif: ExifSummary;
  thumb?: Blob;
  preview?: Blob;
  /** Where the preview came from, shown in the UI so a camera JPEG isn't mistaken for a RAW render. */
  previewSource: "embedded" | "decoded" | "none";
  warning?: string;
};

/**
 * Reads everything the Library needs from one file: metadata, an oriented
 * thumbnail and a large preview. Runs in the image worker.
 */
export async function analyzeFile(file: Blob, kind: FileKind): Promise<Analysis> {
  if (kind === "raw") return analyzeRaw(new Uint8Array(await file.arrayBuffer()));
  if (kind === "tiff") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = await readMetadata(bytes);
    // TIFF decoding ignores orientation; apply it like the browser does for JPEG.
    const oriented = orient(await decodeTiffToBitmap(bytes), meta.orientation);
    const { width, height } = oriented;
    return { ...meta, width, height, ...(await thumbnails(oriented, true)), previewSource: "decoded" };
  }
  // Only the head of the file is read here: EXIF (exifr reads what it needs from the
  // Blob) and the header's image size. The browser decodes straight to about the
  // preview size, so a 48 MP photo is never a full-size bitmap in this worker.
  const meta = await readMetadata(file);
  const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
  // Browsers apply the EXIF orientation of JPEG/WebP/AVIF files here.
  const { bitmap, full } = await decodeAtMost(file, kind === "heic", headerSize(head), PREVIEW_SIZE);
  // Read the size before thumbnails() closes the bitmap (a closed bitmap reports 0 × 0).
  const width = full?.width ?? bitmap.width;
  const height = full?.height ?? bitmap.height;
  const result = await thumbnails(bitmap, alphaKinds.has(kind));
  return { ...meta, width, height, ...result, previewSource: "decoded" };
}

const alphaKinds = new Set<FileKind>(["png", "webp", "avif", "gif", "tiff", "heic"]);

async function thumbnails(source: ImageBitmap | OffscreenCanvas, alpha = false) {
  const encode = alpha ? encodeWithAlpha : encodeJpeg;
  const previewImage = downscale(source, PREVIEW_SIZE);
  // The thumbnail comes from the preview: a fraction of the work of scaling the original again.
  if (previewImage !== source && source instanceof ImageBitmap) source.close();
  const preview = await encode(previewImage, 0.88);
  const thumb = await encode(downscale(previewImage, THUMB_SIZE), 0.82);
  if (previewImage instanceof ImageBitmap) previewImage.close();
  return { thumb, preview };
}

async function analyzeRaw(bytes: Uint8Array): Promise<Analysis> {
  const embedded = largestEmbeddedJpeg(bytes);
  const jpegBytes = embedded ? bytes.subarray(embedded.offset, embedded.offset + embedded.length) : undefined;
  const meta = await readMetadata(bytes, jpegBytes);
  if (embedded && jpegBytes && Math.max(embedded.width, embedded.height) >= 320) {
    try {
      // Embedded previews rarely carry their own orientation: use the RAW's.
      const bitmap = await createImageBitmap(new Blob([jpegBytes.slice()], { type: "image/jpeg" }), {
        imageOrientation: "none",
      });
      const oriented = orient(bitmap, meta.orientation);
      const { thumb, preview } = await thumbnails(oriented);
      if (oriented !== bitmap) bitmap.close();
      return { ...meta, ...fullSize(meta), thumb, preview, previewSource: "embedded" };
    } catch {
      // Fall through to a real decode.
    }
  }
  try {
    const { image, metadata } = await decodeRaw(bytes, { halfSize: true, output: "display" });
    const rgba = new Uint8ClampedArray(image.width * image.height * 4);
    const src = image.data as Uint8Array;
    const colors = image.colors;
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += colors) {
      rgba[i] = src[j];
      rgba[i + 1] = src[j + 1];
      rgba[i + 2] = src[j + 2];
      rgba[i + 3] = 255;
    }
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d")!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    const { thumb, preview } = await thumbnails(canvas);
    return {
      ...meta,
      width: meta.width ?? (metadata ? metadata.width : image.width * 2),
      height: meta.height ?? (metadata ? metadata.height : image.height * 2),
      thumb,
      preview,
      previewSource: "decoded",
    };
  } catch (error) {
    return {
      ...meta,
      previewSource: "none",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

/** EXIF sizes are unoriented; the catalog stores the oriented size. */
function fullSize(meta: { width?: number; height?: number; orientation?: number }) {
  if (!meta.width || !meta.height) return {};
  const swap = (meta.orientation ?? 1) >= 5;
  return swap ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}
