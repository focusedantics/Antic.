import { getAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { outputSize } from "@/core/develop/geometry";
import { recipeFor } from "@/core/develop/session";
import { loadSource } from "@/core/develop/source-loader";
import { developEngine, encodePixels } from "@/core/gpu/develop-engine";
import { buildExif, insertExif } from "./exif";

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
  return { width: Math.max(1, Math.round(full.width * scale)), height: Math.max(1, Math.round(full.height * scale)), scale };
}

export type ExportResult = { name: string; blob: Blob; width: number; height: number };

/** Develops and encodes one photo from its original and recipe. */
export async function exportAsset(id: AssetId, settings: ExportSettings): Promise<ExportResult> {
  const asset = getAsset(id);
  const recipe = recipeFor(id);
  if (!asset || !recipe) throw new Error("Photo not found");
  const engine = developEngine();
  if (!engine.hasSource(id) || engine.hasSource(id, "preview")) {
    const loaded = await loadSource(asset);
    engine.setSource(id, loaded, loaded.quality);
  }
  const source = engine.sourceFor(id)!;
  const full = outputSize(source.size, recipe.geometry);
  const size = exportSize(full, settings);
  const pixels = engine.renderPixels(source, recipe, Math.max(size.width, size.height));
  let blob = await encodePixels(pixels, mime[settings.format], settings.quality, settings.background);
  if (settings.format === "jpeg" && settings.metadata !== "none") {
    const exif =
      settings.metadata === "all" ? asset.exif : { copyright: asset.exif.copyright, artist: asset.exif.artist };
    const payload = buildExif(exif, {
      captureTime: settings.metadata === "all" ? asset.captureTime : undefined,
      width: pixels.width,
      height: pixels.height,
    });
    blob = new Blob([insertExif(new Uint8Array(await blob.arrayBuffer()), payload) as BlobPart], { type: "image/jpeg" });
  }
  const base = asset.fileName.replace(/\.[^.]+$/, "");
  return { name: `${base}${settings.suffix}.${extension[settings.format]}`, blob, width: pixels.width, height: pixels.height };
}

type DirectoryHandle = FileSystemDirectoryHandle & {
  getFileHandle(name: string, options: { create: boolean }): Promise<FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }>;
};

export const canChooseFolder = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export async function chooseFolder(): Promise<DirectoryHandle> {
  return (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirectoryHandle> }).showDirectoryPicker({ id: "focused-export", mode: "readwrite" });
}

/** Saves into a chosen folder, or through a browser download. Never overwrites an original. */
export async function save(result: ExportResult, folder?: DirectoryHandle) {
  if (folder) {
    const handle = await folder.getFileHandle(result.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(result.blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = result.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
