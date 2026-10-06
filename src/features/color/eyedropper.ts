import { createStore } from "zustand/vanilla";
import { composite } from "@/core/document/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { rgbToHex } from "@/lib/hsv";

/**
 * Picking a colour from the design. Browsers with the EyeDropper API (Chrome, Edge) pick
 * from anywhere on screen; elsewhere (Safari, Firefox) the canvas takes the next tap
 * and reads the design's own pixels (a render at up to 1024 px).
 */
export const eyedropper = createStore<{ pick: ((hex: string) => void) | null }>(() => ({ pick: null }));

type NativeEyeDropper = { open: () => Promise<{ sRGBHex: string }> };
const native = () => (typeof window !== "undefined" && "EyeDropper" in window ? new (window as unknown as { EyeDropper: new () => NativeEyeDropper }).EyeDropper() : null);

export async function pickColor(onPick: (hex: string) => void) {
  const dropper = native();
  if (dropper) {
    try {
      const { sRGBHex } = await dropper.open();
      const hex = /^#[0-9a-f]{6}$/i.test(sRGBHex) ? sRGBHex : rgbFromCss(sRGBHex);
      if (hex) onPick(hex.toLowerCase());
    } catch {
      // Cancelled.
    }
    return;
  }
  eyedropper.setState({ pick: onPick });
}

const rgbFromCss = (s: string) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
  return m ? rgbToHex({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }) : null;
};

let sample: { doc: unknown; image: ImageData; scale: number } | null = null;
/** The design's colour at a document point (rendered once per pick session). */
export function colorAt(x: number, y: number): string | null {
  const doc = composite.getState().doc;
  if (!doc) return null;
  if (!sample || sample.doc !== doc) {
    const scale = Math.min(1, 1024 / Math.max(doc.width, doc.height));
    sample = { doc, image: developEngine().renderDocument(doc, scale), scale };
  }
  const { image, scale } = sample;
  const px = Math.min(image.width - 1, Math.max(0, Math.floor(x * scale)));
  const py = Math.min(image.height - 1, Math.max(0, Math.floor(y * scale)));
  const i = (py * image.width + px) * 4;
  const a = image.data[i + 3] / 255;
  // Transparent areas read as the colour over white.
  const over = (c: number) => c * a + 255 * (1 - a);
  return rgbToHex({ r: over(image.data[i]), g: over(image.data[i + 1]), b: over(image.data[i + 2]) });
}

export function finishPick(hex: string | null) {
  const pick = eyedropper.getState().pick;
  eyedropper.setState({ pick: null });
  sample = null;
  if (hex && pick) pick(hex);
}
