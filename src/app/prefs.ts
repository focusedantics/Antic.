import { createStore } from "zustand/vanilla";
import { device } from "@/lib/device";

/**
 * Per-browser interface preferences. They are conveniences, not edits, so they
 * live in localStorage (like collapsed panels) and every read and write
 * tolerates storage being unavailable.
 */
export type Prefs = {
  /** The animated glow behind the photo. */
  readonly backdrop: boolean;
  /** The guided tour finished or was skipped; it no longer opens by itself. */
  readonly tourDone: boolean;
  /** Side panels and the filmstrip (Tab and Shift+F, or the toolbar toggles). */
  readonly showLeft: boolean;
  readonly showRight: boolean;
  readonly showFilmstrip: boolean;
  /** Widths the side panels were dragged to; null keeps the stylesheet's default. */
  readonly leftWidth: number | null;
  readonly rightWidth: number | null;
  /** Height of a phone's panel sheet, as a share of the screen. */
  readonly sheetHeight: number;
  /** The histogram floating over the photo in a phone's Develop. */
  readonly showHistogram: boolean;
};

export const PANEL_LIMITS = { left: [180, 480], right: [240, 560], sheet: [0.25, 0.9] } as const;

const KEY = "focused:prefs";
// Phones start without the glow (battery and GPU); it can still be switched on.
const defaults: Prefs = {
  backdrop: !device.phone,
  tourDone: false,
  showLeft: true,
  showRight: true,
  showFilmstrip: true,
  leftWidth: null,
  rightWidth: null,
  sheetHeight: 0.36,
  showHistogram: true,
};

const bool = (v: unknown, f: boolean) => (typeof v === "boolean" ? v : f);
const width = (v: unknown, [min, max]: readonly [number, number]) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : null);

export function sanitizePrefs(v: unknown): Prefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const [sMin, sMax] = PANEL_LIMITS.sheet;
  return {
    backdrop: bool(o.backdrop, defaults.backdrop),
    tourDone: bool(o.tourDone, defaults.tourDone),
    showLeft: bool(o.showLeft, defaults.showLeft),
    showRight: bool(o.showRight, defaults.showRight),
    showFilmstrip: bool(o.showFilmstrip, defaults.showFilmstrip),
    leftWidth: width(o.leftWidth, PANEL_LIMITS.left),
    rightWidth: width(o.rightWidth, PANEL_LIMITS.right),
    showHistogram: bool(o.showHistogram, defaults.showHistogram),
    sheetHeight: typeof o.sheetHeight === "number" && Number.isFinite(o.sheetHeight) ? Math.min(sMax, Math.max(sMin, o.sheetHeight)) : defaults.sheetHeight,
  };
}

function load(): Prefs {
  try {
    return sanitizePrefs(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return defaults;
  }
}

export const prefs = createStore<Prefs>(() => load());

prefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private windows and blocked storage: the preference lasts for this visit.
  }
});

export const setPrefs = (patch: Partial<Prefs>) => prefs.setState(patch);
