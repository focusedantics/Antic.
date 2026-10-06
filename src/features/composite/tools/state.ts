import { createStore } from "zustand/vanilla";
import type { BrushKind } from "@/core/document/model";
import { BRUSHES } from "@/core/document/paint";

/**
 * Drawing tool settings (kept for the session and remembered on this device). Sizes are
 * document pixels; a stroke stores its size relative to its layer.
 */
export type PaintSettings = {
  readonly brush: BrushKind;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  readonly hardness: number;
  /** 0..1 streamline. */
  readonly smoothing: number;
  /** Hold at the end of a stroke to straighten it into a line or shape. */
  readonly shapes: boolean;
  /** Tap fills an area (the bucket) instead of drawing. */
  readonly bucket: boolean;
  readonly tolerance: number;
  /** A saved brush's tip (design asset id), stamped instead of the brush's dab. */
  readonly tip: string | null;
};

const KEY = "focused:paint";
const defaults: PaintSettings = { brush: "round", color: "#111111", size: 12, opacity: 1, hardness: 0.2, smoothing: 0.35, shapes: true, bucket: false, tolerance: 0.15, tip: null };

function load(): PaintSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<PaintSettings> | null;
    if (!raw || typeof raw !== "object") return defaults;
    return {
      brush: BRUSHES.some((b) => b.kind === raw.brush) ? (raw.brush as BrushKind) : defaults.brush,
      color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : defaults.color,
      size: typeof raw.size === "number" && raw.size > 0 && raw.size <= 2000 ? raw.size : defaults.size,
      opacity: typeof raw.opacity === "number" && raw.opacity >= 0 && raw.opacity <= 1 ? raw.opacity : defaults.opacity,
      hardness: typeof raw.hardness === "number" && raw.hardness >= 0 && raw.hardness <= 1 ? raw.hardness : defaults.hardness,
      smoothing: typeof raw.smoothing === "number" && raw.smoothing >= 0 && raw.smoothing <= 1 ? raw.smoothing : defaults.smoothing,
      shapes: raw.shapes !== false,
      bucket: false,
      tolerance: typeof raw.tolerance === "number" && raw.tolerance >= 0 && raw.tolerance <= 1 ? raw.tolerance : defaults.tolerance,
      tip: typeof raw.tip === "string" ? raw.tip : null,
    };
  } catch {
    return defaults;
  }
}

export const paint = createStore<PaintSettings>(() => (typeof localStorage === "undefined" ? defaults : load()));
paint.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Settings are a convenience; private windows may refuse storage.
  }
});

/** Picks a brush with its usual size and opacity (kept per brush only for the session). */
const perBrush = new Map<BrushKind, Pick<PaintSettings, "size" | "opacity" | "hardness">>();
export function chooseBrush(kind: BrushKind, docShort: number) {
  const s = paint.getState();
  perBrush.set(s.brush, { size: s.size, opacity: s.opacity, hardness: s.hardness });
  const b = BRUSHES.find((x) => x.kind === kind)!;
  const kept = perBrush.get(kind);
  paint.setState({ brush: kind, bucket: false, tip: null, ...(kept ?? { size: Math.max(1, Math.round(b.size * docShort)), opacity: b.opacity, hardness: b.hardness }) });
}

/**
 * Canvas tools stop the browser's default on pointer down (no text selection, no
 * scrolling), which also keeps focus where it was: give it back to the page so
 * shortcuts (undo, Delete, Escape) reach the canvas, not a colour field.
 */
export function releaseFocus() {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) el.blur();
}
