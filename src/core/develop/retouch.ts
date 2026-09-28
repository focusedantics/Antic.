import { createId } from "@/lib/id";
import type { Spot } from "./recipe";

/**
 * Finds a source for a spot: among candidates on rings around the blemish, the
 * one whose surrounding annulus best matches the blemish's annulus (tone and
 * texture) wins, with a small preference for nearby candidates.
 *
 * `pixels` is an RGBA float grid of `size × size` covering the square region
 * `[x - span, x + span] × [y - span*aspect…]` — see `searchRegion`.
 */
export function findSource(pixels: Float32Array, size: number, radiusCells: number): { dx: number; dy: number } {
  const lum = (i: number) => 0.2627 * pixels[i * 4] + 0.678 * pixels[i * 4 + 1] + 0.0593 * pixels[i * 4 + 2];
  const at = (x: number, y: number) => lum(Math.max(0, Math.min(size - 1, Math.round(y))) * size + Math.max(0, Math.min(size - 1, Math.round(x))));
  const c = size / 2;
  const ring: [number, number][] = [];
  for (let a = 0; a < 24; a++) {
    const t = (a / 24) * Math.PI * 2;
    for (const k of [1.15, 1.45]) ring.push([Math.cos(t) * radiusCells * k, Math.sin(t) * radiusCells * k]);
  }
  const disk: [number, number][] = [];
  for (let a = 0; a < 12; a++) {
    const t = (a / 12) * Math.PI * 2;
    for (const k of [0.3, 0.7]) disk.push([Math.cos(t) * radiusCells * k, Math.sin(t) * radiusCells * k]);
  }
  const destRing = ring.map(([x, y]) => at(c + x, c + y));
  let best = { dx: radiusCells * 2.5, dy: 0, score: Infinity };
  for (const distance of [2.2, 3, 4]) {
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * Math.PI * 2;
      const dx = Math.cos(t) * radiusCells * distance;
      const dy = Math.sin(t) * radiusCells * distance;
      // The candidate must fit inside the searched region.
      if (Math.abs(dx) + radiusCells * 1.5 > c || Math.abs(dy) + radiusCells * 1.5 > c) continue;
      let score = 0;
      ring.forEach(([x, y], i) => {
        const d = at(c + dx + x, c + dy + y) - destRing[i];
        score += d * d;
      });
      // Penalize busy candidate interiors: a clean patch is what we want to copy.
      const inside = disk.map(([x, y]) => at(c + dx + x, c + dy + y));
      const mean = inside.reduce((s, v) => s + v, 0) / inside.length;
      const variance = inside.reduce((s, v) => s + (v - mean) ** 2, 0) / inside.length;
      score = score / ring.length + variance * 0.5 + distance * 1e-5;
      if (score < best.score) best = { dx, dy, score };
    }
  }
  return { dx: best.dx, dy: best.dy };
}

export function newSpot(x: number, y: number, sourceX: number, sourceY: number, radius: number, mode: Spot["mode"] = "heal"): Spot {
  return { id: createId("spot"), mode, x, y, sourceX, sourceY, radius, feather: 50, opacity: 1 };
}
