import { createStore } from "zustand/vanilla";
import { deleteDesignAsset, type DesignAssetRecord, getDesignAsset, listDesignAssets, putDesignAsset } from "@/core/catalog/db";
import type { CompositeDocument, Gradient, Layer } from "@/core/document/model";
import { sanitizeDocument } from "@/core/document/operations";
import { createId } from "@/lib/id";

/**
 * A designer's own reusable things, kept on this device in folders: templates (whole
 * designs), elements (layer groups), palettes, gradients, brushes and fonts. Records are
 * plain data validated here whenever they are read (they may come from files).
 */
export type DesignAssetKind = "template" | "element" | "palette" | "gradient" | "brush" | "font";

export type TemplateData = { readonly document: CompositeDocument };
export type ElementData = { readonly width: number; readonly height: number; readonly layers: readonly Layer[] };
export type PaletteData = { readonly colors: readonly string[] };
export type GradientData = { readonly gradient: Gradient };
/** A brush tip image (grey: dark = paint), kept small. */
export type BrushData = { readonly tip: Blob; readonly spacing: number };
/** A font file the user imported, and the CSS family name it is registered under. */
export type FontData = { readonly family: string; readonly file: Blob; readonly format: string };

export type DesignAsset = {
  readonly id: string;
  readonly kind: DesignAssetKind;
  readonly name: string;
  readonly folder: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly data: unknown;
  readonly thumb?: Blob;
};

const KINDS = new Set<DesignAssetKind>(["template", "element", "palette", "gradient", "brush", "font"]);
const HEX = /^#[0-9a-f]{6}$/i;

/** The record's data in its proper shape, or null when it is not valid. */
export function assetData(asset: Pick<DesignAsset, "kind" | "data">): TemplateData | ElementData | PaletteData | GradientData | BrushData | FontData | null {
  const d = asset.data && typeof asset.data === "object" ? (asset.data as Record<string, unknown>) : null;
  if (!d) return null;
  switch (asset.kind) {
    case "template":
      return d.document && typeof d.document === "object" ? { document: sanitizeDocument(d.document) } : null;
    case "element": {
      const width = typeof d.width === "number" && d.width > 0 ? Math.min(30000, d.width) : 1000;
      const height = typeof d.height === "number" && d.height > 0 ? Math.min(30000, d.height) : 1000;
      const doc = sanitizeDocument({ width, height, layers: d.layers });
      return doc.layers.length ? { width: doc.width, height: doc.height, layers: doc.layers } : null;
    }
    case "palette": {
      const colors = (Array.isArray(d.colors) ? d.colors : []).filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, 256);
      return colors.length ? { colors } : null;
    }
    case "gradient": {
      const doc = sanitizeDocument({ width: 10, height: 10, layers: [{ kind: "gradient", gradient: d.gradient }] });
      const l = doc.layers[0];
      return l?.kind === "gradient" ? { gradient: l.gradient } : null;
    }
    case "brush":
      return d.tip instanceof Blob ? { tip: d.tip, spacing: typeof d.spacing === "number" ? Math.min(2, Math.max(0.02, d.spacing)) : 0.2 } : null;
    case "font":
      return d.file instanceof Blob && typeof d.family === "string" && d.family ? { file: d.file, family: d.family.slice(0, 80), format: typeof d.format === "string" ? d.format.slice(0, 20) : "" } : null;
  }
}

function fromRecord(r: DesignAssetRecord): DesignAsset | null {
  if (!KINDS.has(r.kind as DesignAssetKind)) return null;
  return {
    id: String(r.id),
    kind: r.kind as DesignAssetKind,
    name: typeof r.name === "string" && r.name ? r.name.slice(0, 120) : "Untitled",
    folder: cleanFolder(r.folder),
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now(),
    data: r.data,
    thumb: r.thumb instanceof Blob ? r.thumb : undefined,
  };
}

/** Folder names: trimmed, no slashes at the ends, at most 80 characters ("" is the top level). */
export const cleanFolder = (v: unknown) =>
  typeof v === "string"
    ? v
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("/")
        .slice(0, 80)
    : "";

/** Every asset, loaded once and kept current. */
export const designAssets = createStore<{ loaded: boolean; items: readonly DesignAsset[] }>(() => ({ loaded: false, items: [] }));

let loading: Promise<void> | null = null;
export function loadDesignAssets(force = false) {
  if (loading && !force) return loading;
  loading = listDesignAssets()
    .then((records) => {
      const items = records.map(fromRecord).filter((a): a is DesignAsset => !!a && !!assetData(a));
      designAssets.setState({ loaded: true, items: items.sort((a, b) => b.updatedAt - a.updatedAt) });
    })
    .catch(() => designAssets.setState({ loaded: true }));
  return loading;
}

export async function saveDesignAsset(kind: DesignAssetKind, name: string, data: unknown, options: { folder?: string; thumb?: Blob; id?: string } = {}): Promise<DesignAsset> {
  const now = Date.now();
  const existing = options.id ? designAssets.getState().items.find((a) => a.id === options.id) : undefined;
  const asset: DesignAsset = {
    id: options.id ?? createId(kind),
    kind,
    name: name.trim().slice(0, 120) || "Untitled",
    folder: cleanFolder(options.folder ?? existing?.folder ?? ""),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    data,
    thumb: options.thumb ?? existing?.thumb,
  };
  if (!assetData(asset)) throw new Error(`Not a valid ${kind}.`);
  await putDesignAsset(asset);
  designAssets.setState((s) => ({ items: [asset, ...s.items.filter((a) => a.id !== asset.id)] }));
  return asset;
}

/** Renames or moves an asset (to `folder`). */
export async function updateDesignAsset(id: string, patch: { name?: string; folder?: string }) {
  const record = await getDesignAsset(id);
  if (!record) return;
  const next = { ...record, ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || record.name } : {}), ...(patch.folder !== undefined ? { folder: cleanFolder(patch.folder) } : {}), updatedAt: Date.now() };
  await putDesignAsset(next);
  const asset = fromRecord(next);
  if (asset) designAssets.setState((s) => ({ items: s.items.map((a) => (a.id === id ? asset : a)) }));
}

export async function removeDesignAsset(id: string) {
  await deleteDesignAsset(id);
  designAssets.setState((s) => ({ items: s.items.filter((a) => a.id !== id) }));
}

/** Folders in use for one kind, sorted (the top level is ""). */
export const foldersOf = (items: readonly DesignAsset[], kind: DesignAssetKind) => [...new Set(items.filter((a) => a.kind === kind).map((a) => a.folder))].sort((a, b) => a.localeCompare(b));
