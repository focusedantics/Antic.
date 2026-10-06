import { createStore } from "zustand/vanilla";
import { getDesignAsset } from "@/core/catalog/db";

/**
 * Custom brush tips: small grey images kept as design assets ("brush"), decoded on first
 * use. Drawing never waits: until a tip has loaded its strokes draw with a round dab,
 * and `tipLoads.generation` changes when one arrives so paint layers redraw.
 */
export const tipLoads = createStore<{ generation: number }>(() => ({ generation: 0 }));
const tips = new Map<string, { image: ImageBitmap; spacing: number } | "loading" | "missing">();

export function brushTip(id: string): { image: ImageBitmap; spacing: number } | null {
  const hit = tips.get(id);
  if (hit && hit !== "loading" && hit !== "missing") return hit;
  if (!hit) {
    tips.set(id, "loading");
    void getDesignAsset(id)
      .then(async (record) => {
        const data = record?.data as { tip?: unknown; spacing?: unknown } | undefined;
        if (!(data?.tip instanceof Blob)) return tips.set(id, "missing");
        tips.set(id, { image: await createImageBitmap(data.tip), spacing: typeof data.spacing === "number" ? data.spacing : 0.2 });
        tipLoads.setState((s) => ({ generation: s.generation + 1 }));
      })
      .catch(() => tips.set(id, "missing"));
  }
  return null;
}

/** Forget a cached tip (after it is replaced or deleted). */
export const forgetTip = (id: string) => tips.delete(id);

/**
 * A brush tip from an image: coverage from its transparency when it has some, otherwise
 * from darkness (dark paints, white doesn't), squared up and at most 128 px.
 */
export async function tipFromImage(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const side = Math.min(128, Math.max(bitmap.width, bitmap.height));
  const k = side / Math.max(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(side, side);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const w = Math.round(bitmap.width * k);
  const h = Math.round(bitmap.height * k);
  ctx.drawImage(bitmap, (side - w) / 2, (side - h) / 2, w, h);
  bitmap.close();
  const img = ctx.getImageData(0, 0, side, side);
  const d = img.data;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) transparent++;
  const useAlpha = transparent > d.length / 4 / 20;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const a = useAlpha ? d[i + 3] / 255 : 1 - lum;
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
