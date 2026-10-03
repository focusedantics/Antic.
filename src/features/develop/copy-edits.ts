import { toast, ui } from "@/app/state";
import { getAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { copyEditsOf, editClipboard, pasteEditsTo } from "@/core/develop/clipboard";
import { defaultCopyGroups, recipeGroups } from "@/core/develop/operations";
import type { RecipeGroup } from "@/core/develop/recipe";
import { develop } from "@/core/develop/session";

/** The photo "Copy edits" copies from: the one open in Develop, else the Library's active photo. */
export const editSourceId = (): AssetId | null => (ui.getState().workspace === "develop" ? develop.getState().assetId : null) ?? ui.getState().activeId;

/** Copies a photo's edits (everything but crop, masks and spot removal unless `groups` says). */
export function copyEdits(id: AssetId | null = editSourceId(), groups: readonly RecipeGroup[] = defaultCopyGroups) {
  const asset = id ? getAsset(id) : undefined;
  if (!id || !asset) return;
  if (!copyEditsOf(id, asset.fileName, groups)) return;
  const what = groups.length === recipeGroups.length ? "all edits" : groups === defaultCopyGroups ? "the edits" : `${groups.length} groups of edits`;
  toast(`Copied ${what} of ${asset.fileName}.`);
}

/** Pastes the copied edits onto photos and updates their Library thumbnails in the background. */
export function pasteEdits(ids: readonly AssetId[]) {
  const clip = editClipboard.getState().clip;
  if (!clip) {
    toast("Nothing copied yet: copy a photo's edits first.");
    return;
  }
  const n = pasteEditsTo(ids);
  if (!n) return;
  // The engine loads with Develop; the Library can paste before it has.
  void import("@/core/gpu/develop-engine").then(({ developEngine }) => developEngine().refreshThumbnailsOf(ids));
  toast(n === 1 ? `Pasted the edits of ${clip.from}.` : `Pasted the edits of ${clip.from} to ${n} photos.`);
}
