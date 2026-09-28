import { createStore } from "zustand/vanilla";

/**
 * App-wide "something is happening" signal for the thin progress line at the top
 * of the window. Work registers while it runs (`beginActivity` / `track`); quick
 * changes that finish within a frame call `pulseActivity` so they still register.
 */
export const activity = createStore<{ running: number; pulses: number }>(() => ({ running: 0, pulses: 0 }));

export function beginActivity(): () => void {
  activity.setState((s) => ({ running: s.running + 1 }));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activity.setState((s) => ({ running: Math.max(0, s.running - 1) }));
  };
}

export async function track<T>(work: Promise<T>): Promise<T> {
  const end = beginActivity();
  try {
    return await work;
  } finally {
    end();
  }
}

export function pulseActivity() {
  activity.setState((s) => ({ pulses: s.pulses + 1 }));
}
