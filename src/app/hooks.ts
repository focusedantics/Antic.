import { useSyncExternalStore } from "react";
import type { StoreApi } from "zustand/vanilla";

/** Subscribes a component to a slice of a vanilla store. Return stable values from `select`. */
export function useStore<T, U>(store: StoreApi<T>, select: (state: T) => U): U {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}
