import { createStore } from "zustand/vanilla";
import { toast } from "@/app/state";
import type { MenuItem } from "@/components/Menu";
import { aiImage, describeAiStatus, objectSelectionReady, prepareObjectSelection, selectObject, selectSemantic, selectSubject } from "@/core/ai/client";
import { runCutout } from "@/components/cutoutFx";
import type { RasterRecord } from "@/core/catalog/db";
import { addComponent, addMask, aiTargetLabels, newComponent, setCutout, updateComponent, updateMask } from "@/core/develop/masks";
import type { MaskOperation, MaskShape } from "@/core/develop/recipe";
import { develop, editRecipe, recipeFor, setRecipeFor } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";

type Target = keyof typeof aiTargetLabels;

function currentSource() {
  const { assetId } = develop.getState();
  const engine = developEngine();
  const source = assetId ? engine.sourceFor(assetId) : null;
  if (!assetId || !source) throw new Error("Wait for the photo to finish loading.");
  return { assetId, source, engine };
}

function aiShape(target: Target, raster: RasterRecord, points?: MaskShape extends infer S ? (S extends { kind: "ai"; points?: infer P } ? P : never) : never): MaskShape {
  return { kind: "ai", target, rasterId: raster.id, points, feather: 0, shift: 0 };
}

/** Runs a detection and returns the stored raster. Background = inverted subject. */
async function detect(target: Exclude<Target, "object">): Promise<RasterRecord> {
  const { assetId, source, engine } = currentSource();
  const image = aiImage(engine.pipelineRef, source);
  const raster = target === "sky" || target === "person" ? await selectSemantic(assetId, image, target) : await selectSubject(assetId, image);
  engine.maskRenderer.putRaster(raster);
  return raster;
}

function reportError(error: unknown) {
  toast(`AI selection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
}

/** Creates a new mask from an AI selection, or adds it to `maskId` with `operation`. */
export async function aiSelect(target: Exclude<Target, "object">, maskId: string | null, operation: MaskOperation) {
  try {
    const raster = await detect(target);
    const component = { ...newComponent(aiShape(target, raster), operation), invert: target === "background" };
    const label = `Select ${aiTargetLabels[target]}`;
    if (maskId) {
      editRecipe(label, (r) => addComponent(r, maskId, component));
      develop.setState({ activeComponentId: component.id });
    } else {
      editRecipe(label, (r) => {
        const { recipe, mask } = addMask(r, component.shape, aiTargetLabels[target]);
        const fixed = updateMask(recipe, mask.id, (m) => ({ ...m, components: [{ ...m.components[0], invert: target === "background" }] }));
        queueMicrotask(() => develop.setState({ activeMaskId: mask.id, activeComponentId: mask.components[0].id, tool: "mask" }));
        return fixed;
      });
    }
  } catch (error) {
    reportError(error);
  }
}

/**
 * Remove Background: a subject mask used as the photo's transparency. Refine it
 * with Add/Subtract brushes (restore/erase) and the AI edge controls.
 */
export async function removeBackground() {
  // The globe turns while the AI works (however long), then the background blows away.
  // One run at a time; the result always lands on the photo it was started on.
  const assetId = develop.getState().assetId;
  try {
    const ran = await runCutout(
      developEngine().canvas,
      () => describeAiStatus("Finding the subject…"),
      async () => {
        const raster = await detect("subject");
        return () => {
          if (develop.getState().assetId === assetId) {
            editRecipe("Remove Background", (r) => {
              const { recipe, mask } = addMask(r, aiShape("subject", raster), "Background removed");
              queueMicrotask(() => develop.setState({ activeMaskId: mask.id, activeComponentId: mask.components[0].id, tool: "mask", maskOverlay: false }));
              return setCutout(recipe, mask.id);
            });
            return;
          }
          // Another photo is open now: apply it to the one that was analysed.
          const base = assetId ? recipeFor(assetId) : null;
          if (!assetId || !base) return;
          const { recipe, mask } = addMask(base, aiShape("subject", raster), "Background removed");
          setRecipeFor(assetId, setCutout(recipe, mask.id), "Remove Background");
        };
      },
    );
    if (ran) toast("Background removed. Add a brush to restore, subtract a brush to erase.");
  } catch (error) {
    reportError(error);
  }
}

/** Starts click-to-select: the first click on the photo creates the object component. */
export async function startObjectSelection(maskId: string | null, operation: MaskOperation) {
  try {
    const { assetId, source, engine } = currentSource();
    await prepareObjectSelection(assetId, aiImage(engine.pipelineRef, source));
    develop.setState({ tool: "mask" });
    objectSelection.setState({ pending: { maskId, operation } });
    toast("Click the object. Alt-click excludes an area; click again to add more.");
  } catch (error) {
    reportError(error);
  }
}

/** Object selection waiting for its first click. */
export const objectSelection = createStore<{ pending: { maskId: string | null; operation: MaskOperation } | null }>(() => ({ pending: null }));

/** A click on the photo while object selection is active (source uv). */
export async function objectClick(x: number, y: number, positive: boolean) {
  const { recipe, activeMaskId, activeComponentId, assetId } = develop.getState();
  if (!recipe || !assetId) return;
  const mask = recipe.masks.find((m) => m.id === activeMaskId);
  const component = mask?.components.find((c) => c.id === activeComponentId);
  const existing = component?.shape.kind === "ai" && component.shape.target === "object" ? component : null;
  const points = [...(existing && existing.shape.kind === "ai" ? (existing.shape.points ?? []) : []), { x, y, positive }];
  try {
    const pendingObject = objectSelection.getState().pending;
    // The analysis is redone when the AI worker was ended while idle (phones free it quickly).
    if (!objectSelectionReady(assetId)) {
      const { source, engine } = currentSource();
      await prepareObjectSelection(assetId, aiImage(engine.pipelineRef, source));
    }
    const raster = await selectObject(assetId, points);
    developEngine().maskRenderer.putRaster(raster);
    if (existing && mask) {
      editRecipe("Refine object", (r) => updateComponent(r, mask.id, existing.id, (c) => ({ ...c, shape: aiShape("object", raster, points) })));
      return;
    }
    const target = pendingObject ?? { maskId: null, operation: "add" as MaskOperation };
    objectSelection.setState({ pending: null });
    const created = newComponent(aiShape("object", raster, points), target.operation);
    if (target.maskId) {
      editRecipe("Select Object", (r) => addComponent(r, target.maskId!, created));
      develop.setState({ activeComponentId: created.id });
    } else {
      editRecipe("Select Object", (r) => {
        const { recipe: next, mask: m } = addMask(r, created.shape, "Object");
        queueMicrotask(() => develop.setState({ activeMaskId: m.id, activeComponentId: m.components[0].id }));
        return next;
      });
    }
  } catch (error) {
    reportError(error);
  }
}

export function aiMenuItems(maskId: string | null, operation: MaskOperation): MenuItem[] {
  const select = (t: Exclude<Target, "object">) => () => void aiSelect(t, maskId, operation);
  return [
    { label: "Select Subject", onSelect: select("subject") },
    { label: "Select Sky", onSelect: select("sky") },
    { label: "Select People", onSelect: select("person") },
    { label: "Select Background", onSelect: select("background") },
    { label: "Select Object (click)…", onSelect: () => void startObjectSelection(maskId, operation) },
  ];
}
