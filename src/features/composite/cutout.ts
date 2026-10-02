import { toast } from "@/app/state";
import { aiImage, describeAiStatus, selectSubject } from "@/core/ai/client";
import { runCutout } from "@/components/cutoutFx";
import { addMask, setCutout } from "@/core/develop/masks";
import { recipeFor, setRecipeFor } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { layerBounds, locate } from "@/core/document/operations";
import { composite } from "@/core/document/session";

/** Where a layer is on the viewer canvas, in its pixels (for the animation). */
function layerArea(layerId: string | undefined) {
  const engine = developEngine();
  const doc = composite.getState().doc;
  const layer = doc && layerId ? locate(doc.layers, layerId)?.layer : null;
  if (!layer) return null;
  const b = layerBounds(layer);
  const rect = engine.canvas.getBoundingClientRect();
  const sx = engine.canvas.width / Math.max(1, rect.width);
  const sy = engine.canvas.height / Math.max(1, rect.height);
  const pts = [engine.docToClient(b.x, b.y), engine.docToClient(b.x + b.width, b.y + b.height)];
  return {
    x0: (Math.min(pts[0].x, pts[1].x) - rect.left) * sx,
    y0: (Math.min(pts[0].y, pts[1].y) - rect.top) * sy,
    x1: (Math.max(pts[0].x, pts[1].x) - rect.left) * sx,
    y1: (Math.max(pts[0].y, pts[1].y) - rect.top) * sy,
  };
}

/**
 * Remove Background for a photo used in a composition: the cutout lives in the
 * photo's develop recipe, so every layer that follows the photo becomes transparent.
 */
export async function removeBackgroundFor(assetId: string, layerId?: string) {
  const engine = developEngine();
  const source = engine.ensureSource(assetId);
  if (!source) {
    toast("The photo is still loading; try again in a moment.");
    return;
  }
  try {
    const ran = await runCutout(
      engine.canvas,
      () => describeAiStatus("Finding the subject…"),
      async () => {
        const raster = await selectSubject(assetId, aiImage(engine.pipelineRef, source));
        engine.maskRenderer.putRaster(raster);
        return () => {
          // The recipe as it is when the result lands, not when the run started.
          const recipe = recipeFor(assetId);
          if (!recipe) return;
          const { recipe: withMask, mask } = addMask(recipe, { kind: "ai", target: "subject", rasterId: raster.id, feather: 0, shift: 0 }, "Background removed");
          setRecipeFor(assetId, setCutout(withMask, mask.id), "Remove Background");
          engine.invalidate();
          engine.requestRender();
        };
      },
      // The particles come from this layer, not the whole composition.
      layerArea(layerId),
    );
    if (ran) toast("Background removed. Refine it in Develop → Masks.");
  } catch (error) {
    toast(`Remove Background failed: ${error instanceof Error ? error.message : error}`, "error");
  }
}
