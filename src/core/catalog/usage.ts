import { catalogDb } from "./db";

/**
 * What the app keeps on this device, by category.
 *
 * Browsers only report one total (`navigator.storage.estimate()`; Chromium's per-kind
 * breakdown says "IndexedDB", not "previews", and Safari gives none), so the sizes are
 * counted here: Blobs and file references by their recorded size (nothing is read), small
 * records by walking them. Two stores can only be sized by reading each value: mask rasters
 * (raw bytes inside the record) are read one at a time, and originals are taken from their
 * photo's recorded file size instead, so a library of large RAWs is never loaded to be measured.
 */
export type UsageId = "originals" | "videos" | "previews" | "thumbnails" | "designs" | "compositions" | "masks" | "things" | "models" | "records" | "leftover";

export type UsageRow = { readonly id: UsageId; readonly bytes: number; readonly count: number };

/** One of the biggest things kept: what to look at first when space runs short. */
export type BigItem = { readonly kind: "photo" | "video" | "design" | "composition"; readonly id: string; readonly name: string; readonly bytes: number };

export type Usage = {
  readonly rows: readonly UsageRow[];
  /** The sum of the rows. */
  readonly counted: number;
  /** The browser's own figures for this site, where it gives them. */
  readonly browser: { readonly usage: number; readonly quota: number } | null;
  /** Whether the browser promised not to clear this site's data to make room; null: unknown. */
  readonly persisted: boolean | null;
  /** Photos read from a folder on this computer: their originals take no space here. */
  readonly linked: number;
  readonly largest: readonly BigItem[];
  /** Files in the private file system that nothing refers to (see `removeLeftoverFiles`). */
  readonly leftover: readonly string[];
};

/** The order categories are listed in, largest kinds of thing first. */
export const USAGE_ORDER: readonly UsageId[] = ["originals", "videos", "previews", "thumbnails", "designs", "compositions", "masks", "things", "models", "records", "leftover"];

/**
 * About how many bytes a stored value takes: Blobs and buffers exactly, text as one byte
 * a character (most of it is ASCII), numbers as eight. Good to a few percent for records;
 * it is the Blobs and buffers that matter.
 */
export function byteSizeOf(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  switch (typeof value) {
    case "string":
      return value.length;
    case "number":
      return 8;
    case "boolean":
      return 1;
    case "bigint":
      return 8;
    case "object":
      break;
    default:
      return 0;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Date) return 8;
  // A reference to a file kept elsewhere (file-store.ts): the file is counted where it is used.
  if (depth > 32) return 0;
  let sum = 0;
  if (Array.isArray(value)) {
    for (const v of value) sum += byteSizeOf(v, depth + 1);
    return sum;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) sum += byteSizeOf(k, depth + 1) + byteSizeOf(v, depth + 1);
    return sum;
  }
  if (value instanceof Set) {
    for (const v of value) sum += byteSizeOf(v, depth + 1);
    return sum;
  }
  // File handles and other platform objects have no enumerable data of their own.
  for (const key in value as Record<string, unknown>) sum += key.length + byteSizeOf((value as Record<string, unknown>)[key], depth + 1);
  return sum;
}

/** The private file system's names for a stored original and a stored clip (see db.ts `storable`). */
const originalFile = (id: string) => `original-${id}`;
const videoFile = (id: string) => `video-${id}`;

/** A leftover file is only called that once it is this old: an import in progress writes the file before its record. */
const LEFTOVER_AGE_MS = 10 * 60_000;

export type MeasureOptions = {
  /** The photos of the catalog (their recorded file sizes stand for their stored originals). */
  readonly assets: Iterable<{ readonly id: string; readonly fileName: string; readonly byteSize: number }>;
  /** Called as each part starts ("previews", "masks"…), for a progress line. */
  readonly onStage?: (stage: string) => void;
  readonly now?: number;
};

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Counts everything the app keeps on this device. Reads no pixels; see the note on the type. */
export async function measureStorage({ assets, onStage, now = Date.now() }: MeasureOptions): Promise<Usage> {
  const db = await catalogDb();
  const sum = new Map<UsageId, { bytes: number; count: number }>(USAGE_ORDER.map((id) => [id, { bytes: 0, count: 0 }]));
  const add = (id: UsageId, bytes: number, count = 1) => {
    const row = sum.get(id)!;
    row.bytes += bytes;
    row.count += count;
  };
  const largest: BigItem[] = [];

  onStage?.("photos");
  const byId = new Map<string, { fileName: string; byteSize: number }>();
  let records = 0;
  for (const a of assets) {
    byId.set(a.id, a);
    records++;
  }
  const originalKeys = (await db.getAllKeys("originals")) as string[];
  let linked = records;
  for (const key of originalKeys) {
    const asset = byId.get(key);
    if (!asset) continue;
    linked--;
    add("originals", asset.byteSize);
    largest.push({ kind: "photo", id: key, name: asset.fileName, bytes: asset.byteSize });
  }

  onStage?.("previews");
  {
    let cursor = await db.transaction("thumbs").store.openCursor();
    let n = 0;
    while (cursor) {
      const { thumb, preview, base } = cursor.value;
      if (thumb) add("thumbnails", thumb.size);
      if (preview) add("previews", preview.size);
      // The unedited preview kept beside a developed one belongs to the same photo.
      if (base) add("previews", base.size, 0);
      cursor = await cursor.continue();
      if (++n % 500 === 0) await pause();
    }
  }

  onStage?.("videos");
  const videoKeys = new Set((await db.getAllKeys("videoFiles")) as string[]);
  for (const v of await db.getAll("videos")) {
    const bytes = (videoKeys.has(v.id) ? v.byteSize : 0) + (v.poster?.size ?? 0) + byteSizeOf(v.edit);
    add("videos", bytes);
    largest.push({ kind: "video", id: v.id, name: v.name, bytes });
  }

  onStage?.("designs");
  {
    let cursor = await db.transaction("documents").store.openCursor();
    while (cursor) {
      const d = cursor.value;
      const design = (d.data as { purpose?: unknown } | null)?.purpose === "design";
      const bytes = byteSizeOf(d);
      add(design ? "designs" : "compositions", bytes);
      largest.push({ kind: design ? "design" : "composition", id: d.id, name: d.name, bytes });
      cursor = await cursor.continue();
    }
  }

  // Each raster comes back whole (its bytes are in the record), so they are read one at a
  // time, giving the page a turn between them.
  onStage?.("masks");
  {
    const keys = (await db.getAllKeys("rasters")) as string[];
    for (const key of keys) {
      const raster = await db.get("rasters", key);
      if (raster) add("masks", byteSizeOf(raster));
      await pause();
    }
  }

  onStage?.("your things");
  {
    let cursor = await db.transaction("designAssets").store.openCursor();
    while (cursor) {
      add("things", byteSizeOf(cursor.value));
      cursor = await cursor.continue();
    }
  }

  onStage?.("catalog");
  for (const store of ["assets", "collections", "presets", "snapshots", "settings", "looks"] as const) {
    const values = await db.getAll(store);
    add("records", byteSizeOf(values), values.length);
    await pause();
  }

  onStage?.("AI models");
  for (const entry of await cachedDownloads()) add("models", entry.bytes);

  onStage?.("files");
  const leftover: string[] = [];
  {
    const used = new Set<string>([...originalKeys.map(originalFile), ...[...videoKeys].map(videoFile)]);
    for (const file of await privateFiles()) {
      if (used.has(file.name) || now - file.modified < LEFTOVER_AGE_MS) continue;
      add("leftover", file.bytes);
      leftover.push(file.name);
    }
  }

  const rows = USAGE_ORDER.map((id) => ({ id, ...sum.get(id)! }));
  largest.sort((a, b) => b.bytes - a.bytes);
  return {
    rows,
    counted: rows.reduce((total, r) => total + r.bytes, 0),
    browser: await browserEstimate(),
    persisted: await persisted(),
    linked,
    largest: largest.filter((item) => item.bytes > 0).slice(0, 8),
    leftover,
  };
}

async function browserEstimate(): Promise<Usage["browser"]> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && typeof e.usage === "number" && typeof e.quota === "number" ? { usage: e.usage, quota: e.quota } : null;
  } catch {
    return null;
  }
}

async function persisted(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}

/** Asks the browser not to clear this site's data to make room. Resolves to what it answered. */
export async function keepStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** What the browser's download cache holds for this site: the AI models fetched on first use. */
async function cachedDownloads(): Promise<{ url: string; bytes: number }[]> {
  if (typeof caches === "undefined") return [];
  const out: { url: string; bytes: number }[] = [];
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const stated = Number(response.headers.get("content-length"));
        // A cached response's blob is a handle to the file on disk; its size costs no read.
        out.push({ url: request.url, bytes: stated > 0 ? stated : (await response.blob()).size });
      }
    }
  } catch {
    // No cache access (private browsing, an old browser): nothing to list.
  }
  return out;
}

/** Deletes the downloaded AI models; each downloads again the next time it is used. */
export async function removeDownloadedModels(): Promise<void> {
  if (typeof caches === "undefined") return;
  for (const name of await caches.keys()) await caches.delete(name);
}

type Entries = AsyncIterable<[string, FileSystemHandle]>;

async function filesDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    // Not created here: no directory, no files.
    return await root.getDirectoryHandle("focused-files");
  } catch {
    return null;
  }
}

async function privateFiles(): Promise<{ name: string; bytes: number; modified: number }[]> {
  const dir = await filesDirectory();
  if (!dir) return [];
  const out: { name: string; bytes: number; modified: number }[] = [];
  try {
    for await (const [name, handle] of (dir as unknown as { entries(): Entries }).entries()) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ name, bytes: file.size, modified: file.lastModified });
    }
  } catch {
    // Listing is not supported everywhere; then nothing is called leftover.
  }
  return out;
}

/** Deletes files nothing refers to (as listed by `measureStorage`). Returns how many went. */
export async function removeLeftoverFiles(names: readonly string[]): Promise<number> {
  const dir = await filesDirectory();
  if (!dir) return 0;
  let removed = 0;
  for (const name of names) {
    try {
      await dir.removeEntry(name);
      removed++;
    } catch {
      // Already gone, or in use: leave it.
    }
  }
  return removed;
}

/** 1536 → "1.5 KB"; sizes as people read them (powers of 1000, as operating systems show files). */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return "0 KB";
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let u = 0;
  while (v >= 999.5 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
