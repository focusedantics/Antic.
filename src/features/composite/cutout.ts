import { toast } from "@/app/state";
import { aiImage, describeAiStatus, selectSubject } from "@/core/ai/client";
import { runCutout } from "@/components/cutoutFx";
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
    );
    if (ran) toast("Background removed. Refine it in Develop → Masks.");
  } catch (error) {
    toast(`Remove Background failed: ${error instanceof Error ? error.message : error}`, "error");
  }
}
