import { createStore } from "zustand/vanilla";
import { catalog } from "@/core/catalog/store";
import { keepStorage, measureStorage, removeDownloadedModels, removeLeftoverFiles, type Usage } from "@/core/catalog/usage";
import { holdAtLeast, nextPaint, PACE, sleep } from "@/lib/pacing";

/**
 * The Storage view's state: the last count of what is kept, and where a count in progress
 * has got to. Counting is work of unknown length (it walks every store), so it follows
 * lib/pacing.ts: the working state shows within a frame and names its stage, stays at
 * least `PACE.minWorking`, and ends on a short done beat.
 */
export type StorageState = {
  readonly usage: Usage | null;
  readonly phase: "idle" | "working" | "done";
  /** What is being counted right now ("previews", "masks"…). */
  readonly stage: string;
  readonly error: string | null;
  /** When the count shown was taken. */
  readonly at: number;
};

export const storage = createStore<StorageState>(() => ({ usage: null, phase: "idle", stage: "", error: null, at: 0 }));

let run = 0;

/** Counts again. A second call while one is running takes over from it. */
export async function measure() {
  const mine = ++run;
  const started = performance.now();
  storage.setState({ phase: "working", stage: "photos", error: null });
  await nextPaint();
  try {
    const usage = await measureStorage({
      assets: catalog.getState().assets.values(),
      onStage: (stage) => mine === run && storage.setState({ stage }),
    });
    await holdAtLeast(started);
    if (mine !== run) return;
    storage.setState({ usage, phase: "done", stage: "", at: Date.now() });
    await sleep(PACE.doneBeat);
    if (mine === run) storage.setState({ phase: "idle" });
  } catch (error) {
    if (mine === run) storage.setState({ phase: "idle", stage: "", error: error instanceof Error ? error.message : String(error) });
  }
}

/** Removes the downloaded AI models, then counts again. */
export async function clearModels() {
  await removeDownloadedModels();
  await measure();
}

/** Removes the files nothing refers to, then counts again. */
export async function clearLeftovers() {
  await removeLeftoverFiles(storage.getState().usage?.leftover ?? []);
  await measure();
}

/** Asks the browser to keep this site's data; the answer shows in the next count. */
export async function askToKeep(): Promise<boolean> {
  const kept = await keepStorage();
  const usage = storage.getState().usage;
  if (usage) storage.setState({ usage: { ...usage, persisted: kept } });
  return kept;
}
