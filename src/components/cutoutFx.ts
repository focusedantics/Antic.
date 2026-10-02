import { createStore } from "zustand/vanilla";
import { holdAtLeast, nextPaint, PACE, prefersReducedMotion } from "@/lib/pacing";
import { type Grid, Kind, ParticleGlobe, type Rect } from "./particleGlobe";

/**
 * The Remove Background animation, laid over a viewer canvas. Everything moves on
 * the GPU (`ParticleGlobe`):
 *
 * - Working (any length): the photo lifts into a turning globe of its own pixels;
 *   the pointer tilts it and parts the particles, and a dotted ring fills while the
 *   model downloads the first time. At least GLOBE_MIN, so a quick result still shows
 *   it form. Then the particles spring back into the photo.
 * - Reveal (~1.4 s): the exact photo is held on top while the cutout is applied
 *   underneath; the particles whose colour changed (the background) burst away from
 *   the subject — and from the pointer — while its outline glows.
 *
 * One run at a time (`cutoutRun`). If the viewer goes away (another workspace, another
 * photo) the animation stops at once and the result is applied without it. The
 * overlays ignore the pointer. Reduced motion or no WebGL2: a short crossfade.
 */
export type CutoutFx = {
  /** Plays the reveal around `apply` (which changes the picture underneath), then removes itself. */
  reveal(apply: () => void): Promise<void>;
  /** Removes the overlay at once (the work failed or was abandoned). */
  cancel(): void;
};

/** What the working phase reports: a line for screen readers, and the model download (0–100) or null. */
export type CutoutStatus = () => { text: string; progress: number | null };

/** True while a Remove Background runs anywhere: its buttons are disabled meanwhile. */
export const cutoutRun = createStore<{ running: boolean }>(() => ({ running: false }));

/** The globe stays up at least this long, so it has time to form and be seen. */
const GLOBE_MIN = 1500;
/** Captures for finding the photo and watching for the change are at most this wide. */
const PROBE = 640;

function draw(canvas: HTMLCanvasElement, w: number, h: number, sx = 0, sy = 0, sw = canvas.width, sh = canvas.height): ImageData | null {
  try {
    const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height);
  } catch {
    return null;
  }
}

/** The photo inside the viewer canvas: everything that is not transparent surround, to the pixel. */
export function photoBounds(canvas: HTMLCanvasElement): Rect | null {
  const s = Math.min(1, PROBE / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const img = draw(canvas, w, h);
  if (!img) return null;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (img.data[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  // Back to canvas pixels, one probe pixel wider on every side so no edge of the photo peeks out.
  return {
    x0: Math.max(0, Math.floor((x0 - 1) / s)),
    y0: Math.max(0, Math.floor((y0 - 1) / s)),
    x1: Math.min(canvas.width, Math.ceil((x1 + 2) / s)),
    y1: Math.min(canvas.height, Math.ceil((y1 + 2) / s)),
  };
}

/** One averaged sample per particle over the photo. */
function sampleGrid(canvas: HTMLCanvasElement, box: Rect, columns: number, rows: number): Grid | null {
  const img = draw(canvas, columns, rows, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  return img ? { columns, rows, rgba: img.data } : null;
}

const differs = (a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) =>
  Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 40;

/** Background (changed), subject, or the subject's outline, per particle; and the subject's centre. */
export function classify(before: Grid, after: Grid, box: Rect): { kinds: Uint8Array; center: { x: number; y: number }; changed: number } {
  const { columns: C, rows: R } = before;
  const kinds = new Uint8Array(C * R);
  let changed = 0;
  for (let i = 0; i < C * R; i++)
    if (differs(before.rgba, after.rgba, i * 4)) {
      kinds[i] = Kind.Background;
      changed++;
    }
  let sx = 0, sy = 0, n = 0;
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      if (kinds[i] !== Kind.Subject) continue;
      sx += c;
      sy += r;
      n++;
      const bg = (cc: number, rr: number) => cc >= 0 && rr >= 0 && cc < C && rr < R && kinds[rr * C + cc] === Kind.Background;
      if (bg(c + 1, r) || bg(c - 1, r) || bg(c, r + 1) || bg(c, r - 1)) kinds[i] = Kind.Edge;
    }
  const cw = (box.x1 - box.x0) / C;
  const ch = (box.y1 - box.y0) / R;
  const center = n ? { x: box.x0 + (sx / n + 0.5) * cw, y: box.y0 + (sy / n + 0.5) * ch } : { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  return { kinds, center, changed };
}

/**
 * Runs `work` (the AI) with the animation, once at a time. `work` returns the
 * function that applies the result, or null when there is nothing to apply.
 * Resolves false when another run was already going.
 */
export async function runCutout(canvas: HTMLCanvasElement | null, status: CutoutStatus, work: () => Promise<(() => void) | null>): Promise<boolean> {
  if (cutoutRun.getState().running) return false;
  cutoutRun.setState({ running: true });
  const fx = startCutoutFx(canvas, status);
  try {
    const apply = await work();
    if (!apply) {
      fx.cancel();
      return true;
    }
    await fx.reveal(apply);
    return true;
  } catch (error) {
    fx.cancel();
    throw error;
  } finally {
    cutoutRun.setState({ running: false });
  }
}

export function startCutoutFx(canvas: HTMLCanvasElement | null, status: CutoutStatus): CutoutFx {
  const host = canvas?.parentElement;
  if (!canvas || !host) return { reveal: async (apply) => apply(), cancel: () => {} };
  const started = performance.now();
  const still = prefersReducedMotion();
  const scale = canvas.width / Math.max(1, canvas.clientWidth); // canvas px per CSS px
  const box = photoBounds(canvas) ?? { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
  const place = (el: HTMLElement) =>
    Object.assign(el.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` });

  // About one particle per 4 CSS pixels, at most 180 across: smooth on modest GPUs.
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const columns = Math.max(48, Math.min(180, Math.round(bw / scale / 4)));
  const rows = Math.max(1, Math.round((columns * bh) / Math.max(1, bw)));
  const before = sampleGrid(canvas, box, columns, rows);

  // Screen readers hear the stage; nothing is written over the picture.
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  live.dataset.testid = "cutout-status";
  host.append(live);

  const globe = !still && before ? new ParticleGlobe(canvas, box, before, scale) : null;
  // The element tests and styles look for; the globe canvas when there is one.
  const overlay = globe?.ready ? globe.canvas : document.createElement("canvas");
  overlay.className = "cutout-fx";
  overlay.dataset.testid = "cutout-fx";
  overlay.dataset.phase = "globe";
  overlay.dataset.kind = globe?.ready ? "particles" : "fade";
  overlay.setAttribute("aria-hidden", "true");
  place(overlay);
  if (!globe?.ready) {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
  }
  host.append(overlay);

  let phase: "globe" | "reveal" | "gone" = "globe";
  let lastText = "";
  const report = () => {
    if (phase !== "globe") return;
    const s = status();
    if (s.text !== lastText) live.textContent = lastText = s.text;
    globe?.setProgress(s.progress);
  };
  const ticker = setInterval(report, 250);
  report();

  const remove = () => {
    if (phase === "gone") return;
    phase = "gone";
    clearInterval(ticker);
    globe?.dispose();
    overlay.remove();
    live.remove();
  };
  // Leaving the viewer (another workspace or photo) ends the show; the work still lands.
  const alive = () => overlay.isConnected && canvas.isConnected && canvas.parentElement === host;
  if (globe?.ready) {
    globe.alive = alive;
    globe.onLost = remove;
    globe.spring.to(1, 55, 16, 1);
  }

  const crossfade = async (apply: () => void) => {
    const g = overlay.getContext("2d");
    g?.drawImage(canvas, 0, 0);
    apply();
    await nextPaint();
    await nextPaint();
    overlay.style.transition = "opacity 250ms ease-out";
    overlay.style.opacity = "0";
    await new Promise((r) => setTimeout(r, 260));
    remove();
  };

  const reveal = async (apply: () => void) => {
    // A quick result still lets the globe form; a slow one has been turning all along.
    await holdAtLeast(started, globe?.ready ? GLOBE_MIN : PACE.minWorking);
    if (phase === "gone" || !alive()) {
      remove();
      return apply();
    }
    phase = "reveal";
    overlay.dataset.phase = "reveal";
    clearInterval(ticker);
    live.textContent = "Background removed";
    if (!globe?.ready || !before) return crossfade(apply);
    // The particles fall back into the photo; the exact frame is held on top.
    globe.setProgress(null);
    globe.spring.to(0, 70, 16, 1);
    await globe.settle();
    if (!alive()) return apply();
    apply();
    // Wait (up to ~1.5 s) for the viewer to draw the cutout under the held frame.
    let after: Grid | null = null;
    for (let i = 0; i < 45 && alive(); i++) {
      await nextPaint();
      const now = sampleGrid(canvas, box, columns, rows);
      if (now && classify(before, now, box).changed > 0) {
        await nextPaint();
        after = sampleGrid(canvas, box, columns, rows);
        break;
      }
    }
    if (!after || !alive()) return remove();
    const { kinds, center } = classify(before, after, box);
    await globe.dissolve(kinds, center);
    remove();
  };

  return { reveal, cancel: remove };
}
