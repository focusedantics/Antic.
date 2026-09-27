import type { FileKind } from "@/core/catalog/types";

export const RAW_EXTENSIONS = [
  "arw", "srf", "sr2", "cr2", "cr3", "crw", "nef", "nrw", "dng", "raf", "rw2", "rwl", "orf",
  "pef", "ptx", "srw", "3fr", "fff", "iiq", "kdc", "dcr", "mos", "mef", "erf", "mrw", "x3f", "raw",
] as const;

const byExtension: Record<string, FileKind> = {
  jpg: "jpeg", jpeg: "jpeg", jpe: "jpeg", jfif: "jpeg",
  png: "png",
  tif: "tiff", tiff: "tiff",
  heic: "heic", heif: "heic", hif: "heic",
  webp: "webp",
  avif: "avif",
  gif: "gif",
  bmp: "bmp",
};
for (const ext of RAW_EXTENSIONS) byExtension[ext] = "raw";

const byMime: Record<string, FileKind> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/x-adobe-dng": "raw",
  "image/x-sony-arw": "raw",
  "image/x-canon-cr2": "raw",
  "image/x-canon-cr3": "raw",
  "image/x-nikon-nef": "raw",
  "image/x-fuji-raf": "raw",
  "image/x-panasonic-rw2": "raw",
  "image/x-olympus-orf": "raw",
};

export const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** Extension first: operating systems rarely type RAW files and sometimes mistype them as TIFF. */
export function fileKindOf(file: { name: string; type: string }): FileKind | null {
  return byExtension[extensionOf(file.name)] ?? byMime[file.type] ?? null;
}

export const acceptAttribute = [
  ...Object.keys(byExtension).map((e) => `.${e}`),
  ...Object.keys(byMime),
].join(",");

/** Kinds `createImageBitmap` decodes in every browser we target. */
export const nativeKinds: ReadonlySet<FileKind> = new Set(["jpeg", "png", "webp", "gif", "bmp", "avif"]);
