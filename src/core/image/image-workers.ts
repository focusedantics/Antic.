import type { FileKind } from "@/core/catalog/types";
import type { Analysis } from "./analyze";
import type { AnalyzeRequest, AnalyzeResponse } from "./image.worker";

/**
 * A small pool of image workers. Imports of hundreds of files queue here, so
 * the UI thread only ever sees finished thumbnails and metadata.
 */
type Job = { file: Blob; kind: FileKind; resolve: (a: Analysis) => void; reject: (e: Error) => void };

const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const workers: { worker: Worker; busy: boolean }[] = [];
const queue: Job[] = [];
const pending = new Map<number, Job & { slot: (typeof workers)[number] }>();
let nextId = 1;

function spawn() {
  const worker = new Worker(new URL("./image.worker.ts", import.meta.url), { type: "module", name: "image" });
  const slot = { worker, busy: false };
  worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id);
    slot.busy = false;
    if (event.data.result) job.resolve(event.data.result);
    else job.reject(new Error(event.data.error ?? "Image analysis failed"));
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

function pump() {
  while (queue.length) {
    const slot = workers.find((w) => !w.busy) ?? (workers.length < size ? spawn() : undefined);
    if (!slot) return;
    const job = queue.shift()!;
    const id = nextId++;
    slot.busy = true;
    pending.set(id, { ...job, slot });
    slot.worker.postMessage({ id, file: job.file, kind: job.kind } satisfies AnalyzeRequest);
  }
}

export function analyzeInWorker(file: Blob, kind: FileKind): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    queue.push({ file, kind, resolve, reject });
    pump();
  });
}

export const pendingAnalyses = () => queue.length + pending.size;
