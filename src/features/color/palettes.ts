import { createStore } from "zustand/vanilla";
import type { CompositeDocument, Gradient, Layer } from "@/core/document/model";
import { flatten } from "@/core/document/operations";
import { isHex } from "@/lib/hsv";

/** Palettes that come with the app (colour sets chosen for this app; colours are not owned by anyone). */
export const BUILT_IN_PALETTES: readonly { id: string; name: string; colors: readonly string[] }[] = [
  { id: "basics", name: "Basics", colors: ["#000000", "#3a3a3a", "#7a7a7a", "#bdbdbd", "#ffffff", "#e8343a", "#ff7a45", "#ffd34d", "#2fbf71", "#3d8bfd", "#8b5cf6", "#e0457b"] },
  { id: "sunset", name: "Sunset", colors: ["#1a0b2e", "#5b1e6b", "#a12d6b", "#e2486a", "#ff7a5c", "#ffb36b", "#ffe08a"] },
  { id: "ocean", name: "Ocean", colors: ["#03203c", "#0b4f6c", "#127a8a", "#20a39e", "#7dd3c0", "#c9f2e7", "#f4fbf8"] },
  { id: "forest", name: "Forest", colors: ["#1b2b1f", "#2f4a2f", "#4f7341", "#7d9a52", "#b7c58b", "#e5e0b8", "#8a5a3b"] },
  { id: "pastel", name: "Pastel", colors: ["#ffd1dc", "#ffe5b4", "#fff5ba", "#c7f0db", "#c7d2ff", "#e0c7ff", "#f6f2ea"] },
  { id: "neon", name: "Neon", colors: ["#0b0b14", "#ff2ad4", "#ff7ae6", "#7df9ff", "#00d0ff", "#b8ff3d", "#ffe600"] },
  { id: "earth", name: "Earth", colors: ["#3e2c23", "#6b4f3a", "#a47551", "#d4a373", "#e9cba7", "#faedcd", "#7f8b5f"] },
  { id: "retro", name: "Retro", colors: ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#f1faee", "#1d3557"] },
  { id: "candy", name: "Candy", colors: ["#ff5d8f", "#ff97b7", "#ffcad4", "#a0e7e5", "#b4f8c8", "#fbe7c6", "#6c5ce7"] },
  { id: "nordic", name: "Nordic", colors: ["#2e3440", "#4c566a", "#d8dee9", "#eceff4", "#88c0d0", "#81a1c1", "#bf616a"] },
  { id: "mono", name: "Greys", colors: ["#000000", "#1c1c1c", "#383838", "#555555", "#717171", "#8e8e8e", "#aaaaaa", "#c6c6c6", "#e3e3e3", "#ffffff"] },
];

/** Gradients that come with the app. */
const g = (name: string, angle: number, ...colors: string[]): { id: string; name: string; gradient: Gradient } => ({
  id: name.toLowerCase().replace(/\W+/g, "-"),
  name,
  gradient: { type: "linear", angle, scale: 1, offsetX: 0, offsetY: 0, reverse: false, stops: colors.map((c, i) => ({ offset: i / (colors.length - 1), color: c, opacity: 1 })) },
});
export const BUILT_IN_GRADIENTS = [
  g("Sunrise", 90, "#ff5f6d", "#ffc371"),
  g("Lagoon", 120, "#00c6ff", "#0072ff"),
  g("Mint", 135, "#a8ff78", "#78ffd6"),
  g("Berry", 45, "#8e2de2", "#ff6fb5"),
  g("Dusk", 90, "#1a0b2e", "#5b1e6b", "#ff6a5b"),
  g("Peach", 0, "#ffd1dc", "#ffe5b4"),
  g("Night", 90, "#0c1024", "#25305e"),
  g("Gold", 135, "#bf953f", "#fcf6ba", "#b38728"),
  g("Fade to black", 90, "#000000", "#000000"),
].map((x) => (x.name === "Fade to black" ? { ...x, gradient: { ...x.gradient, stops: [{ offset: 0, color: "#000000", opacity: 0 }, { offset: 1, color: "#000000", opacity: 0.8 }] } } : x));

// ─── Recent colours and the chosen palette (per device) ───────────────────────

const RECENT_KEY = "focused:recent-colors";
const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter(isHex).slice(0, 16) : [];
  } catch {
    return [];
  }
};

export const colorPrefs = createStore<{ recent: readonly string[]; palette: string }>(() => ({ recent: typeof localStorage === "undefined" ? [] : read(), palette: "basics" }));

export function pushRecent(hex: string) {
  if (!isHex(hex)) return;
  const recent = [hex.toLowerCase(), ...colorPrefs.getState().recent.filter((c) => c !== hex.toLowerCase())].slice(0, 16);
  colorPrefs.setState({ recent });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Recent colours are a convenience.
  }
}

/** The colours a document uses, most used first (up to 24). */
export function documentColors(doc: CompositeDocument | null): string[] {
  if (!doc) return [];
  const counts = new Map<string, number>();
  const add = (c: string | null | undefined, n = 1) => {
    if (!c || !isHex(c)) return;
    const k = c.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + n);
  };
  const addGradient = (gr: Gradient | undefined) => gr?.stops.forEach((s) => add(s.color));
  add(doc.background, 3);
  for (const l of flatten(doc.layers) as Layer[]) {
    switch (l.kind) {
      case "fill":
        add(l.color, 2);
        break;
      case "gradient":
        addGradient(l.gradient);
        break;
      case "text":
        add(l.style.color, 2);
        addGradient(l.style.gradient);
        add(l.style.highlight?.color);
        break;
      case "shape":
        add(l.style.fill, 2);
        if (l.style.strokeWidth > 0) add(l.style.stroke);
        break;
      case "path":
        add(l.style.fill, 2);
        add(l.style.stroke);
        addGradient(l.style.fillGradient);
        addGradient(l.style.strokeGradient);
        break;
      case "paint":
        for (const op of l.ops) if (op.type === "fill" || op.brush !== "eraser") add(op.color);
        break;
      case "slot":
        break;
    }
    add(l.fx?.shadow?.color);
    add(l.fx?.glow?.color);
    add(l.fx?.outline?.color);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c)
    .slice(0, 24);
}
