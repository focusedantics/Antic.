import { toast, ui } from "@/app/state";
import { getAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { develop, openInDevelop, sourceDecoded } from "@/core/develop/session";
import { type LoadedSource, loadPreviewSource, loadSource } from "@/core/develop/source-loader";
import { developEngine } from "@/core/gpu/develop-engine";
import { fullSizeOf } from "@/core/gpu/pipeline";
import { device } from "@/lib/device";

let controller: AbortController | null = null;

// ─── Preloading the neighbours ──────────────────────────────────────────────

type Prefetch = { promise: Promise<LoadedSource>; abort: AbortController };
const prefetches = new Map<AssetId, Prefetch>();
let previousOpen: AssetId | null = null;
let direction = 1;

/**
 * Decodes the photos beside the open one ahead of time, so swiping or stepping to
 * them is instant. Computers keep both neighbours; phones and tablets (tight memory)
 * keep only the one in the direction the user is moving, and never a RAW (whose
 * decoded data alone can be hundreds of MB). One decode at a time, in the background;
 * a neighbour that stops being one is cancelled and freed.
 */
export function prefetchNeighbours(order: readonly AssetId[], open: AssetId) {
  const i = order.indexOf(open);
  if (i < 0) return;
  const before = previousOpen ? order.indexOf(previousOpen) : -1;
  if (before >= 0 && before !== i) direction = i > before ? 1 : -1;
  previousOpen = open;
  const candidates = device.lite ? [order[i + direction]] : [order[i + 1], order[i - 1]];
  const wanted = candidates.filter((id): id is AssetId => {
    const asset = id ? getAsset(id) : undefined;
    return !!asset && asset.thumbState !== "error" && (!device.lite || asset.kind !== "raw");
  });
  const engine = developEngine();
  engine.setWarm(wanted);
  for (const [id, p] of prefetches)
    if (!wanted.includes(id) && id !== open) {
      p.abort.abort();
      prefetches.delete(id);
    }
  void (async () => {
    for (const id of wanted) {
      if (!engine.isWarm(id) || prefetches.has(id) || (engine.hasSource(id) && !engine.hasSource(id, "preview"))) continue;
      const asset = getAsset(id);
      if (!asset) continue;
      const abort = new AbortController();
      const promise = loadSource(asset, abort.signal, true);
      prefetches.set(id, { promise, abort });
      try {
        const loaded = await promise;
        if (!abort.signal.aborted && prefetches.get(id)?.promise === promise) engine.preloadSource(id, loaded, loaded.quality);
      } catch {
        // Cancelled or unreadable: it loads normally when opened.
      } finally {
        if (prefetches.get(id)?.promise === promise) prefetches.delete(id);
      }
    }
  })();
}

/** Leaving Develop: cancel preloads and free the neighbours. */
export function stopPrefetching() {
  for (const p of prefetches.values()) p.abort.abort();
  prefetches.clear();
  previousOpen = null;
  developEngine().setWarm([]);
  developEngine().relax();
}

/** A preload already running for this photo, taken over by opening it (so it is not decoded twice). */
function adoptPrefetch(id: AssetId): Prefetch | null {
  const p = prefetches.get(id) ?? null;
  prefetches.delete(id);
  return p;
}

/**
 * Opens a photo in Develop: the catalog preview appears at once, then the
 * original decodes (RAW through LibRaw) and replaces it.
 */
export async function showInDevelop(assetId: AssetId) {
  const engine = developEngine();
  const previous = develop.getState().assetId;
  if (previous && previous !== assetId) void engine.refreshThumbnails(previous);
  openInDevelop(assetId);
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  const asset = getAsset(assetId);
  if (!asset) return;
  if (engine.hasSource(assetId) && !engine.hasSource(assetId, "preview")) {
    const src = engine.sourceFor(assetId)!;
    sourceDecoded(assetId, src.info, asset.kind === "raw" ? "raw" : "rendered", src.size);
    engine.requestRender();
    return;
  }
  try {
    if (!engine.hasSource(assetId)) {
      const preview = await loadPreviewSource(asset);
      if (abort.signal.aborted) return;
      if (preview) {
        engine.setSource(assetId, preview, "preview");
        develop.setState({ source: "preview" });
      }
    }
    // A neighbour being preloaded: wait for that decode instead of starting another.
    const adopted = adoptPrefetch(assetId);
    if (adopted) abort.signal.addEventListener("abort", () => adopted.abort.abort());
    const loaded = adopted ? await adopted.promise : await loadSource(asset, abort.signal);
    if (abort.signal.aborted) return;
    engine.setSource(assetId, loaded, loaded.quality);
    sourceDecoded(assetId, loaded.info, loaded.quality, fullSizeOf(loaded.data));
  } catch (error) {
    if (abort.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    develop.setState({ loading: false, error: message });
    if (ui.getState().workspace === "develop") toast(message, "error");
  }
}
