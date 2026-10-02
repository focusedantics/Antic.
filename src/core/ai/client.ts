import { beginActivity } from "@/lib/activity";
import { createStore } from "zustand/vanilla";
import { putRaster, type RasterRecord } from "@/core/catalog/db";
import { createDefaultRecipe } from "@/core/develop/defaults";
import type { GpuSource } from "@/core/gpu/pipeline";
import type { DevelopPipeline } from "@/core/gpu/pipeline";
import { createId } from "@/lib/id";
import type { AiMask, AiRequest, AiResponse, ImageInput, Point } from "./ai.worker";

/**
 * Main-thread client for the AI worker. The worker is created on first use,
 * so no model code or weights load until the user asks for an AI selection.
 */
export type AiStatus = {
  readonly busy: string | null;
  readonly model: string | null;
  readonly progress: number;
  readonly device: string | null;
  readonly lastModel: string | null;
};

export const aiStatus = createStore<AiStatus>(() => ({ busy: null, model: null, progress: 0, device: null, lastModel: null }));

/** Status for working animations: a line for screen readers and the model download (0–100) while it runs. */
export function describeAiStatus(task: string): { text: string; progress: number | null } {
  const { model, progress } = aiStatus.getState();
  const downloading = !!model && progress > 0 && progress < 100;
  return { text: downloading ? `${task} Downloading the model, ${progress}% (first time only).` : task, progress: downloading ? progress : null };
}

export type AiQuality = "quality" | "fast" | "offline";
const readQuality = (): AiQuality => {
  try {
    const v = localStorage.getItem("ai-quality");
    if (v === "quality" || v === "fast" || v === "offline") return v;
  } catch {
    // Storage unavailable: use the default.
  }
  return "quality";
};
/** Which subject model to use: BiRefNet (best), MODNet (small download) or the bundled U²-Netp. */
export const aiPreferences = createStore<{ quality: AiQuality }>(() => ({ quality: readQuality() }));
aiPreferences.subscribe((s) => {
  try {
    localStorage.setItem("ai-quality", s.quality);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
});

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./ai.worker.ts", import.meta.url), { type: "module", name: "ai" });
  worker.onmessage = (event: MessageEvent<AiResponse>) => {
    const data = event.data;
    if ("type" in data) {
      aiStatus.setState({ model: data.model, progress: Math.round(data.progress ?? 0) });
      return;
    }
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if ("error" in data) job.reject(new Error(data.error));
    else job.resolve(data.result);
  };
  worker.onerror = (event) => {
    for (const job of pending.values()) job.reject(new Error(event.message || "The AI worker stopped."));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

type Request = AiRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

async function call<T>(label: string, request: Request, transfer: Transferable[] = []): Promise<T> {
  aiStatus.setState({ busy: label, progress: 0 });
  const end = beginActivity();
  try {
    return await new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      getWorker().postMessage({ ...request, id } as AiRequest, transfer);
    });
  } finally {
    end();
    aiStatus.setState({ busy: null, model: null });
  }
}

const AI_SIZE = 1024;

/**
 * The photo in source coordinates (no crop or rotation, default rendering) at
 * up to 1024 px: masks stored in source space then line up exactly.
 */
export function aiImage(pipeline: DevelopPipeline, source: GpuSource): ImageInput {
  const scale = Math.min(1, AI_SIZE / Math.max(source.size.width, source.size.height));
  const width = Math.max(1, Math.round(source.size.width * scale));
  const height = Math.max(1, Math.round(source.size.height * scale));
  const target = pipeline.render(source, createDefaultRecipe(source.info), { width, height, draft: true });
  const pixels = pipeline.encode(target);
  pipeline.release(target);
  return { data: pixels, width, height };
}

async function store(result: AiMask, assetId: string): Promise<RasterRecord> {
  aiStatus.setState({ lastModel: `${result.model} · ${result.device === "webgpu" ? "WebGPU" : "WASM"}`, device: result.device });
  const record: RasterRecord = { id: createId("raster"), assetId, width: result.width, height: result.height, data: result.mask, createdAt: Date.now() };
  await putRaster(record);
  return record;
}

export async function selectSubject(assetId: string, image: ImageInput, prefer: AiQuality = aiPreferences.getState().quality) {
  const copy = { ...image, data: new Uint8ClampedArray(image.data) };
  return store(await call<AiMask>("Selecting subject", { op: "subject", image: copy, prefer }, [copy.data.buffer]), assetId);
}

export async function selectSemantic(assetId: string, image: ImageInput, target: "sky" | "person") {
  const copy = { ...image, data: new Uint8ClampedArray(image.data) };
  return store(await call<AiMask>(target === "sky" ? "Selecting sky" : "Selecting people", { op: "semantic", image: copy, target }, [copy.data.buffer]), assetId);
}

export async function prepareObjectSelection(assetId: string, image: ImageInput) {
  const copy = { ...image, data: new Uint8ClampedArray(image.data) };
  await call("Analyzing photo for object selection", { op: "sam-encode", key: assetId, image: copy }, [copy.data.buffer]);
}

export async function selectObject(assetId: string, points: Point[]) {
  return store(await call<AiMask>("Selecting object", { op: "sam-decode", key: assetId, points }), assetId);
}
