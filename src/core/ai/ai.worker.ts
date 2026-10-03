/// <reference lib="webworker" />
import { AutoModel, AutoProcessor, env, pipeline, RawImage, SamModel, Tensor } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { MODELS, type ModelKey, SEMANTIC_LABELS } from "./models";
import { guidedFilter, normalizeU8, resizeU8, unionU8 } from "./raster-ops";

/**
 * Local AI. Every model runs here, off the UI thread, on WebGPU when the
 * browser has it and WASM otherwise. Photos never leave the machine; model
 * weights are downloaded once (Transformers.js) or bundled (U²-Netp).
 */

// Serve ONNX Runtime from our own origin instead of a CDN.
const wasmPaths = { mjs: new URL(ortMjs, self.location.href).href, wasm: new URL(ortWasm, self.location.href).href };
ort.env.wasm.wasmPaths = wasmPaths;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = wasmPaths;
env.allowLocalModels = false;
env.useBrowserCache = true;

export type ImageInput = { data: Uint8ClampedArray; width: number; height: number };
export type Point = { x: number; y: number; positive: boolean };

/** `lite`: a phone or tablet (see lib/device): models are kept small and one at a time. */
export type AiRequest = { lite?: boolean } & (
  | { id: number; op: "subject"; image: ImageInput; prefer: "quality" | "fast" | "offline" }
  | { id: number; op: "semantic"; image: ImageInput; target: "sky" | "person" }
  | { id: number; op: "sam-encode"; key: string; image: ImageInput }
  | { id: number; op: "sam-decode"; key: string; points: Point[] }
  | { id: number; op: "device" }
);

export type AiMask = { mask: Uint8Array; width: number; height: number; model: string; device: string };
export type AiResponse =
  | { id: number; result: AiMask | { device: string } | { ok: true } }
  | { id: number; error: string }
  | { type: "progress"; model: string; status: string; progress: number };

let devicePromise: Promise<"webgpu" | "wasm"> | null = null;
function device() {
  devicePromise ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (gpu && (await gpu.requestAdapter())) return "webgpu" as const;
    } catch {
      // Fall through to WASM.
    }
    return "wasm" as const;
  })();
  return devicePromise;
}

function progress(model: string) {
  return (p: { status: string; progress?: number; file?: string }) => {
    postMessage({ type: "progress", model, status: p.status, progress: p.progress ?? (p.status === "done" ? 100 : 0) } satisfies AiResponse);
  };
}

function toRaw(image: ImageInput) {
  return new RawImage(image.data, image.width, image.height, 4).rgb();
}

// ─── Model cache ────────────────────────────────────────────────────────────

/** Set per request: on phones only one model stays loaded (see `cached`). */
let lite = false;

type Disposable = { dispose?: () => Promise<unknown> | unknown; release?: () => Promise<unknown> | unknown };
const loaded = new Map<string, Promise<unknown>>();

/** Releases a loaded model's ONNX sessions (their WASM or GPU memory). */
async function release(value: unknown) {
  const parts = value && typeof value === "object" && "model" in value ? [(value as { model: unknown }).model] : [value];
  for (const part of parts as Disposable[]) {
    try {
      if (part?.dispose) await part.dispose();
      else if (part?.release) await part.release();
    } catch (error) {
      console.warn("[ai] could not release a model:", error);
    }
  }
}

/**
 * Loads a model once. On phones, loading one first releases the others: a subject
 * model, DETR and SAM together are more than a phone's browser tab can hold.
 */
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = loaded.get(key) as Promise<T> | undefined;
  if (p) return p;
  if (lite)
    for (const [other, model] of [...loaded]) {
      loaded.delete(other);
      if (other.startsWith("sam:")) sam = null;
      await release(await model.catch(() => null));
    }
  p = load();
  loaded.set(key, p);
  // A failed load (offline, blocked) must not poison later attempts.
  p.catch(() => loaded.delete(key));
  return p;
}

async function transformersModel(key: ModelKey) {
  const spec = MODELS[key];
  const dev = await device();
  return cached(`${key}:${dev}`, async () => {
    const dtype = "dtype" in spec ? spec.dtype[dev] : "fp32";
    const [model, processor] = await Promise.all([
      AutoModel.from_pretrained(spec.id, { device: dev, dtype, progress_callback: progress(spec.label) } as never),
      AutoProcessor.from_pretrained(spec.id, {}),
    ]);
    return { model, processor };
  });
}

// ─── Subject / background ───────────────────────────────────────────────────

async function subjectTransformers(key: "birefnet" | "modnet", image: ImageInput): Promise<AiMask> {
  const { model, processor } = (await transformersModel(key)) as {
    model: ((inputs: Record<string, unknown>) => Promise<Record<string, Tensor>>) & { sessions?: Record<string, { inputNames: string[] }> };
    processor: (image: RawImage) => Promise<{ pixel_values: Tensor }>;
  };
  const { pixel_values } = await processor(toRaw(image));
  const inputName = Object.values(model.sessions ?? {})[0]?.inputNames?.[0] ?? "pixel_values";
  const outputs = await model({ [inputName]: pixel_values });
  const logits = Object.values(outputs)[0] as Tensor;
  const data = logits.data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Some exports return logits, some probabilities.
  const probs = lo < -0.01 || hi > 1.01 ? logits.sigmoid() : logits;
  const dims = probs.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  const mask = resizeU8(probs.data as Float32Array, w, h, image.width, image.height, 255);
  return { mask, width: image.width, height: image.height, model: MODELS[key].label, device: await device() };
}

async function subjectU2net(image: ImageInput): Promise<AiMask> {
  const dev = await device();
  const session = await cached(`u2netp:${dev}`, async () => {
    const url = new URL(`/${MODELS.u2netp.url}`, self.location.origin).href;
    progress(MODELS.u2netp.label)({ status: "loading", progress: 0 });
    const s = await ort.InferenceSession.create(url, { executionProviders: dev === "webgpu" ? ["webgpu", "wasm"] : ["wasm"] });
    progress(MODELS.u2netp.label)({ status: "done", progress: 100 });
    return s;
  });
  const size = 320;
  const resized = new OffscreenCanvas(size, size);
  const ctx = resized.getContext("2d")!;
  const src = new OffscreenCanvas(image.width, image.height);
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  ctx.drawImage(src, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++)
    for (let c = 0; c < 3; c++) input[c * size * size + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, size, size]) };
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]].data as Float32Array;
  const normalized = normalizeU8(output);
  const mask = resizeU8(normalized, size, size, image.width, image.height);
  return { mask, width: image.width, height: image.height, model: MODELS.u2netp.label, device: dev };
}

async function subject(image: ImageInput, prefer: "quality" | "fast" | "offline"): Promise<AiMask> {
  let result: AiMask;
  if (prefer === "offline") result = await subjectU2net(image);
  else {
    try {
      result = await subjectTransformers(prefer === "fast" ? "modnet" : "birefnet", image);
    } catch (error) {
      // No network or the model failed on this GPU: the bundled model still works.
      console.warn("[ai] falling back to the bundled model:", error);
      result = await subjectU2net(image);
      result.model += " (offline fallback)";
    }
  }
  result.mask = guidedFilter(result.mask, image.data, image.width, image.height, Math.max(2, Math.round(Math.max(image.width, image.height) / 200)), 2e-3);
  return result;
}

// ─── Semantic: sky, people ──────────────────────────────────────────────────

type Segmenter = (image: RawImage) => Promise<{ label: string; score: number; mask: RawImage }[]>;

/**
 * DETR's panoptic mask head runs once per query (100 of them) at a quarter of the input
 * resolution: at its usual 800 × 1333 input that is gigabytes of activations. Phones run
 * the 8-bit model on the CPU at a 320 px short side (a sixth of the pixels' memory); sky
 * and people are large regions, and the guided filter below restores the edges at full size.
 */
const LITE_PANOPTIC_SIZE = { shortest_edge: 320, longest_edge: 533 };

async function semantic(image: ImageInput, target: "sky" | "person"): Promise<AiMask> {
  const dev = lite ? "wasm" : await device();
  const segmenter = (await cached(`panoptic:${dev}:${lite}`, async () => {
    const pipe = await pipeline("image-segmentation", MODELS.panoptic.id, {
      device: dev,
      dtype: MODELS.panoptic.dtype[dev],
      progress_callback: progress(MODELS.panoptic.label),
    } as never);
    const processor = (pipe as unknown as { processor?: { image_processor?: { size?: unknown } } }).processor?.image_processor;
    if (lite && processor) processor.size = LITE_PANOPTIC_SIZE;
    return pipe;
  })) as unknown as Segmenter;
  const segments = await segmenter(toRaw(image));
  const labels = SEMANTIC_LABELS[target];
  const parts = segments
    .filter((s) => labels.some((l) => s.label === l || s.label.startsWith(`${l}-`)))
    .map((s) => {
      const m = s.mask;
      return m.width === image.width && m.height === image.height
        ? new Uint8Array(m.data as Uint8Array)
        : resizeU8(m.data as Uint8Array, m.width, m.height, image.width, image.height);
    });
  const union = unionU8(parts, image.width * image.height);
  const mask = guidedFilter(union, image.data, image.width, image.height, Math.max(3, Math.round(Math.max(image.width, image.height) / 120)), 1e-3);
  return { mask, width: image.width, height: image.height, model: MODELS.panoptic.label, device: dev };
}

// ─── Object selection (SAM) ─────────────────────────────────────────────────

type SamState = {
  key: string;
  image: ImageInput;
  embeddings: Record<string, Tensor>;
  sizes: { original_sizes: number[][]; reshaped_input_sizes: number[][] };
};
let sam: SamState | null = null;

async function samModel() {
  // Phones: the 8-bit model on the CPU (its memory goes when the worker ends).
  const dev = lite ? "wasm" : await device();
  return cached(`sam:${dev}`, async () => {
    const spec = MODELS.slimsam;
    const [model, processor] = await Promise.all([
      SamModel.from_pretrained(spec.id, { device: dev, dtype: spec.dtype[dev], progress_callback: progress(spec.label) } as never),
      AutoProcessor.from_pretrained(spec.id, {}),
    ]);
    return { model, processor } as unknown as {
      model: {
        get_image_embeddings(inputs: unknown): Promise<Record<string, Tensor>>;
        (inputs: Record<string, unknown>): Promise<{ pred_masks: Tensor; iou_scores: Tensor }>;
      };
      processor: ((image: RawImage) => Promise<{ original_sizes: number[][]; reshaped_input_sizes: number[][] }>) & {
        post_process_masks(masks: Tensor, original: number[][], reshaped: number[][]): Promise<Tensor[]>;
      };
    };
  });
}

async function samEncode(key: string, image: ImageInput) {
  if (sam?.key === key) return { ok: true as const };
  const { model, processor } = await samModel();
  const inputs = await processor(toRaw(image));
  const embeddings = await model.get_image_embeddings(inputs);
  sam = { key, image, embeddings, sizes: { original_sizes: inputs.original_sizes, reshaped_input_sizes: inputs.reshaped_input_sizes } };
  return { ok: true as const };
}

async function samDecode(key: string, points: Point[]): Promise<AiMask> {
  if (!sam || sam.key !== key) throw new Error("Select the object again: the photo changed.");
  const { model, processor } = await samModel();
  const [rh, rw] = sam.sizes.reshaped_input_sizes[0];
  const coords = points.flatMap((p) => [p.x * rw, p.y * rh]);
  const input_points = new Tensor("float32", Float32Array.from(coords), [1, 1, points.length, 2]);
  const input_labels = new Tensor("int64", BigInt64Array.from(points.map((p) => BigInt(p.positive ? 1 : 0))), [1, 1, points.length]);
  const out = await model({ ...sam.embeddings, input_points, input_labels });
  const masks = await processor.post_process_masks(out.pred_masks, sam.sizes.original_sizes, sam.sizes.reshaped_input_sizes);
  const scores = out.iou_scores.data as Float32Array;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const m = masks[0];
  const [, , h, w] = m.dims;
  const all = m.data as Uint8Array;
  const mask = new Uint8Array(w * h);
  const offset = best * w * h;
  for (let i = 0; i < w * h; i++) mask[i] = all[offset + i] ? 255 : 0;
  const scaled = w === sam.image.width && h === sam.image.height ? mask : resizeU8(mask, w, h, sam.image.width, sam.image.height);
  const refined = guidedFilter(scaled, sam.image.data, sam.image.width, sam.image.height, Math.max(2, Math.round(Math.max(sam.image.width, sam.image.height) / 250)), 1e-3);
  return { mask: refined, width: sam.image.width, height: sam.image.height, model: MODELS.slimsam.label, device: lite ? "wasm" : await device() };
}

self.onmessage = async (event: MessageEvent<AiRequest>) => {
  const r = event.data;
  lite = !!r.lite;
  try {
    let result: AiResponse extends infer T ? (T extends { result: infer R } ? R : never) : never;
    switch (r.op) {
      case "subject":
        result = await subject(r.image, r.prefer);
        break;
      case "semantic":
        result = await semantic(r.image, r.target);
        break;
      case "sam-encode":
        result = await samEncode(r.key, r.image);
        break;
      case "sam-decode":
        result = await samDecode(r.key, r.points);
        break;
      case "device":
        result = { device: await device() };
        break;
    }
    const transfer = "mask" in result ? [result.mask.buffer] : [];
    postMessage({ id: r.id, result } satisfies AiResponse, { transfer: transfer as Transferable[] });
  } catch (error) {
    postMessage({ id: r.id, error: error instanceof Error ? error.message : String(error) } satisfies AiResponse);
  }
};
