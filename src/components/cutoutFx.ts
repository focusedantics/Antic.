import { holdAtLeast, nextPaint, PACE, prefersReducedMotion, sleep } from "@/lib/pacing";
import { ParticleGlobe } from "./particleGlobe";

/**
 * The Remove Background animation, drawn on a 2D canvas laid over a viewer canvas.
 *
 * Working (any length): the photo lifts into a turning globe of its own pixels
 * (`ParticleGlobe`); the pointer tilts it and parts the particles, and a dotted ring
 * fills while the model downloads the first time. It turns for as long as the AI
 * takes, and at least GLOBE_MIN so a quick result still shows it form. Then the
 * particles spring back into the photo.
 *
 * Reveal (fixed ~1.4 s): the overlay freezes the "before" frame, the cutout is
 * applied underneath, and the pixels that changed (the background) break into
 * particles that blow away from the subject — and from the pointer — while the
 * subject's outline lights up. Reduced motion: a short crossfade instead.
 *
 * The overlay ignores the pointer (the app stays usable) and reads it from window events.
 */
export type CutoutFx = {
  /** Plays the reveal around `apply` (which changes the picture underneath), then removes itself. */
  reveal(apply: () => void): Promise<void>;
  /** Removes the overlay at once (the work failed or was abandoned). */
  cancel(): void;
};

type Box = { x0: number; y0: number; x1: number; y1: number };
type Particle = { x: number; y: number; vx: number; vy: number; spin: number; color: string; size: number; delay: number };

const REVEAL_MS = 1400;

/** A copy of what the canvas shows now (it is drawn with preserveDrawingBuffer, or is a 2D canvas). */
function capture(canvas: HTMLCanvasElement): ImageData | null {
  try {
    const c = new OffscreenCanvas(canvas.width, canvas.height);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(canvas, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  } catch {
    return null;
  }
}

/** The picture's bounds in a capture: everything that is not transparent surround. */
function boundsOf(img: ImageData): Box | null {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 200));
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1: Math.min(w, x1 + step), y1: Math.min(h, y1 + step) };
}

/** Fraction of sampled pixels that differ between two captures. */
function changedShare(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0, total = 0;
  const step = 7 * 4;
  for (let i = 0; i < a.data.length; i += step * 5) {
    total++;
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) + Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (d > 40) changed++;
  }
  return changed / Math.max(1, total);
}

/** What the working phase reports: a line for screen readers, and the model download (0–100) or null. */
export type CutoutStatus = () => { text: string; progress: number | null };

/** The globe stays up at least this long, so it has time to form and be seen. */
const GLOBE_MIN = 1500;

export function startCutoutFx(canvas: HTMLCanvasElement | null, status: CutoutStatus): CutoutFx {
  const host = canvas?.parentElement;
  if (!canvas || !host) return { reveal: async (apply) => apply(), cancel: () => {} };
  const started = performance.now();
  const still = prefersReducedMotion();
  const before = capture(canvas);
  const scale = canvas.width / Math.max(1, canvas.clientWidth); // capture px per CSS px
  const box = before ? boundsOf(before) : null;
  const place = (el: HTMLElement) =>
    Object.assign(el.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` });

  const overlay = document.createElement("canvas");
  overlay.className = "cutout-fx";
  overlay.dataset.testid = "cutout-fx";
  overlay.dataset.phase = "globe";
  overlay.setAttribute("aria-hidden", "true");
  place(overlay);
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  host.append(overlay);
  // Screen readers hear the stage; nothing extra is drawn over the picture.
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  live.dataset.testid = "cutout-status";
  host.append(live);
  const g = overlay.getContext("2d")!;

  // The photo lifts into a turning globe of its own pixels while the AI works.
  const area: Box = box ?? { x0: 0, y0: 0, x1: overlay.width, y1: overlay.height };
  const globe = !still && before ? new ParticleGlobe(before, area, scale) : null;
  if (globe?.ready) {
    globe.canvas.className = "cutout-fx";
    globe.canvas.dataset.testid = "cutout-globe";
    place(globe.canvas);
    host.append(globe.canvas);
    globe.spring.to(1, 55, 16, 1);
  }

  // Pointer in capture pixels for the dissolve (the overlays never take the pointer).
  const ptr = { x: -1e4, y: -1e4 };
  const onMove = (e: PointerEvent) => {
    const r = overlay.getBoundingClientRect();
    ptr.x = (e.clientX - r.left) * scale;
    ptr.y = (e.clientY - r.top) * scale;
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  let raf = 0;
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
    phase = "gone";
    clearInterval(ticker);
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove);
    globe?.dispose();
    overlay.remove();
    live.remove();
  };

  const reveal = async (apply: () => void) => {
    // A quick result still lets the globe form; a slow one has been turning all along.
    await holdAtLeast(started, globe?.ready ? GLOBE_MIN : PACE.minWorking);
    if (phase === "gone") return apply();
    phase = "reveal";
    overlay.dataset.phase = "reveal";
    clearInterval(ticker);
    globe?.setProgress(null);
    live.textContent = "Background removed";
    // The particles fall back into the photo; it ends exactly on the "before" frame.
    if (globe?.ready) {
      globe.spring.to(0, 70, 16, 1);
      await globe.settle();
    }
    // Freeze the "before" frame on top, so the change underneath never pops.
    g.clearRect(0, 0, overlay.width, overlay.height);
    if (before) g.putImageData(before, 0, 0);
    globe?.dispose();
    apply();
    // Wait (up to ~1.5 s) for the viewer to draw the cutout.
    let after: ImageData | null = null;
    for (let i = 0; i < 45; i++) {
      await nextPaint();
      const now = capture(canvas);
      if (now && before && changedShare(before, now) > 0.002) {
        await nextPaint();
        after = capture(canvas);
        break;
      }
    }
    if (!before || !after || still) {
      // Crossfade: fade the frozen frame out.
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / 250);
          overlay.style.opacity = String(1 - k);
          if (k < 1) raf = requestAnimationFrame(step);
          else resolve();
        };
        raf = requestAnimationFrame(step);
      });
      await sleep(still ? 300 : 0);
      remove();
      return;
    }
    // Background = pixels that changed. Particles start exactly where they were.
    const w = before.width;
    const cell = Math.max(3, Math.round(Math.sqrt(((area.x1 - area.x0) * (area.y1 - area.y0)) / 9000)));
    const changed = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i + 1] - after.data[i + 1]) + Math.abs(before.data[i + 2] - after.data[i + 2]) + Math.abs(before.data[i + 3] - after.data[i + 3]) > 40;
    };
    let cx = 0, cy = 0, kept = 0;
    const particles: Particle[] = [];
    const edges: { x: number; y: number }[] = [];
    for (let y = area.y0; y < area.y1 - 1; y += cell)
      for (let x = area.x0; x < area.x1 - 1; x += cell) {
        if (!changed(x, y)) {
          cx += x;
          cy += y;
          kept++;
          // A subject cell next to a background cell: part of the outline.
          if ((x + cell < area.x1 && changed(x + cell, y)) || (y + cell < area.y1 && changed(x, y + cell)) || (x - cell >= area.x0 && changed(x - cell, y)) || (y - cell >= area.y0 && changed(x, y - cell))) edges.push({ x, y });
          continue;
        }
        const i = (y * w + x) * 4;
        if (before.data[i + 3] < 8) continue;
        particles.push({ x, y, vx: 0, vy: 0, spin: 0, color: `rgb(${before.data[i]}, ${before.data[i + 1]}, ${before.data[i + 2]})`, size: cell, delay: 0 });
      }
    cx = kept ? cx / kept : (area.x0 + area.x1) / 2;
    cy = kept ? cy / kept : (area.y0 + area.y1) / 2;
    const span = Math.max(area.x1 - area.x0, area.y1 - area.y0);
    for (const p of particles) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const speed = (0.25 + Math.random() * 0.55) * span;
      p.vx = (dx / d) * speed + (Math.random() - 0.5) * span * 0.15;
      p.vy = (dy / d) * speed - span * 0.2 * Math.random();
      p.spin = (Math.random() - 0.5) * 6;
      // The wave starts at the subject and runs outward.
      p.delay = Math.min(0.35, (d / span) * 0.45);
    }
    // The frozen frame shows the subject on top of the real cutout: draw just the
    // background as particles from here on.
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const frame = (now: number) => {
        const t = (now - t0) / 1000;
        g.clearRect(0, 0, overlay.width, overlay.height);
        const reach = 110 * scale;
        for (const p of particles) {
          const lt = Math.max(0, t - p.delay);
          const k = Math.min(1, lt / ((REVEAL_MS / 1000) * 0.75));
          if (k >= 1) continue;
          const ease = lt * lt * 0.9;
          let x = p.x + p.vx * ease;
          let y = p.y + p.vy * ease - 40 * scale * lt;
          // The pointer scatters them.
          const dx = x - ptr.x;
          const dy = y - ptr.y;
          const near = Math.exp(-(dx * dx + dy * dy) / (reach * reach));
          if (near > 0.01) {
            const d = Math.hypot(dx, dy) || 1;
            x += (dx / d) * near * 60 * scale;
            y += (dy / d) * near * 60 * scale;
          }
          const s = p.size * (1 - k * 0.8);
          g.globalAlpha = lt === 0 ? 1 : (1 - k) ** 1.5;
          g.fillStyle = p.color;
          if (lt === 0) {
            g.fillRect(x - s / 2, y - s / 2, s, s);
            continue;
          }
          const a = p.spin * lt;
          g.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), x, y);
          g.fillRect(-s / 2, -s / 2, s, s);
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        // The outline lights up as the background leaves, then fades.
        const glow = Math.sin(Math.min(1, t / (REVEAL_MS / 1000)) * Math.PI);
        g.globalAlpha = glow * 0.9;
        g.fillStyle = "rgb(190, 248, 255)";
        const r = Math.max(1, cell * 0.35);
        for (const e of edges) g.fillRect(e.x + cell / 2 - r, e.y + cell / 2 - r, r * 2, r * 2);
        g.globalAlpha = 1;
        if (t * 1000 < REVEAL_MS) raf = requestAnimationFrame(frame);
        else resolve();
      };
      raf = requestAnimationFrame(frame);
    });
    remove();
  };

  return { reveal, cancel: remove };
}
