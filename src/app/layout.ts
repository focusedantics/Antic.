import { createStore } from "zustand/vanilla";

/**
 * Compact layout: phones (portrait, or landscape with a touch screen and little
 * height). The viewer fills the screen, panels open as a sheet from a bottom
 * dock, and the top bar folds its buttons into a menu. Computers keep the
 * three-column layout.
 */
export const COMPACT_QUERY = "(max-width: 780px), (max-height: 520px) and (pointer: coarse)";

/** Which side's panels the phone sheet shows. */
export type SheetSide = "left" | "right";

const media = typeof matchMedia === "function" ? matchMedia(COMPACT_QUERY) : null;

export const layout = createStore<{ compact: boolean; sheet: SheetSide | null }>(() => ({ compact: !!media?.matches, sheet: null }));

media?.addEventListener("change", (e) => layout.setState({ compact: e.matches, sheet: null }));

export const openSheet = (sheet: SheetSide | null) => layout.setState({ sheet });
