import { createStore } from "zustand/vanilla";
import type { AssetId } from "@/core/catalog/types";
import { createDefaultRecipe } from "./defaults";
import { copyGroups, defaultCopyGroups, pasteGroups, type RecipeClip, recipeGroups, sanitizeRecipe } from "./operations";
import type { RecipeGroup } from "./recipe";
import { colorInfoFor, recipeFor, setRecipeFor } from "./session";

/**
 * Copied edits: one photo's develop settings (all of them but crop, masks and spot
 * removal unless chosen) ready to paste onto any number of photos. It is kept in
 * localStorage, so it survives a reload, and read back through `sanitizeRecipe`
 * like any other stored recipe. No file is involved; Looks remain for sharing edits.
 */
export type EditClip = RecipeClip & {
  /** File name of the photo they came from, for messages. */
  readonly from: string;
};

const KEY = "focused:edit-clipboard";

export const editClipboard = createStore<{ clip: EditClip | null }>(() => ({ clip: null }));
// Read back once the modules have loaded: the sanitizer's imports may still be
// initialising while this module is (an import cycle would make `load` fail).
queueMicrotask(() => {
  if (!editClipboard.getState().clip) editClipboard.setState({ clip: load() });
});

const validGroups = new Set<string>(recipeGroups.map((g) => g.id));

/** Parses a stored clip; anything malformed yields null, values are sanitized. */
export function parseClip(input: unknown): EditClip | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const groups = Array.isArray(o.groups) ? (o.groups.filter((g) => typeof g === "string" && validGroups.has(g)) as RecipeGroup[]) : [];
  if (!groups.length || !o.values || typeof o.values !== "object") return null;
  const raw = o.raw === true;
  const info = { raw };
  // Fill the clip's groups into a full recipe so the sanitizer checks every value.
  const recipe = sanitizeRecipe({ ...createDefaultRecipe(info), ...(o.values as object) }, info);
  return { ...copyGroups(recipe, groups, raw), from: typeof o.from === "string" ? o.from.slice(0, 200) : "" };
}

function load(): EditClip | null {
  try {
    return parseClip(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch (error) {
    console.warn("Could not read the copied edits", error);
    return null;
  }
}

function save(clip: EditClip | null) {
  editClipboard.setState({ clip });
  try {
    if (clip) localStorage.setItem(KEY, JSON.stringify(clip));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage full or blocked: the clip lasts for this visit.
  }
}

/** Copies a photo's edits (its current recipe, open in Develop or not). */
export function copyEditsOf(assetId: AssetId, fileName: string, groups: readonly RecipeGroup[] = defaultCopyGroups): EditClip | null {
  const recipe = recipeFor(assetId);
  if (!recipe) return null;
  const clip = { ...copyGroups(recipe, groups, colorInfoFor(assetId).raw), from: fileName };
  save(clip);
  return clip;
}

/** Pastes the copied edits onto photos (each gets one undoable step in its own history). Returns how many changed. */
export function pasteEditsTo(ids: readonly AssetId[]): number {
  const clip = editClipboard.getState().clip;
  if (!clip) return 0;
  let n = 0;
  for (const id of ids) {
    const current = recipeFor(id);
    if (!current) continue;
    setRecipeFor(id, pasteGroups(current, clip, colorInfoFor(id)), "Paste Edits");
    n++;
  }
  return n;
}

export const clearEditClipboard = () => save(null);
