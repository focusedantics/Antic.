import { createStore } from "zustand/vanilla";

/**
 * The Design workspace's own UI state (the document itself is the shared composite
 * session's). `home`: the start screen (sizes, templates, your designs) instead of the editor.
 */
export const design = createStore<{ home: boolean }>(() => ({ home: true }));
