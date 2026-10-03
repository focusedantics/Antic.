import { type RefObject, useEffect, useRef } from "react";
import { useStore } from "@/app/hooks";
import { useImageUrl } from "@/app/thumbs";
import { catalog } from "@/core/catalog/store";
import { placePicture } from "@/lib/fit";

/**
 * Swipe between photos like a phone's gallery. A finger (or pen) dragged sideways
 * on the viewer moves the photo with it while the neighbour's preview slides in beside
 * it, already where the viewer will show it. Let go past a third of the way, or with a
 * flick, and it glides on; otherwise it springs back. At the first and last photo the
 * drag gives like a rubber band. After switching, the preview stays up until the viewer
 * shows the new photo (`ready`), so the change never flashes.
 *
 * Mouse input is left alone (computers have the arrow keys and the filmstrip). With
 * reduced motion the switch happens without the glide.
 */
export type GallerySwipeProps = {
  /** The element a finger swipes on (and that the slides are laid over). */
  surface: RefObject<HTMLElement | null>;
  /** Photo ids in viewing order. */
  ids: () => readonly string[];
  current: string | null;
  /** The element showing the current photo, moved with the finger. */
  moving: () => HTMLElement | null;
  /** Whether a swipe may start now (e.g. fitted, no tool, no comparison). */
  enabled: () => boolean;
  /** Return false for presses that belong to something else (a handle, an overlay). */
  accept?: (target: Element) => boolean;
  /** Switches to a photo. */
  go: (id: string) => void;
  /** True once the viewer shows `id`. */
  ready: (id: string) => boolean;
  /** How the viewer places photos (see `placePicture`). */
  place?: () => { pad?: number; cover?: number; under?: boolean };
};

const GAP = 24;
const SLOP = 10;
const GLIDE_MS = 280;
const EASE = "cubic-bezier(0.22, 0.8, 0.3, 1)";
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function GallerySwipe(props: GallerySwipeProps) {
  const opts = useRef(props);
  opts.current = props;
  const prevRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const ids = props.ids();
  const at = props.current ? ids.indexOf(props.current) : -1;
  const prevId = at > 0 ? ids[at - 1] : null;
  const nextId = at >= 0 && at < ids.length - 1 ? ids[at + 1] : null;
  const neighbours = useRef({ prevId, nextId });
  neighbours.current = { prevId, nextId };

  useEffect(() => {
    const surface = props.surface.current;
    if (!surface) return;
    let drag: { pointerId: number; x: number; y: number; dx: number; swiping: boolean; samples: { t: number; x: number }[] } | null = null;
    let settling = false;
    let wait = 0;
    // Pointers down on the surface: a second one means a pinch.
    const fingers = new Set<number>();

    const width = () => surface.clientWidth;
    const slides = () => [prevRef.current, nextRef.current] as const;
    // Lays the slide's photo out where the viewer will show it.
    const layout = (slide: HTMLElement | null) => {
      const img = slide?.querySelector("img");
      if (!slide || !img || !img.naturalWidth) return;
      const r = placePicture({ width: img.naturalWidth, height: img.naturalHeight }, surface.clientWidth, surface.clientHeight, opts.current.place?.());
      Object.assign(img.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const position = (dx: number, animate: boolean) => {
      const w = width();
      const transition = animate ? `transform ${GLIDE_MS}ms ${EASE}` : "none";
      const moving = opts.current.moving();
      if (moving) Object.assign(moving.style, { transition, transform: dx ? `translate3d(${dx}px, 0, 0)` : "" });
      const [prev, next] = slides();
      for (const [slide, offset] of [[prev, -(w + GAP)], [next, w + GAP]] as const) {
        if (!slide) continue;
        Object.assign(slide.style, { transition, transform: `translate3d(${offset + dx}px, 0, 0)`, visibility: dx || animate ? "visible" : "hidden" });
      }
    };
    const reset = () => {
      cancelAnimationFrame(wait);
      settling = false;
      const moving = opts.current.moving();
      if (moving) Object.assign(moving.style, { transition: "", transform: "", visibility: "" });
      for (const slide of slides()) if (slide) Object.assign(slide.style, { transition: "none", transform: "", visibility: "hidden" });
      surface.removeAttribute("data-swiping");
    };

    // After switching: keep the incoming preview where it landed until the viewer has the photo.
    const settle = (id: string, slide: HTMLElement | null) => {
      settling = true;
      const moving = opts.current.moving();
      if (moving) Object.assign(moving.style, { transition: "none", visibility: "hidden" });
      if (slide) Object.assign(slide.style, { transition: "none", transform: "translate3d(0, 0, 0)", visibility: "visible" });
      opts.current.go(id);
      const started = performance.now();
      let frames = 0;
      const check = () => {
        if (!settling) return;
        // Two frames after it reports ready, so the viewer has drawn it.
        if (opts.current.ready(id) ? ++frames > 2 : performance.now() - started > 6000) return reset();
        wait = requestAnimationFrame(check);
      };
      wait = requestAnimationFrame(check);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fingers.add(e.pointerId);
      if (fingers.size > 1) {
        // A second finger: a pinch, not a swipe.
        if (drag?.swiping) position(0, true);
        drag = null;
        return;
      }
      if (!(e.target instanceof Element) || !opts.current.enabled()) return;
      // Swiping again before the last photo has settled: show the viewer now and carry on.
      if (settling) reset();
      if (opts.current.accept && !opts.current.accept(e.target)) return;
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, swiping: false, samples: [{ t: e.timeStamp, x: e.clientX }] };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.swiping) {
        if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) {
          drag = null; // vertical: not ours
          return;
        }
        if (Math.abs(dx) < SLOP || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        drag.swiping = true;
        drag.x = e.clientX; // start from here, so the photo doesn't jump by the slop
        surface.setAttribute("data-swiping", "");
        for (const slide of slides()) layout(slide);
      }
      e.stopPropagation();
      let d = e.clientX - drag.x;
      const { prevId: p, nextId: n } = neighbours.current;
      // Nothing that way: the drag gives like a rubber band.
      if ((d > 0 && !p) || (d < 0 && !n)) d *= 0.3;
      drag.dx = d;
      drag.samples.push({ t: e.timeStamp, x: e.clientX });
      if (drag.samples.length > 6) drag.samples.shift();
      position(d, false);
    };
    const onUp = (e: PointerEvent) => {
      fingers.delete(e.pointerId);
      if (!drag || e.pointerId !== drag.pointerId) return;
      const d = drag;
      drag = null;
      // The release still reaches the viewer (its pinch tracking needs every lift).
      if (!d.swiping) return;
      const first = d.samples[0];
      const last = d.samples[d.samples.length - 1];
      const velocity = (last.x - first.x) / Math.max(1, last.t - first.t); // px per ms
      const w = width();
      const { prevId: p, nextId: n } = neighbours.current;
      const towards = d.dx < 0 ? n : p;
      const far = Math.abs(d.dx) > w / 3;
      const flick = Math.abs(velocity) > 0.45 && Math.abs(d.dx) > 30 && Math.sign(velocity) === Math.sign(d.dx);
      if (e.type !== "pointerup" || !towards || !(far || flick)) {
        position(0, !reducedMotion());
        window.setTimeout(reset, reducedMotion() ? 0 : GLIDE_MS + 20);
        return;
      }
      const slide = d.dx < 0 ? nextRef.current : prevRef.current;
      if (reducedMotion()) return settle(towards, slide);
      position(d.dx < 0 ? -(w + GAP) : w + GAP, true);
      window.setTimeout(() => settle(towards, slide), GLIDE_MS);
    };

    surface.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      reset();
      surface.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [props.surface]);

  return (
    <>
      <Slide ref={prevRef} id={prevId} side="previous" />
      <Slide ref={nextRef} id={nextId} side="next" />
    </>
  );
}

/** A neighbour's preview, kept loaded (hidden) so a swipe shows it at once. */
function Slide({ ref, id, side }: { ref: RefObject<HTMLDivElement | null>; id: string | null; side: "previous" | "next" }) {
  const asset = useStore(catalog, (s) => (id ? s.assets.get(id) : undefined));
  const url = useImageUrl(asset, "preview");
  return (
    <div ref={ref} className="gallery-slide" data-side={side} aria-hidden="true" style={{ visibility: "hidden" }}>
      {url && <img src={url} alt="" draggable={false} decoding="async" />}
    </div>
  );
}
