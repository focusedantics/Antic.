import { createStore } from "zustand/vanilla";
import { analyzeInWorker } from "@/core/image/image-workers";
import { fileKindOf } from "@/core/image/formats";
import { createId } from "@/lib/id";
import { findByFingerprint, putOriginal, putThumb } from "./db";
import { addAssets, catalog, updateAsset } from "./store";
import type { Asset, OriginalRef } from "./types";

export type ImportItem = {
  readonly file: File;
  /** Folder path relative to the imported root, "" for loose files. */
  readonly folder: string;
  /** Present when the file can be referenced in place instead of copied. */
  readonly handle?: FileSystemFileHandle;
};

export type ImportProgress = {
  readonly active: boolean;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly current?: string;
  readonly errors: readonly string[];
};

const idle: ImportProgress = { active: false, total: 0, done: 0, failed: 0, duplicates: 0, skipped: 0, errors: [] };
export const importProgress = createStore<ImportProgress>(() => idle);

/** A quick content fingerprint: size plus SHA-256 of the first and last 64 KB. */
export async function fingerprint(file: Blob): Promise<string> {
  const chunk = 64 * 1024;
  const head = await file.slice(0, chunk).arrayBuffer();
  const tail = file.size > chunk ? await file.slice(Math.max(chunk, file.size - chunk)).arrayBuffer() : new ArrayBuffer(0);
  const joined = new Uint8Array(head.byteLength + tail.byteLength + 8);
  joined.set(new Uint8Array(head), 0);
  joined.set(new Uint8Array(tail), head.byteLength);
  new DataView(joined.buffer).setFloat64(head.byteLength + tail.byteLength, file.size);
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newAsset(item: ImportItem, original: OriginalRef, print: string): Asset | null {
  const kind = fileKindOf(item.file);
  if (!kind) return null;
  return {
    id: createId("ph"),
    fileName: item.file.name,
    kind,
    mime: item.file.type,
    byteSize: item.file.size,
    fileModified: item.file.lastModified,
    importedAt: Date.now(),
    folder: item.folder,
    original,
    fingerprint: print,
    exif: {},
    rating: 0,
    flag: null,
    label: null,
    keywords: [],
    collectionIds: [],
    developRevision: 0,
    thumbRevision: -1,
    thumbState: "pending",
  };
}

/**
 * Imports files. Originals are either referenced (a disk handle, never written)
 * or copied into the library; the source file is never modified either way.
 * Assets appear in the grid immediately and fill in as workers finish.
 */
export async function importItems(items: readonly ImportItem[], options: { collectionId?: string } = {}) {
  const supported = items.filter((i) => fileKindOf(i.file));
  const skipped = items.length - supported.length;
  const base = importProgress.getState();
  const running = base.active;
  importProgress.setState({
    active: true,
    total: (running ? base.total : 0) + supported.length,
    done: running ? base.done : 0,
    failed: running ? base.failed : 0,
    duplicates: running ? base.duplicates : 0,
    skipped: (running ? base.skipped : 0) + skipped,
    errors: running ? base.errors : [],
  });
  if (navigator.storage?.persist) void navigator.storage.persist();

  const seen = new Set<string>();
  const analyses: Promise<void>[] = [];
  for (const item of supported) {
    importProgress.setState({ current: item.file.name });
    try {
      const print = await fingerprint(item.file);
      if (seen.has(print) || (await findByFingerprint(print)) || hasFingerprint(print)) {
        importProgress.setState((s) => ({ duplicates: s.duplicates + 1, done: s.done + 1 }));
        continue;
      }
      seen.add(print);
      const original: OriginalRef = item.handle
        ? { kind: "handle", handle: item.handle, path: [item.folder, item.file.name].filter(Boolean).join("/") }
        : { kind: "stored" };
      const asset = newAsset(item, original, print);
      if (!asset) continue;
      if (original.kind === "stored") await putOriginal(asset.id, item.file);
      addAssets([
        options.collectionId ? { ...asset, collectionIds: [options.collectionId] } : asset,
      ]);
      analyses.push(analyze(asset, item.file));
    } catch (error) {
      fail(item.file.name, error);
    }
  }
  await Promise.all(analyses);
  importProgress.setState({ active: false, current: undefined });
}

function hasFingerprint(print: string) {
  for (const a of catalog.getState().assets.values()) if (a.fingerprint === print) return true;
  return false;
}

function fail(name: string, error: unknown) {
  const message = `${name}: ${error instanceof Error ? error.message : String(error)}`;
  importProgress.setState((s) => ({ failed: s.failed + 1, done: s.done + 1, errors: [...s.errors, message].slice(-50) }));
}

async function analyze(asset: Asset, file: Blob) {
  try {
    const result = await analyzeInWorker(file, asset.kind);
    await putThumb(asset.id, {
      thumb: result.thumb,
      preview: result.preview,
      previewSource: result.previewSource,
      revision: -1,
    });
    updateAsset(asset.id, {
      width: result.width,
      height: result.height,
      orientation: result.orientation,
      captureTime: result.captureTime,
      exif: result.exif,
      thumbState: result.thumb ? "ready" : "error",
      error: result.warning,
    });
    importProgress.setState((s) => ({ done: s.done + 1 }));
  } catch (error) {
    updateAsset(asset.id, { thumbState: "error", error: error instanceof Error ? error.message : String(error) });
    fail(asset.fileName, error);
  }
}

// ─── Gathering files ──────────────────────────────────────────────────────────

export function itemsFromFileList(files: FileList | readonly File[]): ImportItem[] {
  return [...files].map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    return { file, folder };
  });
}

type Entry = FileSystemEntry;

async function walkEntry(entry: Entry, path: string, out: ImportItem[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, folder: path });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const folder = path ? `${path}/${entry.name}` : entry.name;
  // readEntries returns results in batches; keep reading until empty.
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, folder, out);
  }
}

/** Files and folders dropped on the window; folders are walked recursively. */
export async function itemsFromDataTransfer(data: DataTransfer): Promise<ImportItem[]> {
  const entries = [...data.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is Entry => !!e);
  if (!entries.length) return itemsFromFileList(data.files);
  const out: ImportItem[] = [];
  for (const entry of entries) await walkEntry(entry, "", out);
  return out;
}

type DirectoryHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

export const canReferenceFiles = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/** Chromium's folder picker: files are referenced in place, never copied. */
export async function itemsFromDirectoryPicker(): Promise<ImportItem[]> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirectoryHandle> }).showDirectoryPicker;
  const root = await picker({ id: "focused-import", mode: "read" });
  const out: ImportItem[] = [];
  async function walk(dir: DirectoryHandle, path: string) {
    for await (const handle of dir.values()) {
      if (handle.kind === "file") {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        if (fileKindOf(file)) out.push({ file, folder: path, handle: fileHandle });
      } else if (!handle.name.startsWith(".")) {
        await walk(handle as DirectoryHandle, `${path}/${handle.name}`);
      }
    }
  }
  await walk(root, root.name);
  return out;
}
