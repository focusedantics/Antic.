import { toast } from "@/app/state";
import { aiImage, prepareObjectSelection, selectObject, selectSemantic, selectSubject } from "@/core/ai/client";
import { putDocument, type RasterRecord } from "@/core/catalog/db";
import { getAsset } from "@/core/catalog/store";
import { pasteGroups } from "@/core/develop/operations";
import type { DevelopRecipe, MaskComponent } from "@/core/develop/recipe";
import { colorInfoFor, recipeFor, setRecipeFor } from "@/core/develop/session";
import { createDocument, flatten, imageLayer } from "@/core/document/operations";
import { composite, editDocument, openDocument, refreshDocumentList } from "@/core/document/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { fitLayers, type Look } from "@/core/looks/look";
import { editVideo } from "@/core/video/session";
import { photoSize } from "@/features/composite/actions";

export type ApplyProgress = (done: number, total: number, label: string) => void;

type AiShape = Extract<MaskComponent["shape"], { kind: "ai" }>;

async function waitForSource(assetId: string) {
  const engine = developEngine();
  for (let i = 0; i < 600; i++) {
    const source = engine.ensureSource(assetId);
    if (source) return source;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The photo took too long to load.");
}

/**
 * AI mask components carry what they selected, not pixels: run the same
 * selection on this photo. Components that can't be detected are removed so a
 * mask never uses another photo's cutout.
 */
async function redetect(assetId: string, recipe: DevelopRecipe): Promise<DevelopRecipe> {
  const ai = recipe.masks.flatMap((m) => m.components.filter((c) => c.shape.kind === "ai"));
  if (!ai.length) return recipe;
  const engine = developEngine();
  const source = await waitForSource(assetId);
  const image = aiImage(engine.pipelineRef, source);
  const found = new Map<string, RasterRecord | null>();
  let samReady = false;
  const detect = async (shape: AiShape): Promise<RasterRecord | null> => {
    const key = shape.target === "object" ? `object:${JSON.stringify(shape.points ?? [])}` : shape.target === "background" ? "subject" : shape.target;
    if (found.has(key)) return found.get(key)!;
    let raster: RasterRecord | null = null;
    try {
      if (shape.target === "sky" || shape.target === "person") raster = await selectSemantic(assetId, image, shape.target);
      else if (shape.target === "object") {
        if (!shape.points?.length) return null;
        if (!samReady) {
          await prepareObjectSelection(assetId, image);
          samReady = true;
        }
        raster = await selectObject(assetId, [...shape.points]);
      } else raster = await selectSubject(assetId, image);
      engine.maskRenderer.putRaster(raster);
    } catch (error) {
      toast(`AI mask on ${getAsset(assetId)?.fileName}: ${error instanceof Error ? error.message : error}`, "error");
    }
    found.set(key, raster);
    return raster;
  };
  const masks = [];
  for (const m of recipe.masks) {
    const components: MaskComponent[] = [];
    for (const c of m.components) {
      if (c.shape.kind !== "ai") {
        components.push(c);
        continue;
      }
      const raster = await detect(c.shape);
      if (raster) components.push({ ...c, shape: { ...c.shape, rasterId: raster.id } });
    }
    masks.push({ ...m, components });
  }
  return { ...recipe, masks };
}

/** Pastes a look's develop settings (and masks) onto one photo. */
export async function applyDevelop(assetId: string, look: Look, redetectAi: boolean) {
  const current = recipeFor(assetId);
  if (!look.develop || !current) return;
  let next = pasteGroups(current, look.develop, colorInfoFor(assetId));
  if (redetectAi) next = await redetect(assetId, next);
  setRecipeFor(assetId, next, `Look: ${look.name}`);
}

/** A new composition for the photo, with the look's layers fitted on top. */
async function composeWith(assetId: string, look: Look) {
  const size = photoSize(assetId);
  const scale = Math.min(1, 6000 / Math.max(size.width, size.height));
  const name = `${getAsset(assetId)?.fileName.replace(/\.[^.]+$/, "") ?? "Photo"} · ${look.name}`;
  const base = createDocument(Math.round(size.width * scale), Math.round(size.height * scale), name, "#ffffff");
  const photo = imageLayer(base, assetId, getAsset(assetId)?.fileName.replace(/\.[^.]+$/, "") ?? "Photo", size.width, size.height, true);
  const doc = { ...base, layers: [photo, ...fitLayers(look.layers!, base.width, base.height)] };
  await putDocument({ id: doc.id, name: doc.name, updatedAt: Date.now(), data: doc });
  return doc;
}

export async function applyLookToPhotos(look: Look, ids: readonly string[], options: { develop: boolean; layers: boolean; redetect: boolean }, progress: ApplyProgress) {
  const created = [];
  for (const [i, id] of ids.entries()) {
    const name = getAsset(id)?.fileName ?? "photo";
    progress(i, ids.length, `Applying to ${name} (${i + 1} of ${ids.length})`);
    try {
      if (options.develop && look.develop) await applyDevelop(id, look, options.redetect);
      if (options.layers && look.layers) created.push(await composeWith(id, look));
    } catch (error) {
      toast(`${name}: ${error instanceof Error ? error.message : error}`, "error");
    }
  }
  progress(ids.length, ids.length, "Done");
  developEngine().invalidate();
  developEngine().requestRender();
  if (created.length) {
    await refreshDocumentList();
    if (created.length === 1) openDocument(created[0]);
  }
  return created.length;
}

/** Adds the look's layers on top of the open composition; develop settings go to its photos. */
export async function applyLookToComposition(look: Look, options: { develop: boolean; layers: boolean; redetect: boolean }, progress: ApplyProgress) {
  const doc = composite.getState().doc;
  if (!doc) return;
  if (options.layers && look.layers) editDocument(`Look: ${look.name}`, (d) => ({ ...d, layers: [...d.layers, ...fitLayers(look.layers!, d.width, d.height)] }));
  if (options.develop && look.develop) {
    const photos = [...new Set(flatten(doc.layers).flatMap((l) => (l.kind === "image" && l.develop === "asset" ? [l.assetId] : [])))];
    for (const [i, id] of photos.entries()) {
      progress(i, photos.length, `Applying develop settings to ${getAsset(id)?.fileName ?? "photo"}`);
      await applyDevelop(id, look, options.redetect);
    }
  }
  progress(1, 1, "Done");
  developEngine().invalidate();
  developEngine().requestRender();
}

export function applyLookToVideo(look: Look) {
  if (!look.video) return;
  editVideo(`Look: ${look.name}`, (e) => ({ ...e, effect: look.video!.effect, effectMix: look.video!.effectMix }));
}
