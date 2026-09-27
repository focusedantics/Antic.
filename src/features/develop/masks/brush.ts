import { createStore } from "zustand/vanilla";

/** Brush tool settings. Tool state, not document content: not part of recipes or history. */
export type BrushSettings = {
  /** Diameter as a fraction of the photo's long side. */
  readonly size: number;
  readonly feather: number;
  readonly flow: number;
  readonly density: number;
  readonly erase: boolean;
};

export const brush = createStore<BrushSettings>(() => ({ size: 0.06, feather: 0.6, flow: 0.8, density: 1, erase: false }));
