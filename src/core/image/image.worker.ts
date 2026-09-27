/// <reference lib="webworker" />
import type { FileKind } from "@/core/catalog/types";
import { type Analysis, analyzeFile } from "./analyze";

export type AnalyzeRequest = { id: number; file: Blob; kind: FileKind };
export type AnalyzeResponse = { id: number; result?: Analysis; error?: string };

self.onmessage = async (event: MessageEvent<AnalyzeRequest>) => {
  const { id, file, kind } = event.data;
  try {
    const result = await analyzeFile(file, kind);
    postMessage({ id, result } satisfies AnalyzeResponse);
  } catch (error) {
    postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies AnalyzeResponse);
  }
};
