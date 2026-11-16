import { getSetting, putSetting } from "./db";
import { catalog } from "./store";

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
