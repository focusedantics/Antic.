/// <reference lib="webworker" />
import type { Palette } from "gifenc";
import { GifWriter } from "./gif";

export type GifWorkerRequest =
  | { type: "start"; width: number; height: number; palette: Palette; fps: number; dither: boolean }
  | { type: "frame"; pixels: ArrayBuffer }
  | { type: "finish" };

export type GifWorkerResponse = { type: "frame-done" } | { type: "done"; bytes: ArrayBuffer } | { type: "error"; message: string };

let writer: GifWriter | null = null;
const post = (m: GifWorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<GifWorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === "start") writer = new GifWriter(m.width, m.height, m.palette, m.fps, m.dither);
    else if (m.type === "frame") {
      writer!.add(new Uint8ClampedArray(m.pixels));
      post({ type: "frame-done" });
    } else {
      const bytes = writer!.finish();
      writer = null;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      post({ type: "done", bytes: buffer }, [buffer]);
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
