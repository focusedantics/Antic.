import type { Template } from "./templates";

/**
 * A fingerprint of what a template draws: its canvas and layers, ids left out (they are
 * new every build). The rendered previews in public/templates/ record the fingerprint they
 * were made from, so a test notices a template changed without its preview being redone.
 */
export function templateHash(t: Template): string {
  const layers = t.build({ width: t.width, height: t.height });
  const json = JSON.stringify([t.width, t.height, t.background, t.slides ?? 1, layers], (key, value) =>
    key === "id" || key === "link" ? undefined : typeof value === "number" ? Math.round(value * 1000) / 1000 : value,
  );
  // FNV-1a, 32 bits, twice with different seeds for 64 bits of fingerprint.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
