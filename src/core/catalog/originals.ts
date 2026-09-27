import { getStoredOriginal } from "./db";
import type { Asset } from "./types";

/**
 * Reads an original, read-only. Stored originals come from IndexedDB; referenced
 * originals are re-read from disk, asking for permission again when the browser
 * requires it (this must then happen during a user gesture).
 */
export async function readOriginal(asset: Asset): Promise<Blob> {
  if (asset.original.kind === "stored") {
    const blob = await getStoredOriginal(asset.id);
    if (!blob) throw new Error(`The original of ${asset.fileName} is missing from the library.`);
    return blob;
  }
  const handle = asset.original.handle;
  const options = { mode: "read" } as const;
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (o: typeof options) => Promise<PermissionState>;
    requestPermission?: (o: typeof options) => Promise<PermissionState>;
  };
  if (h.queryPermission && (await h.queryPermission(options)) !== "granted") {
    if (!h.requestPermission || (await h.requestPermission(options)) !== "granted")
      throw new Error(`Permission to read ${asset.original.path} was not granted.`);
  }
  try {
    return await handle.getFile();
  } catch {
    throw new Error(`${asset.original.path} could not be read. It may have been moved or deleted.`);
  }
}
