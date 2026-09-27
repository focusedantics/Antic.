/**
 * Local AI models. Transformers.js models download from the Hugging Face Hub on
 * first use and are cached by the browser; the bundled U²-Netp needs no network.
 * Only permissively licensed weights are listed; see docs/THIRD_PARTY.md.
 */
export type AiTask = "subject" | "semantic" | "object";

export type ModelSpec = {
  readonly id: string;
  readonly task: AiTask;
  readonly runtime: "transformers" | "onnx";
  readonly label: string;
  readonly license: string;
  /** Approximate download, for the consent/progress UI. */
  readonly size: string;
  readonly dtype?: { webgpu: "fp32" | "fp16" | "q8"; wasm: "fp32" | "fp16" | "q8" };
  /** For runtime "onnx": URL relative to the app. */
  readonly url?: string;
};

export const MODELS = {
  birefnet: {
    id: "onnx-community/BiRefNet_lite-ONNX",
    task: "subject",
    runtime: "transformers",
    label: "BiRefNet Lite",
    license: "MIT",
    size: "115 MB",
    dtype: { webgpu: "fp16", wasm: "fp32" },
  },
  modnet: {
    id: "Xenova/modnet",
    task: "subject",
    runtime: "transformers",
    label: "MODNet (portraits, fast)",
    license: "Apache-2.0",
    size: "7 MB",
    dtype: { webgpu: "fp16", wasm: "q8" },
  },
  u2netp: {
    id: "u2netp",
    task: "subject",
    runtime: "onnx",
    label: "U²-Netp (bundled, offline)",
    license: "Apache-2.0",
    size: "4.6 MB",
    url: "models/u2netp/u2netp.onnx",
  },
  panoptic: {
    id: "Xenova/detr-resnet-50-panoptic",
    task: "semantic",
    runtime: "transformers",
    label: "DETR panoptic (sky, people)",
    license: "Apache-2.0",
    size: "45 MB",
    dtype: { webgpu: "fp32", wasm: "q8" },
  },
  slimsam: {
    id: "Xenova/slimsam-77-uniform",
    task: "object",
    runtime: "transformers",
    label: "SlimSAM (click to select)",
    license: "Apache-2.0",
    size: "14 MB",
    dtype: { webgpu: "fp32", wasm: "q8" },
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;

/** COCO panoptic labels that make up each semantic target. */
export const SEMANTIC_LABELS: Record<"sky" | "person", readonly string[]> = {
  sky: ["sky-other-merged", "sky"],
  person: ["person"],
};
