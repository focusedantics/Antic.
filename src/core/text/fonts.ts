import { createStore } from "zustand/vanilla";

/**
 * Fonts for text layers and watermarks. Bundled families are open-licensed
 * (SIL OFL 1.1 / Apache-2.0, via Fontsource) and declared in
 * `styles/fonts.css`; the browser downloads a file only when it is used.
 * Canvas text does not trigger downloads reliably, so renderers call
 * `ensureFont` and re-render when `fontLoads.generation` changes, and exports
 * `await loadFonts` first.
 */
export type FontGroup = "Sans" | "Serif" | "Display" | "Script & hand" | "Mono & pixel" | "System";
export type FontDef = { readonly label: string; readonly css: string; readonly group: FontGroup };

export const FONT_GROUPS: readonly FontGroup[] = ["Sans", "Serif", "Display", "Script & hand", "Mono & pixel", "System"];

export const FONTS: readonly FontDef[] = [
  { label: "Inter", css: "Inter, system-ui, sans-serif", group: "Sans" },
  { label: "Montserrat", css: "Montserrat, sans-serif", group: "Sans" },
  { label: "Oswald", css: "Oswald, 'Arial Narrow', sans-serif", group: "Sans" },
  { label: "Playfair Display", css: "'Playfair Display', Georgia, serif", group: "Serif" },
  { label: "DM Serif Display", css: "'DM Serif Display', Georgia, serif", group: "Serif" },
  { label: "Bebas Neue", css: "'Bebas Neue', Impact, sans-serif", group: "Display" },
  { label: "Anton", css: "Anton, Impact, sans-serif", group: "Display" },
  { label: "Righteous", css: "Righteous, sans-serif", group: "Display" },
  { label: "Monoton (neon)", css: "Monoton, sans-serif", group: "Display" },
  { label: "Bungee Shade (3D)", css: "'Bungee Shade', sans-serif", group: "Display" },
  { label: "Nabla (colour 3D)", css: "Nabla, sans-serif", group: "Display" },
  { label: "Lobster", css: "Lobster, cursive", group: "Script & hand" },
  { label: "Pacifico", css: "Pacifico, cursive", group: "Script & hand" },
  { label: "Caveat", css: "Caveat, cursive", group: "Script & hand" },
  { label: "Permanent Marker", css: "'Permanent Marker', cursive", group: "Script & hand" },
  { label: "Space Mono", css: "'Space Mono', monospace", group: "Mono & pixel" },
  { label: "VT323 (terminal)", css: "VT323, monospace", group: "Mono & pixel" },
  { label: "Press Start 2P (pixel)", css: "'Press Start 2P', monospace", group: "Mono & pixel" },
  { label: "Georgia", css: "Georgia, serif", group: "System" },
  { label: "Times New Roman", css: "'Times New Roman', serif", group: "System" },
  { label: "Helvetica / Arial", css: "'Helvetica Neue', Arial, sans-serif", group: "System" },
  { label: "Courier New", css: "'Courier New', monospace", group: "System" },
  { label: "Trebuchet MS", css: "'Trebuchet MS', sans-serif", group: "System" },
  { label: "Impact", css: "Impact, sans-serif", group: "System" },
  { label: "Brush Script", css: "'Brush Script MT', cursive", group: "System" },
];

/** Label for a stored CSS family (documents may hold stacks from older versions). */
export const fontLabel = (css: string) => FONTS.find((f) => f.css === css)?.label ?? css.split(",")[0].replace(/['"]/g, "").trim();

/** Bumped whenever a font finishes loading, so cached text rasters are redrawn. */
export const fontLoads = createStore<{ generation: number }>(() => ({ generation: 0 }));

const pending = new Set<string>();
const canCheck = () => typeof document !== "undefined" && !!document.fonts;

/** Starts loading `font` (a CSS font shorthand) if needed; true when it can be drawn now. */
export function ensureFont(font: string): boolean {
  if (!canCheck()) return true;
  let ready = true;
  try {
    ready = document.fonts.check(font);
  } catch {
    return true;
  }
  if (ready || pending.has(font)) return ready;
  pending.add(font);
  document.fonts
    .load(font)
    .catch(() => undefined)
    .finally(() => {
      pending.delete(font);
      fontLoads.setState((s) => ({ generation: s.generation + 1 }));
    });
  return false;
}

/** Waits (up to `timeoutMs`) for fonts to be available before an export draws them. */
export async function loadFonts(fonts: readonly string[], timeoutMs = 8000): Promise<void> {
  if (!canCheck() || !fonts.length) return;
  const all = Promise.all([...new Set(fonts)].map((f) => document.fonts.load(f).catch(() => undefined)));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}
