import { createStore } from "zustand/vanilla";

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
};

const KEY = "focused:prefs";
const defaults: Prefs = { backdrop: true, tourDone: false };

export function sanitizePrefs(v: unknown): Prefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    backdrop: typeof o.backdrop === "boolean" ? o.backdrop : defaults.backdrop,
    tourDone: typeof o.tourDone === "boolean" ? o.tourDone : defaults.tourDone,
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
