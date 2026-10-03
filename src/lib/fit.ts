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

/**
 * Where a picture of `natural` size lands in a viewer `width` × `height` (CSS px), as
 * the viewers draw it: fitted inside `pad`, centred; with a panel covering `cover` px of
 * the bottom it either fits whole above the panel (`under` false: the Library, tools)
 * or keeps the whole-viewer size and sits clear of the panel where it can (`under`
 * true: Develop's editing, see `placeClear`). Used to put a gallery swipe's next photo
 * exactly where the viewer will show it.
 */
export function placePicture(
  natural: { width: number; height: number },
  width: number,
  height: number,
  { pad = 16, cover = 0, under = false }: { pad?: number; cover?: number; under?: boolean } = {},
): { left: number; top: number; width: number; height: number } {
  const room = under ? height : height - cover;
  const scale = Math.max(0, Math.min((width - pad * 2) / natural.width, (room - pad * 2) / natural.height));
  const w = natural.width * scale;
  const h = natural.height * scale;
  const top = under ? placeClear(h, height, cover, pad) : pad + (room - pad * 2 - h) / 2;
  return { left: (width - w) / 2, top, width: w, height: h };
}
