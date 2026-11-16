import { analyzeInWorker } from "@/core/image/image-workers";
import { device } from "@/lib/device";
import { getSetting, getThumb, putSetting, putThumb } from "./db";
import { readOriginal } from "./originals";
import { catalog, updateAsset } from "./store";
import type { AssetId } from "./types";

/** Set once the developed thumbnails saved by the old readback have been rendered again. */
export const THUMBS_REPAIRED = "thumbs-readback-v2";

/**
 * Runs the engine's thumbnail repair once per catalog. The flag is read first, and an empty
 * catalog is marked done here, so the engine is not loaded just to find nothing to do.
 */
export async function repairThumbnailsOnce() {
  if (await getSetting(THUMBS_REPAIRED)) return;
  if (!catalog.getState().assets.size) return putSetting(THUMBS_REPAIRED, true);
  const { developEngine } = await import("@/core/gpu/develop-engine");
  await developEngine().repairThumbnails();
}

/** Set once RAW previews drawn from an already-edited preview have been made again. */
export const RAW_PREVIEWS_REPAIRED = "raw-previews-v1";

/**
 * Phones draw a RAW too large to decode from its catalog preview. For a while that could
 * be the *developed* preview, treated as a rendered file: the edits (and a colour cast from
 * white balance read on the wrong scale) were applied again on top, and the result was
 * saved as the photo's new preview, so the Library showed it too and each round added more.
 *
 * Once per catalog, on phones: every RAW whose preview is a developed one with no unedited
 * preview beside it gets the camera's preview back from its original. Those with edits are
 * then developed again from it in the background, one at a time.
 */
export async function repairRawPreviewsOnce() {
  if (!device.lite || (await getSetting(RAW_PREVIEWS_REPAIRED))) return;
  const edited: AssetId[] = [];
  for (const asset of [...catalog.getState().assets.values()]) {
    if (asset.kind !== "raw") continue;
    try {
      const record = await getThumb(asset.id);
      if (!record || record.previewSource !== "developed" || record.base) continue;
      const again = await analyzeInWorker(await readOriginal(asset), asset.kind);
      const base = again.preview ?? again.thumb;
      if (!base) continue;
      await putThumb(asset.id, { thumb: again.thumb, preview: again.preview, base, previewSource: again.previewSource, revision: -1 });
      (await import("@/app/thumbs")).invalidateImage(asset.id);
      updateAsset(asset.id, { thumbRevision: -1, thumbState: "ready" });
      if (asset.develop) edited.push(asset.id);
    } catch (error) {
      console.warn(`Could not restore the preview of ${asset.fileName}`, error);
    }
  }
  await putSetting(RAW_PREVIEWS_REPAIRED, true);
  if (edited.length) (await import("@/core/gpu/develop-engine")).developEngine().refreshThumbnailsOf(edited);
}
