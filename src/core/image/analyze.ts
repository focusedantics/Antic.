import type { ExifSummary, FileKind } from "@/core/catalog/types";
import { largestEmbeddedJpeg } from "./embedded-preview";
import { decodeHeic, isHeicDecodingSupported } from "./heic";
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "raw") return analyzeRaw(bytes);

  const meta = await readMetadata(bytes);
  let bitmap: ImageBitmap | OffscreenCanvas;
  if (kind === "heic") {
    if (isHeicDecodingSupported()) {
      try {
        bitmap = await decodeHeic(bytes);
      } catch {
        // Safari decodes HEIC natively; WebCodecs may lack HEVC on this machine.
        bitmap = await createImageBitmap(file);
      }
    } else bitmap = await createImageBitmap(file);
  } else if (kind === "tiff") {
    bitmap = await decodeTiffToBitmap(bytes);
  } else {
    // Browsers apply the EXIF orientation of JPEG/WebP/AVIF files here.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  }
  // TIFF decoding ignores orientation; apply it like the browser does for JPEG.
  const oriented = kind === "tiff" ? orient(bitmap, meta.orientation) : bitmap;
  // Read the size before thumbnails() closes the bitmap (a closed bitmap reports 0 × 0).
  const { width, height } = oriented;
  const result = await thumbnails(oriented, alphaKinds.has(kind));
  return { ...meta, width, height, ...result, previewSource: "decoded" };
}

const alphaKinds = new Set<FileKind>(["png", "webp", "avif", "gif", "tiff", "heic"]);

async function thumbnails(source: ImageBitmap | OffscreenCanvas, alpha = false) {
  const encode = alpha ? encodeWithAlpha : encodeJpeg;
  const preview = await encode(downscale(source, PREVIEW_SIZE), 0.88);
  const thumb = await encode(downscale(source, THUMB_SIZE), 0.82);
  if (source instanceof ImageBitmap) source.close();
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
