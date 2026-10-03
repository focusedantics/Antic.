import { createStore } from "zustand/vanilla";
import { getAsset, updateAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { createHistory, type History } from "@/core/history/history";
import { createDefaultRecipe, type SourceColorInfo } from "./defaults";
import { deepEqual, sanitizeRecipe } from "./operations";
import type { DevelopRecipe } from "./recipe";

export type DevelopTool = "adjust" | "crop" | "mask" | "heal";

export type DevelopView = {
  /** Fit the whole photo, or show it at `zoom` image pixels per device pixel. */
  readonly fit: boolean;
  readonly zoom: number;
  /** Center of the view in output uv (0..1). */
  readonly centerX: number;
  readonly centerY: number;
};

export type Histogram = {
  readonly r: Uint32Array;
  readonly g: Uint32Array;
  readonly b: Uint32Array;
  readonly l: Uint32Array;
  readonly clippedHigh: number;
  readonly clippedLow: number;
};

export type DevelopState = {
  readonly assetId: AssetId | null;
  readonly recipe: DevelopRecipe | null;
  readonly info: SourceColorInfo | null;
  /** What is on screen: the catalog preview while the original decodes, then the real source. */
  readonly source: "none" | "preview" | "raw" | "rendered";
  readonly loading: boolean;
  readonly error: string | null;
  readonly tool: DevelopTool;
  readonly view: DevelopView;
  readonly compare: "off" | "split" | "side-by-side";
  /** The original shown in place of the edit while a finger (or the mouse) is held on the photo. */
  readonly peek: boolean;
  readonly splitPosition: number;
  readonly clipping: boolean;
  readonly histogram: Histogram | null;
  /** Mask selected for editing, and the component the canvas tools act on. */
  readonly activeMaskId: string | null;
  readonly activeComponentId: string | null;
  readonly maskOverlay: boolean;
  /** Show the edited mask as black & white coverage instead of a red overlay. */
  readonly maskBw: boolean;
};

export const develop = createStore<DevelopState>(() => ({
  assetId: null,
  recipe: null,
  info: null,
  source: "none",
  loading: false,
  error: null,
  tool: "adjust",
  view: { fit: true, zoom: 1, centerX: 0.5, centerY: 0.5 },
  compare: "off",
  peek: false,
  splitPosition: 0.5,
  clipping: false,
  histogram: null,
  activeMaskId: null,
  activeComponentId: null,
  maskOverlay: true,
  maskBw: false,
}));

const histories = new Map<AssetId, History<DevelopRecipe>>();
let unsubscribe: (() => void) | null = null;

/** The history of the photo open in Develop. */
export function currentHistory(): History<DevelopRecipe> | null {
  const id = develop.getState().assetId;
  return id ? (histories.get(id) ?? null) : null;
}

function infoFor(assetId: AssetId): SourceColorInfo {
  const a = getAsset(assetId);
  return { raw: a?.kind === "raw", asShot: a?.asShot };
}

/** Opens a photo: its stored recipe (sanitized) or the defaults, with its own history. */
export function openInDevelop(assetId: AssetId) {
  const asset = getAsset(assetId);
  if (!asset) return;
  const info = infoFor(assetId);
  let history = histories.get(assetId);
  if (!history) {
    const recipe = asset.develop ? sanitizeRecipe(asset.develop, info) : createDefaultRecipe(info);
    history = createHistory(recipe, { equal: (a, b) => a === b, label: "Open" });
    histories.set(assetId, history);
  }
  unsubscribe?.();
  const h = history;
  unsubscribe = h.subscribe(() => {
    develop.setState({ recipe: h.get() });
    persist(assetId, h.get());
  });
  develop.setState({
    assetId,
    recipe: h.get(),
    info,
    source: "none",
    loading: true,
    error: null,
    histogram: null,
    activeMaskId: null,
    activeComponentId: null,
  });
}

/**
 * Called once the original is decoded and its real color info is known. RAW
 * as-shot white balance is recorded on the asset, and a recipe still "as shot"
 * follows it.
 */
export function sourceDecoded(assetId: AssetId, info: SourceColorInfo, quality: "raw" | "rendered", size?: { width: number; height: number }) {
  const asset = getAsset(assetId);
  if (!asset) return;
  if (size && (!asset.width || !asset.height)) updateAsset(assetId, { width: size.width, height: size.height });
  if (info.asShot && !deepEqual(info.asShot, asset.asShot)) updateAsset(assetId, { asShot: info.asShot });
  const history = histories.get(assetId);
  if (history && info.raw) {
    const recipe = history.get();
    if (recipe.whiteBalance.mode === "as-shot" && info.asShot) {
      const wb = { ...recipe.whiteBalance, ...info.asShot };
      if (!deepEqual(wb, recipe.whiteBalance)) {
        // Not an edit: rebase an untouched history on the true as-shot values.
        const fixed = { ...recipe, whiteBalance: wb };
        if (history.status().entries.length === 1) history.reset(fixed, "Open");
        else history.set(fixed, "As Shot white balance");
      }
    }
  }
  if (develop.getState().assetId === assetId) develop.setState({ info, source: quality, loading: false, error: null });
}

const persistTimers = new Map<AssetId, ReturnType<typeof setTimeout>>();
function persist(assetId: AssetId, recipe: DevelopRecipe) {
  clearTimeout(persistTimers.get(assetId));
  persistTimers.set(
    assetId,
    setTimeout(() => {
      persistTimers.delete(assetId);
      const asset = getAsset(assetId);
      if (!asset || asset.develop === recipe) return;
      const info = infoFor(assetId);
      const untouched = !asset.develop && deepEqual(recipe, createDefaultRecipe(info));
      if (untouched) return;
      updateAsset(assetId, { develop: recipe, developRevision: asset.developRevision + 1 });
    }, 300),
  );
}

/** Immediately writes pending recipe changes (before leaving a photo). */
export function flushDevelop() {
  for (const [assetId, timer] of persistTimers) {
    clearTimeout(timer);
    persistTimers.delete(assetId);
    const h = histories.get(assetId);
    const asset = getAsset(assetId);
    if (h && asset && asset.develop !== h.get()) updateAsset(assetId, { develop: h.get(), developRevision: asset.developRevision + 1 });
  }
}

// ─── Edits ──────────────────────────────────────────────────────────────────

/** Applies a recipe change as one history step (or into an open gesture). */
export function editRecipe(label: string, change: (r: DevelopRecipe) => DevelopRecipe) {
  const h = currentHistory();
  if (!h) return;
  const next = change(h.get());
  h.set(next, label);
}

export const beginGesture = (label: string) => currentHistory()?.begin(label);
export const endGesture = () => currentHistory()?.commit();

/** Replaces a whole recipe (paste, preset, reset, snapshot) for any asset, open or not. */
export function setRecipeFor(assetId: AssetId, recipe: DevelopRecipe, label: string) {
  const history = histories.get(assetId);
  if (history) {
    history.set(recipe, label);
    return;
  }
  const asset = getAsset(assetId);
  if (!asset) return;
  updateAsset(assetId, { develop: recipe, developRevision: asset.developRevision + 1 });
}

export function recipeFor(assetId: AssetId): DevelopRecipe | null {
  const h = histories.get(assetId);
  if (h) return h.get();
  const asset = getAsset(assetId);
  if (!asset) return null;
  const info = infoFor(assetId);
  return asset.develop ? sanitizeRecipe(asset.develop, info) : createDefaultRecipe(info);
}

export const colorInfoFor = infoFor;
