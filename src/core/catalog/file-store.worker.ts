/// <reference lib="webworker" />

/** Writes a Blob to an OPFS file with a synchronous access handle (see file-store.ts), 8 MB at a time. */
type SyncHandle = { truncate(size: number): void; write(data: BufferSource, options: { at: number }): number; flush(): void; close(): void };

self.onmessage = async (event: MessageEvent<{ id: number; directory: string; name: string; blob: Blob; chunk: number }>) => {
  const { id, directory, name, blob, chunk } = event.data;
  let access: SyncHandle | null = null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    access = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
    access.truncate(0);
    for (let at = 0; at < blob.size; at += chunk) access.write(new Uint8Array(await blob.slice(at, at + chunk).arrayBuffer()), { at });
    access.flush();
    access.close();
    access = null;
    postMessage({ id });
  } catch (error) {
    access?.close();
    postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
