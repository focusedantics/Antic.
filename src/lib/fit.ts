/**
 * Where a picture goes when a translucent panel floats over the bottom of its viewer
 * (phones, like Lightroom mobile). The picture keeps the size that fits the whole
 * viewer; this picks its top edge.
 *
 * - No panel: centred.
 * - It fits above the panel: centred in the part the panel leaves free.
 * - It doesn't: from the top (`pad`), so as much as possible stays uncovered.
 *
 * All lengths in the same unit (CSS or device px). `shown` is the picture's height
 * on screen, `height` the viewer's, `cover` how much of the viewer's bottom the panel
 * covers, `pad` the margin kept at the top and above the panel.
 */
export function placeClear(shown: number, height: number, cover: number, pad = 0): number {
  if (cover <= 0) return (height - shown) / 2;
  const free = height - cover - pad * 2;
  return pad + Math.max(0, (free - shown) / 2);
}
