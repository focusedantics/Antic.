import { createStore } from "zustand/vanilla";
import { createId } from "@/lib/id";
import * as db from "./db";
import type { Asset, AssetId, Collection, CollectionId, SmartRules } from "./types";

/**
 * Catalog state: every asset record and collection, kept in memory (records are
 * a few hundred bytes; pixels are never here). Every change is written through
 * to IndexedDB in small batches.
 */
export type CatalogState = {
  readonly ready: boolean;
  readonly assets: ReadonlyMap<AssetId, Asset>;
  readonly collections: ReadonlyMap<CollectionId, Collection>;
  /** Bumped on any asset change, so derived queries can memoize cheaply. */
  readonly version: number;
};

export const catalog = createStore<CatalogState>(() => ({
  ready: false,
  assets: new Map(),
  collections: new Map(),
  version: 0,
}));

const dirty = new Set<AssetId>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  flushTimer ??= setTimeout(flush, 250);
}

export async function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const { assets } = catalog.getState();
  const batch = [...dirty].map((id) => assets.get(id)).filter((a): a is Asset => !!a);
  dirty.clear();
  await db.putAssets(batch);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flush());
}

export async function loadCatalogIntoStore() {
  const { assets, collections } = await db.loadCatalog();
  catalog.setState({
    ready: true,
    assets: new Map(assets.map((a) => [a.id, a])),
    collections: new Map(collections.map((c) => [c.id, c])),
    version: 1,
  });
}

export function getAsset(id: AssetId) {
  return catalog.getState().assets.get(id);
}

export function addAssets(list: readonly Asset[]) {
  if (!list.length) return;
  const assets = new Map(catalog.getState().assets);
  for (const a of list) {
    assets.set(a.id, a);
    dirty.add(a.id);
  }
  catalog.setState((s) => ({ assets, version: s.version + 1 }));
  scheduleFlush();
}

export function updateAssets(ids: readonly AssetId[], patch: (a: Asset) => Partial<Asset> | null) {
  const current = catalog.getState().assets;
  let assets: Map<AssetId, Asset> | null = null;
  for (const id of ids) {
    const a = current.get(id);
    if (!a) continue;
    const change = patch(a);
    if (!change) continue;
    assets ??= new Map(current);
    assets.set(id, { ...a, ...change });
    dirty.add(id);
  }
  if (!assets) return;
  catalog.setState((s) => ({ assets: assets!, version: s.version + 1 }));
  scheduleFlush();
}

export const updateAsset = (id: AssetId, patch: Partial<Asset>) => updateAssets([id], () => patch);

/** Removes photos from the catalog and deletes stored copies. Referenced files on disk are never deleted. */
export async function removeAssets(ids: readonly AssetId[]) {
  const assets = new Map(catalog.getState().assets);
  for (const id of ids) {
    assets.delete(id);
    dirty.delete(id);
  }
  catalog.setState((s) => ({ assets, version: s.version + 1 }));
  await db.deleteAssets(ids);
}

// ─── Metadata edits ───────────────────────────────────────────────────────────

export const setRating = (ids: readonly AssetId[], rating: number) =>
  updateAssets(ids, (a) => (a.rating === rating ? null : { rating: Math.max(0, Math.min(5, rating)) }));

export const setFlag = (ids: readonly AssetId[], flag: Asset["flag"]) =>
  updateAssets(ids, (a) => (a.flag === flag ? null : { flag }));

export const setLabel = (ids: readonly AssetId[], label: Asset["label"]) =>
  updateAssets(ids, (a) => ({ label: a.label === label ? null : label }));

export function addKeywords(ids: readonly AssetId[], keywords: readonly string[]) {
  const clean = keywords.map((k) => k.trim()).filter(Boolean);
  updateAssets(ids, (a) => {
    const set = new Set(a.keywords);
    let changed = false;
    for (const k of clean)
      if (![...set].some((x) => x.toLowerCase() === k.toLowerCase())) {
        set.add(k);
        changed = true;
      }
    return changed ? { keywords: [...set] } : null;
  });
}

export const removeKeyword = (ids: readonly AssetId[], keyword: string) =>
  updateAssets(ids, (a) =>
    a.keywords.includes(keyword) ? { keywords: a.keywords.filter((k) => k !== keyword) } : null,
  );

export function allKeywords() {
  const counts = new Map<string, number>();
  for (const a of catalog.getState().assets.values())
    for (const k of a.keywords) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ─── Stacks ───────────────────────────────────────────────────────────────────

export function stackAssets(ids: readonly AssetId[]) {
  if (ids.length < 2) return;
  const stackId = createId("stack");
  const order = new Map(ids.map((id, i) => [id, i]));
  updateAssets(ids, (a) => ({ stackId, stackIndex: order.get(a.id) }));
}

export function unstackAssets(ids: readonly AssetId[]) {
  const stacks = new Set(ids.map((id) => getAsset(id)?.stackId).filter(Boolean));
  const members = [...catalog.getState().assets.values()].filter((a) => a.stackId && stacks.has(a.stackId));
  updateAssets(
    members.map((a) => a.id),
    () => ({ stackId: undefined, stackIndex: undefined }),
  );
}

// ─── Collections ──────────────────────────────────────────────────────────────

export function createCollection(name: string, kind: "collection" | "smart", rules?: SmartRules) {
  const collection: Collection = {
    id: createId("col"),
    name: name.trim() || "Untitled",
    kind,
    createdAt: Date.now(),
    rules: kind === "smart" ? (rules ?? { match: "all", rules: [] }) : undefined,
  };
  catalog.setState((s) => ({ collections: new Map(s.collections).set(collection.id, collection) }));
  void db.putCollection(collection);
  return collection;
}

export function updateCollection(id: CollectionId, patch: Partial<Omit<Collection, "id">>) {
  const c = catalog.getState().collections.get(id);
  if (!c) return;
  const next = { ...c, ...patch };
  catalog.setState((s) => ({ collections: new Map(s.collections).set(id, next) }));
  void db.putCollection(next);
}

export function deleteCollection(id: CollectionId) {
  const collections = new Map(catalog.getState().collections);
  collections.delete(id);
  catalog.setState({ collections });
  void db.deleteCollection(id);
  const members = [...catalog.getState().assets.values()].filter((a) => a.collectionIds.includes(id));
  updateAssets(
    members.map((a) => a.id),
    (a) => ({ collectionIds: a.collectionIds.filter((c) => c !== id) }),
  );
}

export const addToCollection = (ids: readonly AssetId[], collectionId: CollectionId) =>
  updateAssets(ids, (a) =>
    a.collectionIds.includes(collectionId) ? null : { collectionIds: [...a.collectionIds, collectionId] },
  );

export const removeFromCollection = (ids: readonly AssetId[], collectionId: CollectionId) =>
  updateAssets(ids, (a) =>
    a.collectionIds.includes(collectionId) ? { collectionIds: a.collectionIds.filter((c) => c !== collectionId) } : null,
  );
