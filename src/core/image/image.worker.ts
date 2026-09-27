/// <reference lib="webworker" />
import type { FileKind } from "@/core/catalog/types";
import { type Analysis, analyzeFile } from "./analyze";
import { type DecodedTiff, decodeTiffForDevelop } from "./tiff";

export type WorkerRequest =
  | { id: number; op: "analyze"; file: Blob; kind: FileKind }
  | { id: number; op: "decode-tiff"; file: Blob };
export type WorkerResponse =
  | { id: number; result: Analysis }
  | { id: number; decoded: DecodedTiff }
  | { id: number; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.op === "analyze") {
      postMessage({ id: request.id, result: await analyzeFile(request.file, request.kind) } satisfies WorkerResponse);
    } else {
      const decoded = await decodeTiffForDevelop(new Uint8Array(await request.file.arrayBuffer()));
      const transfer = decoded.kind === "rgb16-linear" ? [decoded.data.buffer] : [decoded.image];
      postMessage({ id: request.id, decoded } satisfies WorkerResponse, { transfer: transfer as Transferable[] });
    }
  } catch (error) {
    postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  }
};
