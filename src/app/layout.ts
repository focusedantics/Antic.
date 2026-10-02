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

/** A phone held sideways: panels open beside the picture rather than over it (matches the stylesheet). */
export const SIDEWAYS_QUERY = "(orientation: landscape) and (max-height: 520px)";

const media = typeof matchMedia === "function" ? matchMedia(COMPACT_QUERY) : null;
const sideways = typeof matchMedia === "function" ? matchMedia(SIDEWAYS_QUERY) : null;

export const layout = createStore<{
  compact: boolean;
  sideways: boolean;
  sheet: SheetSide | null;
  /** CSS px of the viewer's bottom that a floating sheet covers (0 when none floats). */
  cover: number;
}>(() => ({ compact: !!media?.matches, sideways: !!sideways?.matches, sheet: null, cover: 0 }));

media?.addEventListener("change", (e) => layout.setState({ compact: e.matches, sheet: null }));
sideways?.addEventListener("change", (e) => layout.setState({ sideways: e.matches }));

export const openSheet = (sheet: SheetSide | null) => layout.setState({ sheet });

/** Where a phone's top bar shows the current workspace's actions (undo, redo, export); see `CompactActions`. */
export const actionsSlot = createStore<{ element: HTMLElement | null }>(() => ({ element: null }));

/**
 * Where a phone's panels float. By default over the bottom of the workspace's centre;
 * a workspace can name a smaller area (Video: the frame, so the transport and the
 * timeline stay in reach). Register it with a ref callback; it clears on unmount.
 */
export const floatHost = createStore<{ element: HTMLElement | null }>(() => ({ element: null }));
export const setFloatHost = (element: HTMLElement | null) => floatHost.setState({ element });
