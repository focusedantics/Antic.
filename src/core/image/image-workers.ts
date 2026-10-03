import type { FileKind } from "@/core/catalog/types";
import { device } from "@/lib/device";
import type { Analysis } from "./analyze";
import type { WorkerRequest, WorkerResponse } from "./image.worker";
import type { DecodedTiff } from "./tiff";

/**
 * A small pool of image workers. Imports of hundreds of files queue here, so
 * the UI thread only ever sees finished thumbnails and metadata.
 */
type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;
type Job = { request: Request; resolve: (value: unknown) => void; reject: (e: Error) => void };
type Slot = { worker: Worker; busy: boolean };

// Fewer on phones: each worker holds a decoded image while it works.
const size = device.workers;
const workers: Slot[] = [];
const queue: Job[] = [];
const pending = new Map<number, Job & { slot: Slot }>();
let nextId = 1;

function spawn() {
  const worker = new Worker(new URL("./image.worker.ts", import.meta.url), { type: "module", name: "image" });
  const slot: Slot = { worker, busy: false };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id);
    slot.busy = false;
    const data = event.data;
    if ("error" in data) job.reject(new Error(data.error));
    else job.resolve("result" in data ? data.result : data.decoded);
    pump();
  };
  worker.onerror = (event) => {
    // A crashed worker (e.g. out of memory on a huge file) fails its job and is replaced.
    for (const [id, job] of pending) {
      if (job.slot === slot) {
        pending.delete(id);
        job.reject(new Error(event.message || "Image worker crashed"));
      }
    }
    worker.terminate();
    workers.splice(workers.indexOf(slot), 1);
    pump();
  };
  workers.push(slot);
  return slot;
}

/**
 * Idle workers are ended: a worker that decoded photos keeps that memory (its heap, its
 * canvases' buffers) until it happens to be collected, and a phone can't spare it. A new
 * one starts in a few milliseconds when the next job comes.
 */
const IDLE_MS = 4000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (queue.length || pending.size || !workers.length) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (queue.length || pending.size) return;
    for (const slot of workers.splice(0)) slot.worker.terminate();
  }, IDLE_MS);
}

function pump() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  while (queue.length) {
    const slot = workers.find((w) => !w.busy) ?? (workers.length < size ? spawn() : undefined);
    if (!slot) return;
    const job = queue.shift()!;
    const id = nextId++;
    slot.busy = true;
    pending.set(id, { ...job, slot });
    slot.worker.postMessage({ ...job.request, id } as WorkerRequest);
  }
  scheduleIdle();
}

function run<T>(request: Request, urgent = false): Promise<T> {
  return new Promise((resolve, reject) => {
    const job = { request, resolve: resolve as (v: unknown) => void, reject };
    if (urgent) queue.unshift(job);
    else queue.push(job);
    pump();
  });
}

export const analyzeInWorker = (file: Blob, kind: FileKind) => run<Analysis>({ op: "analyze", file, kind });

/** Full-precision TIFF decode for Develop; jumps the import queue. */
export const decodeTiffInWorker = (file: Blob) => run<DecodedTiff>({ op: "decode-tiff", file }, true);

export const pendingAnalyses = () => queue.length + pending.size;
