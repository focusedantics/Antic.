import { toast, ui } from "@/app/state";
import { getAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { develop, openInDevelop, sourceDecoded } from "@/core/develop/session";
import { loadPreviewSource, loadSource } from "@/core/develop/source-loader";
import { developEngine } from "@/core/gpu/develop-engine";

let controller: AbortController | null = null;

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
    const loaded = await loadSource(asset, abort.signal);
    if (abort.signal.aborted) return;
    engine.setSource(assetId, loaded, loaded.quality);
    sourceDecoded(assetId, loaded.info, loaded.quality, { width: loaded.data.width, height: loaded.data.height });
  } catch (error) {
    if (abort.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    develop.setState({ loading: false, error: message });
    if (ui.getState().workspace === "develop") toast(message, "error");
  }
}
