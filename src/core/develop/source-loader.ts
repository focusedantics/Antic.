import { track } from "@/lib/activity";
import { readOriginal } from "@/core/catalog/originals";
import type { Asset } from "@/core/catalog/types";
import type { SourceData } from "@/core/gpu/pipeline";
import { decodeAtMost } from "@/core/image/decode";
import { decodeTiffInWorker } from "@/core/image/image-workers";
import { decodeRaw, isRawDecodingAvailable } from "@/core/image/libraw";
import { asShotFromCamera } from "@/lib/colorimetry";
import { device } from "@/lib/device";
import type { SourceColorInfo } from "./defaults";

export type LoadedSource = {
  readonly data: SourceData;
  readonly info: SourceColorInfo;
  /** "raw" is real sensor data; "rendered" is a finished image file. */
  readonly quality: "raw" | "rendered";
};

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

/** The embedded/decoded preview from the catalog, shown while the original decodes. */
export async function loadPreviewSource(asset: Asset): Promise<LoadedSource | null> {
  const { getThumb } = await import("@/core/catalog/db");
  const record = await getThumb(asset.id);
  const blob = record?.preview ?? record?.thumb;
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  return {
    data: { kind: "image", image: bitmap, width: bitmap.width, height: bitmap.height },
    info: { raw: false },
    quality: "rendered",
  };
}
