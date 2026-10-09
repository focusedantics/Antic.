/// <reference lib="webworker" />
import { encodeAac } from "./aac-encoder";

export type AacWorkerRequest = { left: Float32Array; right: Float32Array; kbps: number };
export type AacWorkerResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; bytes: ArrayBuffer; sizes: Uint32Array }
  | { type: "error"; message: string };

const post = (m: AacWorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** Encodes a soundtrack as AAC off the main thread; the frames come back packed in one buffer. */
self.onmessage = (e: MessageEvent<AacWorkerRequest>) => {
  try {
    const { left, right, kbps } = e.data;
    const frames = encodeAac(left, right, kbps, (done, total) => post({ type: "progress", done, total }));
    const sizes = Uint32Array.from(frames, (f) => f.length);
    const bytes = new Uint8Array(sizes.reduce((n, s) => n + s, 0));
    let at = 0;
    for (const f of frames) {
      bytes.set(f, at);
      at += f.length;
    }
    post({ type: "done", bytes: bytes.buffer, sizes }, [bytes.buffer, sizes.buffer]);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
