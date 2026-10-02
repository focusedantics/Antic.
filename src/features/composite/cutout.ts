import { toast } from "@/app/state";
import { aiImage, describeAiStatus, selectSubject } from "@/core/ai/client";
import { startCutoutFx } from "@/components/cutoutFx";
import { addMask, setCutout } from "@/core/develop/masks";
import { recipeFor, setRecipeFor } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";

/**
 * Remove Background for a photo used in a composition: the cutout lives in the
 * photo's develop recipe, so every layer that follows the photo becomes transparent.
 */
export async function removeBackgroundFor(assetId: string) {
  const engine = developEngine();
  const source = engine.ensureSource(assetId);
  if (!source) {
    toast("The photo is still loading; try again in a moment.");
    return;
  }
  const fx = startCutoutFx(engine.canvas, () => describeAiStatus("Finding the subject…"));
  try {
    const raster = await selectSubject(assetId, aiImage(engine.pipelineRef, source));
    engine.maskRenderer.putRaster(raster);
    const recipe = recipeFor(assetId);
    if (!recipe) {
      fx.cancel();
      return;
    }
    const { recipe: withMask, mask } = addMask(recipe, { kind: "ai", target: "subject", rasterId: raster.id, feather: 0, shift: 0 }, "Background removed");
    await fx.reveal(() => {
      setRecipeFor(assetId, setCutout(withMask, mask.id), "Remove Background");
      engine.invalidate();
      engine.requestRender();
    });
    toast("Background removed. Refine it in Develop → Masks.");
  } catch (error) {
    fx.cancel();
    toast(`Remove Background failed: ${error instanceof Error ? error.message : error}`, "error");
  }
}
