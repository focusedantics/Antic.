import { strFromU8, strToU8, unzip, zip } from "fflate";
import { getRaster, putRaster, type RasterRecord } from "@/core/catalog/db";
import { importItems } from "@/core/catalog/import";
import { readOriginal } from "@/core/catalog/originals";
import { catalog, getAsset } from "@/core/catalog/store";
import type { Asset } from "@/core/catalog/types";
import { sanitizeRecipe } from "@/core/develop/operations";
import type { DevelopRecipe } from "@/core/develop/recipe";
import { recipeFor } from "@/core/develop/session";
import { createId } from "@/lib/id";
import type { CompositeDocument, Layer } from "./model";
import { documentAssets, flatten, sanitizeDocument } from "./operations";

/**
 * `.focused` project files: a ZIP with
 *   project.json          document, and per photo: file name, fingerprint, recipe, EXIF
 *   rasters/<id>.bin      AI mask coverage (8-bit) referenced by recipes
 *   originals/<id>/<name> the original files (only when "include originals" is chosen)
 * Opening a project finds photos already in the library by content fingerprint,
 * imports included originals otherwise, and restores every recipe exactly.
 */
const FORMAT = "focused-project";

type ProjectAsset = {
  id: string;
  fileName: string;
  fingerprint: string;
  recipe: DevelopRecipe | null;
  asset: Pick<Asset, "exif" | "captureTime" | "rating" | "flag" | "label" | "keywords" | "width" | "height">;
  original?: string;
};

type ProjectJson = {
  format: typeof FORMAT;
  version: 1;
  savedAt: number;
  document: CompositeDocument;
  assets: ProjectAsset[];
  rasters: { id: string; width: number; height: number }[];
};

const rasterIds = (recipe: DevelopRecipe | null, layers: readonly Layer[]) => {
  const ids = new Set<string>();
  for (const m of recipe?.masks ?? []) for (const c of m.components) if (c.shape.kind === "ai") ids.add(c.shape.rasterId);
  for (const l of layers) for (const c of l.mask?.components ?? []) if (c.shape.kind === "ai") ids.add(c.shape.rasterId);
  return ids;
};

export async function saveProject(doc: CompositeDocument, options: { includeOriginals: boolean }): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const layers = flatten(doc.layers);
  const assetIds = documentAssets(layers);
  const assets: ProjectAsset[] = [];
  const rasters = new Set<string>(rasterIds(null, layers));
  for (const id of assetIds) {
    const asset = getAsset(id);
    if (!asset) continue;
    const recipe = recipeFor(id);
    for (const r of rasterIds(recipe, [])) rasters.add(r);
    for (const l of layers) if (l.kind === "image" && l.develop !== "asset") for (const r of rasterIds(l.develop, [])) rasters.add(r);
    const entry: ProjectAsset = {
      id,
      fileName: asset.fileName,
      fingerprint: asset.fingerprint,
      recipe,
      asset: { exif: asset.exif, captureTime: asset.captureTime, rating: asset.rating, flag: asset.flag, label: asset.label, keywords: asset.keywords, width: asset.width, height: asset.height },
    };
    if (options.includeOriginals) {
      const blob = await readOriginal(asset);
      entry.original = `originals/${id}/${asset.fileName}`;
      files[entry.original] = new Uint8Array(await blob.arrayBuffer());
    }
    assets.push(entry);
  }
  const rasterMeta: ProjectJson["rasters"] = [];
  for (const id of rasters) {
    const r = await getRaster(id);
    if (!r) continue;
    files[`rasters/${id}.bin`] = r.data;
    rasterMeta.push({ id, width: r.width, height: r.height });
  }
  const json: ProjectJson = { format: FORMAT, version: 1, savedAt: Date.now(), document: doc, assets, rasters: rasterMeta };
  files["project.json"] = strToU8(JSON.stringify(json));
  const zipped = await new Promise<Uint8Array>((resolve, reject) =>
    // Photos are already compressed; store them as-is.
    zip(files, { level: 6, mem: 8 }, (err, data) => (err ? reject(err) : resolve(data))),
  );
  return new Blob([zipped as BlobPart], { type: "application/zip" });
}

export type OpenedProject = { document: CompositeDocument; missing: string[] };

export async function openProject(file: Blob): Promise<OpenedProject> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(bytes, (err, data) => (err ? reject(err) : resolve(data))));
  const raw = entries["project.json"];
  if (!raw) throw new Error("Not a Focused project: project.json is missing.");
  const json = JSON.parse(strFromU8(raw)) as Partial<ProjectJson>;
  if (json.format !== FORMAT) throw new Error("Not a Focused project file.");

  // Rasters keep their ids: recipes reference them.
  for (const r of json.rasters ?? []) {
    const data = entries[`rasters/${r.id}.bin`];
    if (data && data.length === r.width * r.height) {
      const record: RasterRecord = { id: r.id, width: r.width, height: r.height, data, createdAt: Date.now() };
      await putRaster(record);
    }
  }

  // Map project photos onto library photos (by fingerprint), importing included originals.
  const idMap = new Map<string, string>();
  const missing: string[] = [];
  const byFingerprint = () => new Map([...catalog.getState().assets.values()].map((a) => [a.fingerprint, a.id]));
  let known = byFingerprint();
  const toImport = (json.assets ?? []).filter((a) => !known.has(a.fingerprint) && a.original && entries[a.original]);
  if (toImport.length) {
    await importItems(toImport.map((a) => ({ file: new File([entries[a.original!] as BlobPart], a.fileName), folder: "" })));
    known = byFingerprint();
  }
  for (const a of json.assets ?? []) {
    const local = known.get(a.fingerprint);
    if (local) idMap.set(a.id, local);
    else missing.push(a.fileName);
  }

  // Image layers carry the project's recipe, so the composition looks exactly as saved
  // even when the library copy of the photo has since been edited differently.
  const recipes = new Map((json.assets ?? []).map((a) => [a.id, a.recipe]));
  const remap = (layer: Layer): Layer | null => {
    if (layer.kind === "group") return { ...layer, children: layer.children.map(remap).filter((l): l is Layer => !!l) };
    // A frame keeps its place without its photo when the photo is missing.
    if (layer.kind === "slot") return layer.assetId ? { ...layer, assetId: idMap.get(layer.assetId) ?? null } : layer;
    if (layer.kind !== "image") return layer;
    const local = idMap.get(layer.assetId);
    if (!local) return null;
    const saved = layer.develop === "asset" ? recipes.get(layer.assetId) : layer.develop;
    const libraryRecipe = recipeFor(local);
    const same = saved && libraryRecipe && JSON.stringify(saved) === JSON.stringify(libraryRecipe);
    const kind = getAsset(local)?.kind;
    return { ...layer, assetId: local, develop: !saved || same ? "asset" : sanitizeRecipe(saved, { raw: kind === "raw", asShot: getAsset(local)?.asShot }) };
  };
  const doc = sanitizeDocument(json.document);
  const document: CompositeDocument = { ...doc, id: createId("doc"), layers: doc.layers.map(remap).filter((l): l is Layer => !!l) };
  return { document, missing };
}
