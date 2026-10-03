import { track } from "@/lib/activity";
import { readOriginal } from "@/core/catalog/originals";
import type { Asset } from "@/core/catalog/types";
import type { SourceData } from "@/core/gpu/pipeline";
import { decodeHeicImage } from "@/core/image/heic";
import { decodeTiffInWorker } from "@/core/image/image-workers";
import { decodeRaw, isRawDecodingAvailable } from "@/core/image/libraw";
import { asShotFromCamera } from "@/lib/colorimetry";
import type { SourceColorInfo } from "./defaults";

export type LoadedSource = {
  readonly data: SourceData;
  readonly info: SourceColorInfo;
  /** "raw" is real sensor data; "rendered" is a finished image file. */
  readonly quality: "raw" | "rendered";
};

/**
 * Decodes an asset's original for development. Camera RAW goes through
 * LibRaw as linear 16-bit Rec.2020; rendered files decode with their EXIF
 * orientation applied. The original is only ever read.
 */
/** Decodes a photo for rendering (shown by the activity line while it runs, unless `quiet`: background preloading). */
export function loadSource(asset: Asset, signal?: AbortSignal, quiet = false): Promise<LoadedSource> {
  const decoding = decodeSource(asset, signal);
  return quiet ? decoding : track(decoding);
}

async function decodeSource(asset: Asset, signal?: AbortSignal): Promise<LoadedSource> {
  const blob = await readOriginal(asset);
  signal?.throwIfAborted();
  if (asset.kind === "raw") {
    if (!isRawDecodingAvailable())
      throw new Error("RAW development needs a cross-origin isolated page. Serve Focused with COOP/COEP headers.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { image, metadata } = await decodeRaw(bytes, { output: "linear" });
    signal?.throwIfAborted();
    const color = metadata?.color_data;
    const asShot = asShotFromCamera(color?.cam_xyz, color?.cam_mul) ?? asset.asShot ?? undefined;
    const data = image.data instanceof Uint16Array ? image.data : new Uint16Array(image.data);
    const rgb = image.colors === 3 ? data : toRgb(data, image.colors);
    return {
      data: { kind: "rgb16-linear", width: image.width, height: image.height, data: rgb, white: 65535 },
      info: { raw: true, asShot },
      quality: "raw",
    };
  }
  if (asset.kind === "tiff") {
    const decoded = await decodeTiffInWorker(blob);
    return { data: decoded, info: { raw: false }, quality: "rendered" };
  }
  let bitmap: ImageBitmap;
  if (asset.kind === "heic") {
    bitmap = await decodeHeicImage(blob);
  } else {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "default" });
  }
  return {
    data: { kind: "image", image: bitmap, width: bitmap.width, height: bitmap.height },
    info: { raw: false },
    quality: "rendered",
  };
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
