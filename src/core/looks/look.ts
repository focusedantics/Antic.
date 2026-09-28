import { strFromU8, strToU8, unzip, zip } from "fflate";
import { type RecipeClip, recipeGroups } from "@/core/develop/operations";
import type { DevelopRecipe, Mask } from "@/core/develop/recipe";
import type { RecipeGroup } from "@/core/develop/recipe";
import type { CompositeDocument, Layer, Transform } from "@/core/document/model";
import { canvasTransform, flatten, sanitizeDocument } from "@/core/document/operations";
import { sanitizeEffect } from "@/core/effects/registry";
import type { EffectInstance } from "@/core/effects/types";
import { createId } from "@/lib/id";

/**
 * A Look is a reusable bundle of edits, saved as a `.focused` file:
 *  - develop: any groups of a develop recipe, masks included. AI mask components
 *    keep what they selected (subject, sky, people…) and are detected again on
 *    each photo the look is applied to;
 *  - layers: the non-photo layers of a composition (effects, adjustments, text,
 *    gradients, fills, shapes, groups) with their masks, blend modes and positions,
 *    relative to the canvas so they fit any photo size;
 *  - video: an effect and its strength for video clips.
 */
export type Look = {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly develop: RecipeClip | null;
  readonly layers: { readonly width: number; readonly height: number; readonly items: readonly Layer[] } | null;
  readonly video: { readonly effect: EffectInstance; readonly effectMix: number } | null;
};

export const LOOK_FORMAT = "focused-look";

const validGroups = new Set(recipeGroups.map((g) => g.id));

export function lookFromRecipe(recipe: DevelopRecipe, groups: readonly RecipeGroup[], raw: boolean): RecipeClip {
  const values: Record<string, unknown> = {};
  const kept = groups.filter((g) => validGroups.has(g));
  for (const g of kept) values[g] = structuredClone(recipe[g]);
  return { groups: kept, values: values as Partial<DevelopRecipe>, raw };
}

/** Removes photos from a layer tree (groups that end up empty are dropped). */
function withoutPhotos(layers: readonly Layer[]): Layer[] {
  return layers.flatMap((l): Layer[] => {
    if (l.kind === "image") return [];
    if (l.kind === "group") {
      const children = withoutPhotos(l.children);
      return children.length ? [{ ...l, children }] : [];
    }
    return [l];
  });
}

export function lookLayers(doc: CompositeDocument): Look["layers"] {
  const items = withoutPhotos(doc.layers);
  return items.length ? { width: doc.width, height: doc.height, items } : null;
}

/** The first (bottom-most) photo of a composition, whose develop settings a look can carry. */
export function basePhoto(doc: CompositeDocument) {
  return flatten(doc.layers).find((l) => l.kind === "image") as Extract<Layer, { kind: "image" }> | undefined;
}

export function newLook(name: string, parts: Pick<Look, "develop" | "layers" | "video">): Look {
  return { version: 1, id: createId("look"), name: name.trim() || "Untitled look", createdAt: Date.now(), ...parts };
}

export function describeLook(look: Look): string[] {
  const out: string[] = [];
  if (look.develop) {
    const masks = (look.develop.values.masks as Mask[] | undefined)?.length ?? 0;
    const adjustments = look.develop.groups.filter((g) => g !== "masks").length;
    if (adjustments) out.push(`${adjustments} develop group${adjustments === 1 ? "" : "s"}`);
    if (masks) out.push(`${masks} mask${masks === 1 ? "" : "s"}`);
  }
  if (look.layers) {
    const n = flatten(look.layers.items).filter((l) => l.kind !== "group").length;
    const fx = flatten(look.layers.items).filter((l) => l.kind === "effect").length;
    out.push(`${n} layer${n === 1 ? "" : "s"}${fx ? ` (${fx} effect${fx === 1 ? "" : "s"})` : ""}`);
  }
  if (look.video) out.push("video effect");
  return out;
}

// ─── Fitting layers to another canvas ────────────────────────────────────────

const coversCanvas = (l: Layer) => l.kind === "fill" || l.kind === "adjustment" || l.kind === "effect" || l.kind === "group";

function fitTransform(t: Transform, sx: number, sy: number, u: number): Transform {
  return {
    ...t,
    x: t.x * sx,
    y: t.y * sy,
    width: t.width * u,
    height: t.height * u,
    corners: t.corners?.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Transform["corners"],
  };
}

/**
 * The look's layers placed on a width × height canvas with fresh ids. Positions
 * scale with the canvas; sizes (text, shapes) scale uniformly so they keep their
 * proportions; canvas-wide layers (effects, adjustments, fills) cover the new canvas.
 */
export function fitLayers(look: NonNullable<Look["layers"]>, width: number, height: number): Layer[] {
  const sx = width / look.width;
  const sy = height / look.height;
  const u = Math.min(sx, sy);
  const target = { width, height };
  const fit = (l: Layer): Layer => {
    const base = { ...l, id: createId("layer") };
    const transform = coversCanvas(l) && !l.transform.corners ? { ...canvasTransform(target), rotation: l.transform.rotation } : fitTransform(l.transform, sx, sy, u);
    const mask = l.mask ? { ...l.mask, components: l.mask.components.map((c) => ({ ...c, id: createId("mc") })) } : null;
    switch (base.kind) {
      case "text":
        return { ...base, transform, mask, style: { ...base.style, size: base.style.size * u } };
      case "shape":
        return { ...base, transform, mask, style: { ...base.style, strokeWidth: base.style.strokeWidth * u, radius: base.style.radius * u } };
      case "group":
        return { ...base, transform, mask, children: base.children.map(fit) };
      default:
        return { ...base, transform, mask };
    }
  };
  return look.items.map(fit);
}

// ─── Validation and files ─────────────────────────────────────────────────────

export function sanitizeLook(v: unknown): Look {
  const l = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = l.develop && typeof l.develop === "object" ? (l.develop as Record<string, unknown>) : null;
  const groups = Array.isArray(d?.groups) ? (d!.groups as unknown[]).filter((g): g is RecipeGroup => typeof g === "string" && validGroups.has(g as RecipeGroup)) : [];
  const values = d?.values && typeof d.values === "object" ? (d.values as Partial<DevelopRecipe>) : {};
  // Develop values are validated again by sanitizeRecipe whenever the look is applied.
  const develop: RecipeClip | null = groups.length ? { groups, values: Object.fromEntries(groups.map((g) => [g, values[g]])) as Partial<DevelopRecipe>, raw: d?.raw === true } : null;
  const layersIn = l.layers && typeof l.layers === "object" ? (l.layers as Record<string, unknown>) : null;
  let layers: Look["layers"] = null;
  if (layersIn) {
    const doc = sanitizeDocument({ width: layersIn.width, height: layersIn.height, layers: layersIn.items });
    const items = withoutPhotos(doc.layers);
    if (items.length) layers = { width: doc.width, height: doc.height, items };
  }
  const videoIn = l.video && typeof l.video === "object" ? (l.video as Record<string, unknown>) : null;
  const effect = videoIn ? sanitizeEffect(videoIn.effect) : null;
  const mix = typeof videoIn?.effectMix === "number" && Number.isFinite(videoIn.effectMix) ? Math.min(1, Math.max(0, videoIn.effectMix)) : 1;
  return {
    version: 1,
    id: typeof l.id === "string" && l.id.length <= 64 ? l.id : createId("look"),
    name: typeof l.name === "string" && l.name.trim() ? l.name.slice(0, 120) : "Untitled look",
    createdAt: typeof l.createdAt === "number" ? l.createdAt : Date.now(),
    develop,
    layers,
    video: effect ? { effect, effectMix: mix } : null,
  };
}

/** A `.focused` file holding one look (a ZIP with look.json, like project files). */
export async function lookToFile(look: Look): Promise<Blob> {
  const files = { "look.json": strToU8(JSON.stringify({ format: LOOK_FORMAT, version: 1, look })) };
  const data = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));
  return new Blob([data as BlobPart], { type: "application/zip" });
}

/** Reads a `.focused` file: a look, or null when it is a project file. */
export async function readLookFile(file: Blob): Promise<Look | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(bytes, (err, data) => (err ? reject(err) : resolve(data))));
  const raw = entries["look.json"];
  if (!raw) return null;
  const json = JSON.parse(strFromU8(raw)) as { format?: string; look?: unknown };
  if (json.format !== LOOK_FORMAT) throw new Error("This .focused file isn't a Look.");
  return { ...sanitizeLook(json.look), id: createId("look") };
}
