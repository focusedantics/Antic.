/**
 * Large files kept in the origin private file system (OPFS) instead of IndexedDB.
 *
 * On iPhone and iPad, Safari can refuse to store a photo-picker File in IndexedDB,
 * and has lost such Blobs after a reload, so originals used to be stored there as
 * `ArrayBuffer` bytes. Bytes always store, but reading them back loads the whole file
 * into memory: a 75 MB ProRAW, or a 4K video of several hundred MB, is enough for iOS
 * to reload the tab. A file in OPFS reads back as a disk-backed `File`: decoders and the
 * video demuxer read only the parts they need.
 *
 * Writing streams the file in 8 MB pieces, through `createWritable` where the browser
 * has it (Chromium, Safari 26) and otherwise a worker's synchronous access handle
 * (Safari 15.2+). IndexedDB keeps a `FileRef` naming the file.
 *
 * `localStorage["focused:file-store"]`: "off" disables it, "worker" forces the worker
 * path (tests).
 */
export type FileRef = { readonly opfs: string; readonly type: string; readonly size: number };

export const isFileRef = (v: unknown): v is FileRef => !!v && typeof v === "object" && typeof (v as FileRef).opfs === "string";

const CHUNK = 8 * 1024 * 1024;
const DIRECTORY = "focused-files";

function setting(): string | null {
  try {
    return localStorage.getItem("focused:file-store");
  } catch {
    return null;
  }
}

type Directory = FileSystemDirectoryHandle;
let directory: Promise<Directory | null> | null = null;

/** The app's OPFS directory, or null where there is none (old browsers, private browsing). */
function filesDirectory(): Promise<Directory | null> {
  directory ??= (async () => {
    if (setting() === "off" || typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    try {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(DIRECTORY, { create: true });
    } catch {
      return null;
    }
  })();
  return directory;
}

export async function fileStoreAvailable(): Promise<boolean> {
  return !!(await filesDirectory());
}

type Writable = { write(data: BufferSource): Promise<void>; close(): Promise<void>; abort(): Promise<void> };

/** Writes `blob` to OPFS as `name`, replacing any file of that name. */
export async function writeStoredFile(name: string, blob: Blob): Promise<FileRef> {
  const dir = await filesDirectory();
  if (!dir) throw new Error("No private file system in this browser.");
  const handle = await dir.getFileHandle(name, { create: true });
  const create = (handle as FileSystemFileHandle & { createWritable?: () => Promise<Writable> }).createWritable;
  if (create && setting() !== "worker") {
    const writable = await create.call(handle);
    try {
      for (let at = 0; at < blob.size; at += CHUNK) await writable.write(await blob.slice(at, at + CHUNK).arrayBuffer());
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      await dir.removeEntry(name).catch(() => undefined);
      throw error;
    }
  } else {
    await writeInWorker(name, blob);
  }
  return { opfs: name, type: blob.type, size: blob.size };
}

/** The stored file, read from disk on demand, or undefined when it is gone. */
export async function readStoredFile(ref: FileRef): Promise<Blob | undefined> {
  const dir = await filesDirectory();
  if (!dir) return undefined;
  try {
    const file = await (await dir.getFileHandle(ref.opfs)).getFile();
    // Re-typed without copying: a Blob made of a File refers to it.
    return file.type === ref.type ? file : new Blob([file], { type: ref.type });
  } catch {
    return undefined;
  }
}

export async function deleteStoredFile(ref: FileRef): Promise<void> {
  const dir = await filesDirectory();
  await dir?.removeEntry(ref.opfs).catch(() => undefined);
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

/** Safari before 26 writes OPFS files only from a worker, with a synchronous access handle. */
function writeInWorker(name: string, blob: Blob): Promise<void> {
  if (!worker) {
    worker = new Worker(new URL("./file-store.worker.ts", import.meta.url), { type: "module", name: "file-store" });
    worker.onmessage = (event: MessageEvent<{ id: number; error?: string }>) => {
      const job = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (event.data.error) job?.reject(new Error(event.data.error));
      else job?.resolve();
      if (!pending.size) {
        worker?.terminate();
        worker = null;
      }
    };
    worker.onerror = (event) => {
      for (const job of pending.values()) job.reject(new Error(event.message || "The file writer stopped."));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, directory: DIRECTORY, name, blob, chunk: CHUNK });
  });
}
