/** Sent on `window` when the GPU context is lost (the app says so); `detail.side` is the long side photos come back at. */
export const GPU_RESET_EVENT = "focused:gpu-reset";

/**
 * The render engine once it exists (it loads with the first workspace that draws), for
 * views that only report on it or ask it to let go: reading this never loads the engine.
 */
export const engineRef: { current: { stats(): { gpuBytes: number; textures: number; sources: number; cpuBytes: number }; freeMemory(): void } | null } = { current: null };
