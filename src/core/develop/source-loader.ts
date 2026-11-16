import { track } from "@/lib/activity";
import { readOriginal } from "@/core/catalog/originals";
import type { Asset } from "@/core/catalog/types";
import type { SourceData } from "@/core/gpu/pipeline";
import { decodeAtMost } from "@/core/image/decode";
import { analyzeInWorker, decodeTiffInWorker } from "@/core/image/image-workers";
import { decodeRaw, isRawDecodingAvailable } from "@/core/image/libraw";
import { rawImageInfo } from "@/core/image/raw-kind";
import { asShotFromCamera } from "@/lib/colorimetry";
import { device } from "@/lib/device";
import type { SourceColorInfo } from "./defaults";

export type LoadedSource = {
  readonly data: SourceData;
  readonly info: SourceColorInfo;
  /** "raw" is real sensor data; "rendered" is a finished image file. */
  readonly quality: "raw" | "rendered";
  /** A RAW too big to decode on this device, shown from its preview instead (see `loadSource`). */
  readonly fromPreview?: boolean;
};

/**
 * Phones decode a linear RAW (iPhone ProRAW and the like) up to this many pixels; larger
 * ones would take about a gigabyte inside LibRaw, and iOS ends the page (it goes black).
 * Those are shown from their 2560 px preview instead.
 */
export const LITE_LINEAR_RAW_PIXELS = 24e6;
/** How much of a RAW is read to learn its layout: its tags sit at the start. */
const HEADER_BYTES = 4 * 1024 * 1024;

/** A RAW shown from its catalog preview, keeping its full size (crops, zoom and radii stay true). */
async function previewStandIn(asset: Asset, layout?: { width: number; height: number }): Promise<LoadedSource | null> {
  const preview = await loadPreviewSource(asset, true);
  if (!preview || preview.data.kind !== "image") return null;
  let full = { width: asset.width ?? layout?.width ?? preview.data.width, height: asset.height ?? layout?.height ?? preview.data.height };
  // The preview stands for the whole photo only if it has its shape: one of another shape
  // (a camera's 16:9 preview of a 3:2 RAW) keeps its own, rather than being stretched.
  const shape = (preview.data.width / preview.data.height) / (full.width / full.height);
  if (shape < 0.98 || shape > 1.02) full = { width: full.width, height: Math.round((full.width * preview.data.height) / preview.data.width) };
  return { ...preview, data: { ...preview.data, fullWidth: full.width, fullHeight: full.height }, fromPreview: true };
}

/**
 * A photo for a composition or design. Phones draw RAWs from their 2560 px preview: the
 * original is not even read (a whole ProRAW in memory is enough for iOS to reload the
 * page), and a design on a phone rarely needs more. Develop decodes the RAW itself.
 */
export async function loadCompositionSource(asset: Asset, maxSide = device.maxSide, quiet = false): Promise<LoadedSource> {
  if (device.lite && asset.kind === "raw") {
    const preview = await previewStandIn(asset);
    if (preview) return preview;
  }
  return loadSource(asset, undefined, quiet, maxSide);
}

/**
 * Decodes an asset's original for development. Camera RAW goes through LibRaw as
 * linear 16-bit Rec.2020; rendered files decode with their EXIF orientation applied.
 * The original is only ever read.
 *
 * Photos are decoded no larger than the engine keeps them (`device.maxSide`: 4096 px
 * on phones), so a 48 MP iPhone photo never sits in memory at full size beyond the
 * decode itself: the browser resizes while decoding, and phones decode RAW at half
 * size when that still covers the working size. The full-resolution size travels in
 * `fullWidth/fullHeight` so crops, zoom and radii stay true.
 *
 * Shown by the activity line while it runs, unless `quiet` (background preloading).
 */
export function loadSource(asset: Asset, signal?: AbortSignal, quiet = false, maxSide = device.maxSide): Promise<LoadedSource> {
  const decoding = decodeSource(asset, maxSide, signal);
  return quiet ? decoding : track(decoding);
}

async function decodeSource(asset: Asset, maxSide: number, signal?: AbortSignal): Promise<LoadedSource> {
  const blob = await readOriginal(asset);
  signal?.throwIfAborted();
  if (asset.kind === "raw") {
    if (!isRawDecodingAvailable())
      throw new Error("RAW development needs a cross-origin isolated page. Serve Focused with COOP/COEP headers.");
    const long = Math.max(asset.width ?? 0, asset.height ?? 0);
    // Half size skips demosaicing: a quarter of the memory, and still at least the working size.
    const halfSize = long > 0 && long / 2 >= Math.min(maxSide, 8192) * 0.7;
    if (device.lite) {
      // Decided from the first few MB: on iOS, reading a whole 75 MB ProRAW into memory is
      // enough by itself to have the page reloaded.
      const layout = rawImageInfo(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
      if (layout?.linear && layout.width * layout.height > LITE_LINEAR_RAW_PIXELS) {
        const preview = await previewStandIn(asset, layout);
        if (preview) return preview;
      }
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { image, metadata } = await decodeRaw(bytes, { output: "linear", halfSize });
    signal?.throwIfAborted();
    const color = metadata?.color_data;
    const asShot = asShotFromCamera(color?.cam_xyz, color?.cam_mul) ?? asset.asShot ?? undefined;
    const data = image.data instanceof Uint16Array ? image.data : new Uint16Array(image.data);
    const rgb = image.colors === 3 ? data : toRgb(data, image.colors);
    const full = halfSize ? fullOf(asset, image.width * 2, image.height * 2) : null;
    return {
      data: { kind: "rgb16-linear", width: image.width, height: image.height, data: rgb, white: 65535, fullWidth: full?.width, fullHeight: full?.height },
      info: { raw: true, asShot },
      quality: "raw",
    };
  }
  if (asset.kind === "tiff") {
    const decoded = await decodeTiffInWorker(blob);
    return { data: decoded, info: { raw: false }, quality: "rendered" };
  }
  const { bitmap, full } = await decodeAtMost(blob, asset.kind === "heic", asset.width && asset.height ? { width: asset.width, height: asset.height } : null, maxSide);
  if (signal?.aborted) {
    bitmap.close();
    signal.throwIfAborted();
  }
  return {
    data: { kind: "image", image: bitmap, width: bitmap.width, height: bitmap.height, fullWidth: full?.width, fullHeight: full?.height },
    info: { raw: false },
    quality: "rendered",
  };
}

/** The asset's recorded full size when it matches a decoded size (±2 %), else that size. */
function fullOf(asset: Asset, width: number, height: number) {
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, b * 0.02);
  if (asset.width && asset.height && close(asset.width, width) && close(asset.height, height)) return { width: asset.width, height: asset.height };
  return { width, height };
}

function toRgb(data: Uint16Array, colors: number) {
  const pixels = data.length / colors;
  const out = new Uint16Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = data[i * colors];
    out[i * 3 + 1] = data[i * colors + Math.min(1, colors - 1)];
    out[i * 3 + 2] = data[i * colors + Math.min(2, colors - 1)];
  }
  return out;
}

/**
 * The photo's unedited preview from the catalog (the camera's embedded one, or the first
 * decode), to draw it from while the original decodes, or instead of it (`previewStandIn`).
 * Never the developed preview: the recipe is applied to what this returns, and a preview
 * with the edits already in it would get them twice (and a cropped one would be stretched
 * to the uncropped size). A record that has only a developed preview has the unedited one
 * made again from the original when `remake` is set; otherwise there is none.
 *
 * A RAW's preview is a RAW to its recipe (`rendered`): white balance stays in Kelvin
 * around as-shot. Called a rendered file, the recipe's 5500 K was read on the −100…100
 * scale and came out as a heavy colour cast.
 */
export async function loadPreviewSource(asset: Asset, remake = false): Promise<LoadedSource | null> {
  const { getThumb, putThumbBase, undevelopedPreview } = await import("@/core/catalog/db");
  const record = await getThumb(asset.id);
  let blob = undevelopedPreview(record);
  if (!blob && remake && record) {
    try {
      const again = await analyzeInWorker(await readOriginal(asset), asset.kind);
      blob = again.preview ?? again.thumb;
      if (blob) await putThumbBase(asset.id, blob);
    } catch (error) {
      console.warn(`Could not read the camera preview of ${asset.fileName} again`, error);
    }
  }
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  return {
    data: { kind: "image", image: bitmap, width: bitmap.width, height: bitmap.height },
    info: asset.kind === "raw" ? { raw: true, asShot: asset.asShot, rendered: true } : { raw: false },
    quality: "rendered",
  };
}
