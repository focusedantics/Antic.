import { device } from "@/lib/device";
import { track } from "@/lib/activity";
import { nextPaint } from "@/lib/pacing";
import { getAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { outputSize } from "@/core/develop/geometry";
import { recipeFor } from "@/core/develop/session";
import { loadSource } from "@/core/develop/source-loader";
import { developEngine, encodePixels, isOpaque } from "@/core/gpu/develop-engine";
import { buildExif, insertExif } from "./exif";
import { type ExportFrame, frameLayout } from "./frame";
import type { Watermark } from "./watermark";

export type ExportFormat = "jpeg" | "png" | "webp";
export type ExportSettings = {
  readonly format: ExportFormat;
  /** 0..1 for JPEG and WebP. */
  readonly quality: number;
  readonly resize: "full" | "long" | "short" | "width" | "height";
  readonly size: number;
  readonly enlarge: boolean;
  /** JPEG has no alpha: transparent areas are flattened onto this color. */
  readonly background: string;
  readonly metadata: "all" | "copyright" | "none";
  readonly suffix: string;
};

export const defaultExportSettings: ExportSettings = {
  format: "jpeg",
  quality: 0.9,
  resize: "full",
  size: 2048,
  enlarge: false,
  background: "#ffffff",
  metadata: "all",
  suffix: "",
};

const extension: Record<ExportFormat, string> = { jpeg: "jpg", png: "png", webp: "webp" };
const mime: Record<ExportFormat, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Output pixel size for a photo of `full` pixels under `settings`. */
export function exportSize(full: { width: number; height: number }, s: ExportSettings) {
  let scale = 1;
  switch (s.resize) {
    case "long":
      scale = s.size / Math.max(full.width, full.height);
      break;
    case "short":
      scale = s.size / Math.min(full.width, full.height);
      break;
    case "width":
      scale = s.size / full.width;
      break;
    case "height":
      scale = s.size / full.height;
      break;
  }
  if (!s.enlarge) scale = Math.min(1, scale);
  // Phones render at most device.maxSide px on the long side (their memory).
  scale = Math.min(scale, device.maxSide / Math.max(full.width, full.height));
  return { width: Math.max(1, Math.round(full.width * scale)), height: Math.max(1, Math.round(full.height * scale)), scale };
}

export type ExportResult = { name: string; blob: Blob; width: number; height: number };

/** Where an export is (0..1 within this photo), for progress labels. */
export type ExportStage = (label: string, fraction: number) => void;

/**
 * Develops and encodes one photo from its original and recipe. Rendering and
 * read-back are synchronous GPU work, so it lets the browser paint before each
 * heavy step: the dialog shows what is happening instead of freezing first.
 */
export function exportAsset(id: AssetId, settings: ExportSettings, watermark?: Watermark, onStage?: ExportStage, frame?: ExportFrame): Promise<ExportResult> {
  return track(renderExport(id, settings, watermark, onStage, frame));
}

async function renderExport(id: AssetId, settings: ExportSettings, watermark?: Watermark, onStage?: ExportStage, frame?: ExportFrame): Promise<ExportResult> {
  const asset = getAsset(id);
  const recipe = recipeFor(id);
  if (!asset || !recipe) throw new Error("Photo not found");
  const engine = developEngine();
  if (!engine.hasSource(id) || engine.hasSource(id, "preview")) {
    onStage?.("Reading the original…", 0.05);
    const loaded = await loadSource(asset);
    engine.setSource(id, loaded, loaded.quality);
  }
  const source = engine.sourceFor(id)!;
  const full = outputSize(source.size, recipe.geometry);
  const size = exportSize(full, settings);
  onStage?.(`Developing ${size.width} × ${size.height}…`, 0.2);
  await nextPaint();
  const pixels = engine.exportPixels(source, recipe, Math.max(size.width, size.height));
  onStage?.(`Encoding ${settings.format.toUpperCase()}…`, 0.65);
  await nextPaint();
  let blob = await encodePixels(pixels, mime[settings.format], settings.quality, settings.background, watermark, frame, isOpaque(recipe));
  // A frame placed around the photo makes the file larger than the photo.
  const out = frameLayout(pixels.width, pixels.height, frame);
  onStage?.("Saving…", 0.95);
  if (settings.format === "jpeg" && settings.metadata !== "none") {
    const exif =
      settings.metadata === "all" ? asset.exif : { copyright: asset.exif.copyright, artist: asset.exif.artist };
    const payload = buildExif(exif, {
      captureTime: settings.metadata === "all" ? asset.captureTime : undefined,
      width: out.width,
      height: out.height,
    });
    blob = new Blob([insertExif(new Uint8Array(await blob.arrayBuffer()), payload) as BlobPart], { type: "image/jpeg" });
  }
  const base = asset.fileName.replace(/\.[^.]+$/, "");
  return { name: `${base}${settings.suffix}.${extension[settings.format]}`, blob, width: out.width, height: out.height };
}
