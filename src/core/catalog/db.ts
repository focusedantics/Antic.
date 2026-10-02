import { appleTouch } from "@/lib/device";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { RecipeClip } from "@/core/develop/operations";
import type { DevelopRecipe } from "@/core/develop/recipe";
import type { Asset, AssetId, Collection } from "./types";

/**
 * The local catalog. Records are small and loaded eagerly; pixels (originals,
 * previews, mask rasters) live in their own stores and are read on demand, so
 * a catalog of thousands of photos opens instantly.
 */
export type ThumbRecord = {
  readonly thumb?: Blob;
  readonly preview?: Blob;
  readonly previewSource: "embedded" | "decoded" | "developed" | "none";
  /** Develop revision the thumbnail was rendered from; -1 for the unedited rendering. */
  readonly revision: number;
};

export type RasterRecord = {
  readonly id: string;
  readonly assetId?: AssetId;
  readonly width: number;
  readonly height: number;
  /** 8-bit coverage, one byte per pixel, row-major. */
  readonly data: Uint8Array;
  readonly createdAt: number;
};

export type PresetRecord = {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly createdAt: number;
  readonly clip: RecipeClip;
};

export type SnapshotRecord = {
  readonly id: string;
  readonly assetId: AssetId;
  readonly name: string;
  readonly createdAt: number;
  readonly recipe: DevelopRecipe;
};

/** A video clip and its (non-destructive) edit. The file itself lives in `videoFiles`. */
export type VideoRecord = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly byteSize: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly poster?: Blob;
  /** Serialized edit (see core/video/model); sanitized on load. */
  readonly edit: unknown;
};

export type DocumentRecord = {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  /** Serialized composite document (see core/document). */
  readonly data: unknown;
  readonly thumb?: Blob;
};

interface FocusedDB extends DBSchema {
  assets: { key: string; value: Asset; indexes: { fingerprint: string } };
  collections: { key: string; value: Collection };
  originals: { key: string; value: Blob | StoredBytes };
  thumbs: { key: string; value: ThumbRecord };
  rasters: { key: string; value: RasterRecord; indexes: { assetId: string } };
  presets: { key: string; value: PresetRecord };
  snapshots: { key: string; value: SnapshotRecord; indexes: { assetId: string } };
  documents: { key: string; value: DocumentRecord };
  settings: { key: string; value: unknown };
  videos: { key: string; value: VideoRecord };
  videoFiles: { key: string; value: Blob | StoredBytes };
  looks: { key: string; value: unknown };
}

const DB_NAME = "focused-catalog";
const DB_VERSION = 3;
let dbPromise: Promise<IDBPDatabase<FocusedDB>> | null = null;

export function catalogDb() {
  dbPromise ??= openDB<FocusedDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) createCatalogStores(db);
      if (oldVersion < 2) {
        db.createObjectStore("videos", { keyPath: "id" });
        db.createObjectStore("videoFiles");
      }
      if (oldVersion < 3) db.createObjectStore("looks", { keyPath: "id" });
    },
    blocking() {
      // Another tab upgraded the schema: release the connection so it can proceed.
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

function createCatalogStores(db: IDBPDatabase<FocusedDB>) {
  const assets = db.createObjectStore("assets", { keyPath: "id" });
  assets.createIndex("fingerprint", "fingerprint");
  db.createObjectStore("collections", { keyPath: "id" });
  db.createObjectStore("originals");
  db.createObjectStore("thumbs");
  const rasters = db.createObjectStore("rasters", { keyPath: "id" });
  rasters.createIndex("assetId", "assetId");
  db.createObjectStore("presets", { keyPath: "id" });
  const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
  snapshots.createIndex("assetId", "assetId");
  db.createObjectStore("documents", { keyPath: "id" });
  db.createObjectStore("settings");
}

export async function loadCatalog() {
  const db = await catalogDb();
  const [assets, collections] = await Promise.all([db.getAll("assets"), db.getAll("collections")]);
  return { assets, collections };
}

export async function putAssets(assets: readonly Asset[]) {
  if (!assets.length) return;
  const db = await catalogDb();
  const tx = db.transaction("assets", "readwrite");
  await Promise.all([...assets.map((a) => tx.store.put(a)), tx.done]);
}

export async function deleteAssets(ids: readonly AssetId[]) {
  const db = await catalogDb();
  const tx = db.transaction(["assets", "originals", "thumbs", "rasters", "snapshots"], "readwrite");
  for (const id of ids) {
    void tx.objectStore("assets").delete(id);
    void tx.objectStore("originals").delete(id);
    void tx.objectStore("thumbs").delete(id);
    for (const key of await tx.objectStore("rasters").index("assetId").getAllKeys(id))
      void tx.objectStore("rasters").delete(key);
    for (const key of await tx.objectStore("snapshots").index("assetId").getAllKeys(id))
      void tx.objectStore("snapshots").delete(key);
  }
  await tx.done;
}

export async function putCollection(collection: Collection) {
  await (await catalogDb()).put("collections", collection);
}

export async function deleteCollection(id: string) {
  await (await catalogDb()).delete("collections", id);
}

export async function findByFingerprint(fingerprint: string) {
  return (await catalogDb()).getFromIndex("assets", "fingerprint", fingerprint);
}

/**
 * A file kept as plain bytes. iOS Safari (every browser on iPhone and iPad) can
 * refuse to store a File from the photo picker ("Error preparing Blob/File data
 * to be stored"), and has lost such Blobs after a reload; an ArrayBuffer always
 * stores and reads back.
 */
export type StoredBytes = { readonly bytes: ArrayBuffer; readonly type: string };

const toBytes = async (blob: Blob): Promise<StoredBytes> => ({ bytes: await blob.arrayBuffer(), type: blob.type });
const toBlob = (v: Blob | StoredBytes | undefined): Blob | undefined => (!v ? undefined : v instanceof Blob ? v : new Blob([v.bytes], { type: v.type }));

/** Largest file copied into memory to store it as bytes (videos can be gigabytes). */
const BYTES_LIMIT = 600e6;

export async function putOriginal(id: AssetId, blob: Blob) {
  const db = await catalogDb();
  // On iPhone and iPad, photos go in as bytes from the start; elsewhere only when a Blob is refused.
  if (appleTouch() && blob.size <= BYTES_LIMIT) return void (await db.put("originals", await toBytes(blob), id));
  try {
    await db.put("originals", blob, id);
  } catch (error) {
    if (blob.size > BYTES_LIMIT) throw error;
    await db.put("originals", await toBytes(blob), id);
  }
}

export async function getStoredOriginal(id: AssetId): Promise<Blob | undefined> {
  return toBlob(await (await catalogDb()).get("originals", id));
}

export async function putThumb(id: AssetId, record: ThumbRecord) {
  await (await catalogDb()).put("thumbs", record, id);
}

export async function getThumb(id: AssetId) {
  return (await catalogDb()).get("thumbs", id);
}

export async function putRaster(record: RasterRecord) {
  await (await catalogDb()).put("rasters", record);
}

export async function getRaster(id: string) {
  return (await catalogDb()).get("rasters", id);
}

export async function listPresets() {
  return (await catalogDb()).getAll("presets");
}
export async function putPreset(p: PresetRecord) {
  await (await catalogDb()).put("presets", p);
}
export async function deletePreset(id: string) {
  await (await catalogDb()).delete("presets", id);
}

export async function listSnapshots(assetId: AssetId) {
  return (await catalogDb()).getAllFromIndex("snapshots", "assetId", assetId);
}
export async function putSnapshot(s: SnapshotRecord) {
  await (await catalogDb()).put("snapshots", s);
}
export async function deleteSnapshot(id: string) {
  await (await catalogDb()).delete("snapshots", id);
}

export async function listDocuments() {
  return (await catalogDb()).getAll("documents");
}
export async function getDocument(id: string) {
  return (await catalogDb()).get("documents", id);
}
export async function putDocument(d: DocumentRecord) {
  await (await catalogDb()).put("documents", d);
}
export async function deleteDocument(id: string) {
  await (await catalogDb()).delete("documents", id);
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await (await catalogDb()).get("settings", key)) as T | undefined;
}
export async function putSetting(key: string, value: unknown) {
  await (await catalogDb()).put("settings", value, key);
}

export async function listVideos() {
  return (await catalogDb()).getAll("videos");
}
export async function getVideo(id: string) {
  return (await catalogDb()).get("videos", id);
}
export async function putVideo(record: VideoRecord, file?: Blob) {
  const db = await catalogDb();
  const write = async (value?: Blob | StoredBytes) => {
    const tx = db.transaction(["videos", "videoFiles"], "readwrite");
    await tx.objectStore("videos").put(record);
    if (value) await tx.objectStore("videoFiles").put(value, record.id);
    await tx.done;
  };
  try {
    await write(file);
  } catch (error) {
    // iOS can refuse picker files as Blobs (see StoredBytes); store the bytes when they fit in memory.
    if (!file || file.size > BYTES_LIMIT) throw error;
    await write(await toBytes(file));
  }
}
export async function getVideoFile(id: string): Promise<Blob | undefined> {
  return toBlob(await (await catalogDb()).get("videoFiles", id));
}
export async function deleteVideo(id: string) {
  const db = await catalogDb();
  const tx = db.transaction(["videos", "videoFiles"], "readwrite");
  await tx.objectStore("videos").delete(id);
  await tx.objectStore("videoFiles").delete(id);
  await tx.done;
}

/** Saved looks (validated by core/looks when read). */
export async function listLooks(): Promise<unknown[]> {
  return (await catalogDb()).getAll("looks");
}
export async function putLook(look: { id: string }) {
  await (await catalogDb()).put("looks", look);
}
export async function deleteLook(id: string) {
  await (await catalogDb()).delete("looks", id);
}
