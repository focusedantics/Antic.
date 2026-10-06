import { createStore } from "zustand/vanilla";
import { assetData, type DesignAsset, designAssets, type FontData, loadDesignAssets, saveDesignAsset } from "@/core/design/assets";
import { fontLoads } from "./fonts";

/**
 * Fonts the user imported (TTF, OTF, WOFF, WOFF2). The files stay on this device (in the
 * design assets store) and are registered with the page as FontFaces under their own
 * family name; text layers use them like any bundled font.
 */
export type CustomFont = { readonly id: string; readonly family: string; readonly css: string };
export const customFonts = createStore<{ fonts: readonly CustomFont[] }>(() => ({ fonts: [] }));

const registered = new Map<string, FontFace>();
const cssFor = (family: string) => `'${family.replace(/'/g, "")}', sans-serif`;

async function register(asset: DesignAsset): Promise<CustomFont | null> {
  const data = assetData(asset) as FontData | null;
  if (!data || typeof document === "undefined" || !("fonts" in document)) return null;
  if (!registered.has(asset.id)) {
    const face = new FontFace(data.family, await data.file.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    registered.set(asset.id, face);
  }
  return { id: asset.id, family: data.family, css: cssFor(data.family) };
}

let loading: Promise<void> | null = null;
/** Registers every saved font (once; `again` after fonts were added elsewhere, e.g. from a kit); text that uses them redraws when they are ready. */
export function loadCustomFonts(again = false): Promise<void> {
  if (again) loading = null;
  loading ??= (async () => {
    await loadDesignAssets();
    const assets = designAssets.getState().items.filter((a) => a.kind === "font");
    const fonts = (await Promise.all(assets.map((a) => register(a).catch(() => null)))).filter((f): f is CustomFont => !!f);
    customFonts.setState({ fonts });
    if (fonts.length) fontLoads.setState((s) => ({ generation: s.generation + 1 }));
  })();
  return loading;
}

const FORMATS: Record<string, string> = { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" };

/** A family name from a file name ("Lato-Bold.ttf" → "Lato Bold"), unique among my fonts and the bundled ones. */
export function familyFromFile(name: string, taken: readonly string[]): string {
  const base =
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "My font";
  let family = base;
  for (let i = 2; taken.some((t) => t.toLowerCase() === family.toLowerCase()); i++) family = `${base} ${i}`;
  return family;
}

/** Imports font files: each is checked by loading it before it is kept. Returns the fonts added. */
export async function importFonts(files: readonly File[], bundled: readonly string[]): Promise<CustomFont[]> {
  await loadCustomFonts();
  const added: CustomFont[] = [];
  for (const file of files) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!FORMATS[ext]) throw new Error(`${file.name} is not a font file (TTF, OTF, WOFF or WOFF2).`);
    const taken = [...bundled, ...customFonts.getState().fonts.map((f) => f.family), ...added.map((f) => f.family)];
    const family = familyFromFile(file.name, taken);
    // Load it first: a broken file is refused here rather than failing later.
    const face = new FontFace(family, await file.arrayBuffer());
    await face.load();
    const asset = await saveDesignAsset("font", family, { family, file, format: FORMATS[ext] });
    document.fonts.add(face);
    registered.set(asset.id, face);
    added.push({ id: asset.id, family, css: cssFor(family) });
  }
  customFonts.setState((s) => ({ fonts: [...s.fonts, ...added] }));
  fontLoads.setState((s) => ({ generation: s.generation + 1 }));
  return added;
}

/** Forgets a removed font (text using it falls back to the system font). */
export function forgetFont(id: string) {
  const face = registered.get(id);
  if (face) document.fonts.delete(face);
  registered.delete(id);
  customFonts.setState((s) => ({ fonts: s.fonts.filter((f) => f.id !== id) }));
}
