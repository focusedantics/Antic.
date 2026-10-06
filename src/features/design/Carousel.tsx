import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Dialog, openMenu } from "@/components/Menu";
import { Icon } from "@/components/icons";
import { designAssets, loadDesignAssets } from "@/core/design/assets";
import { duplicateSlide, insertSlides, insertSlidesWith, makeCarousel, MAX_SLIDES, moveSlide, removeSlide, slideCount, slideWidth } from "@/core/document/carousel";
import { composite, editDocument } from "@/core/document/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { createId } from "@/lib/id";
import { viewDpr } from "@/lib/device";
import { setHeadingSlide } from "@/features/composite/slide";
import { TemplatePreview } from "./Gallery";
import { sizeLabel } from "./presets";
import { myTemplatePages, myTemplatesForSlides, type SlidePages, templatePages, templatesForSlides } from "./slide-templates";

/** Which slide the view shows (its centre), or null when the whole carousel is in view. */
export function currentSlide(): number | null {
  const { doc, view } = composite.getState();
  if (!doc?.carousel || view.fit) return null;
  return Math.max(0, Math.min(slideCount(doc) - 1, Math.floor((view.centerX * doc.width) / slideWidth(doc))));
}

let glide = 0;
/** Moves the view to show slide `index` whole, gliding there (instantly with reduced motion). */
export function focusSlide(index: number, animate = true) {
  const { doc, view } = composite.getState();
  if (!doc) return;
  const n = slideCount(doc);
  const i = Math.max(0, Math.min(n - 1, index));
  const sw = slideWidth(doc);
  const zoom = developEngine().compositeFitFor(sw, doc.height);
  const target = { fit: false, zoom, centerX: ((i + 0.5) * sw) / doc.width, centerY: 0.5 };
  cancelAnimationFrame(glide);
  setHeadingSlide(null);
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const from = view.fit ? { ...target, zoom: developEngine().compositeFitScale(), centerX: 0.5 } : { ...view, centerY: 0.5 };
  if (!animate || reduced || (view.fit && Math.abs(from.zoom - zoom) < 1e-6)) {
    composite.setState({ view: target });
    return;
  }
  const start = performance.now();
  const ms = 260;
  // Things added or pasted during the glide go on the slide it is heading for.
  setHeadingSlide(i);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const e = 1 - (1 - t) ** 3;
    composite.setState({ view: { fit: false, zoom: from.zoom + (target.zoom - from.zoom) * e, centerX: from.centerX + (target.centerX - from.centerX) * e, centerY: 0.5 } });
    if (t < 1) glide = requestAnimationFrame(step);
    else setHeadingSlide(null);
  };
  glide = requestAnimationFrame(step);
}

/** The whole carousel in view. */
export const showAllSlides = () => {
  cancelAnimationFrame(glide);
  setHeadingSlide(null);
  composite.setState((s) => ({ view: { ...s.view, fit: true } }));
};

/**
 * A horizontal swipe on the canvas (started where no layer can be moved): the view follows
 * the finger across the seamless canvas and settles on the nearest slide, or the next one
 * when flicked. Returns false when the view is not on one slide (nothing to swipe).
 */
export function startSwipe(e: { clientX: number; pointerId: number }, el: HTMLElement): boolean {
  const { doc, view } = composite.getState();
  if (!doc?.carousel || view.fit) return false;
  const engine = developEngine();
  const pxPerDoc = engine.compositeScale() / viewDpr();
  const startX = e.clientX;
  const startCenter = view.centerX;
  const startSlide = currentSlide() ?? 0;
  let lastX = startX;
  let lastT = performance.now();
  let velocity = 0;
  cancelAnimationFrame(glide);
  setHeadingSlide(null);
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    const now = performance.now();
    velocity = (ev.clientX - lastX) / Math.max(1, now - lastT);
    lastX = ev.clientX;
    lastT = now;
    const centerX = startCenter - (ev.clientX - startX) / pxPerDoc / doc.width;
    composite.setState((s) => ({ view: { ...s.view, fit: false, centerX: Math.max(0, Math.min(1, centerX)) } }));
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    const moved = ev.clientX - startX;
    const sw = slideWidth(doc) * pxPerDoc;
    // A flick or a drag past a quarter of the slide turns the page.
    const turn = Math.abs(velocity) > 0.4 || Math.abs(moved) > sw / 4 ? -Math.sign(moved || -velocity) : 0;
    focusSlide(startSlide + turn);
  };
  el.setPointerCapture?.(e.pointerId);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  return true;
}

// ─── Slide operations (each one undoable step) ────────────────────────────────

export function addSlide(after?: number) {
  const doc = composite.getState().doc;
  if (!doc) return;
  const n = slideCount(doc);
  if (n >= MAX_SLIDES) return toast(`A carousel has at most ${MAX_SLIDES} slides.`, "error");
  const at = after === undefined ? n : after + 1;
  editDocument(n === 1 ? "Make a carousel" : "Add slide", (d) => (d.carousel ? insertSlides(d, at) : makeCarousel(d, 2)));
  requestAnimationFrame(() => focusSlide(Math.min(at, slideCount(composite.getState().doc!) - 1)));
}

/** Adds a template's pages as new slides after slide `after` (at the end when undefined), then shows the first. */
async function addTemplateSlides(make: () => Promise<SlidePages | null>, after?: number) {
  const pages = await make();
  const doc = composite.getState().doc;
  if (!doc) return;
  if (!pages) return toast("This template could not be read.", "error");
  const n = slideCount(doc);
  if (n + pages.count > MAX_SLIDES) return toast(`A carousel has at most ${MAX_SLIDES} slides.`, "error");
  const at = after === undefined ? n : Math.min(n, after + 1);
  editDocument(pages.count > 1 ? `Add ${pages.count} slides from “${pages.name}”` : `Add a slide from “${pages.name}”`, (d) => insertSlidesWith(d, at, pages.count, pages.layers));
  requestAnimationFrame(() => focusSlide(at));
}

/** "4:5" for 1080 × 1350. */
function ratioLabel(width: number, height: number) {
  const w = Math.round(width);
  const h = Math.round(height);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  return w / g <= 32 && h / g <= 32 ? `${w / g}:${h / g}` : sizeLabel(w, h);
}

/**
 * Templates whose slides have this design's slide shape, to add as new slides (a carousel
 * template adds all of its slides). The slide bar's + still adds a blank slide.
 */
function SlideTemplates({ after, onClose }: { after?: number; onClose: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const items = useStore(designAssets, (s) => s.items);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void loadDesignAssets();
  }, []);
  if (!doc) return null;
  const built = templatesForSlides(doc);
  const mine = myTemplatesForSlides(doc, items);
  const sw = slideWidth(doc);
  const pick = async (id: string, make: () => Promise<SlidePages | null>) => {
    setBusy(id);
    try {
      await addTemplateSlides(make, after);
      onClose();
    } finally {
      setBusy(null);
    }
  };
  const where = after === undefined ? "at the end" : `after slide ${after + 1}`;
  return (
    <Dialog wide title="Add slides from a template" onClose={onClose}>
      <p className="dim" style={{ marginTop: 0 }}>
        Templates with {ratioLabel(sw, doc.height)} slides like this design’s ({sizeLabel(Math.round(sw), doc.height)}), added {where} at its size. The + button still adds a blank slide.
      </p>
      {mine.length > 0 && (
        <>
          <div className="subhead">My templates</div>
          <div className="template-grid slide-template-grid">
            {mine.map((a) => (
              <MyTemplateSlideCard key={a.id} name={a.name} thumb={a.thumb} busy={busy === a.id} disabled={!!busy} onPick={() => pick(a.id, () => myTemplatePages(doc, a))} />
            ))}
          </div>
          <div className="subhead">Templates</div>
        </>
      )}
      <div className="template-grid slide-template-grid">
        {built.map((t) => (
          <button key={t.id} type="button" className="template-card" aria-busy={busy === t.id} disabled={!!busy} onClick={() => pick(t.id, () => templatePages(doc, t))}>
            <span className="template-thumb" style={{ aspectRatio: `${t.width} / ${t.height}` }}>
              <TemplatePreview t={t} />
            </span>
            <span className="template-name">
              {t.name}
              {(t.slides ?? 1) > 1 && <span className="faint"> · {t.slides} slides</span>}
            </span>
          </button>
        ))}
      </div>
      {!built.length && !mine.length && <p className="faint">No template has {ratioLabel(sw, doc.height)} slides yet. Save one of your designs of this shape as a template to use it here.</p>}
    </Dialog>
  );
}

function MyTemplateSlideCard({ name, thumb, busy, disabled, onPick }: { name: string; thumb?: Blob; busy: boolean; disabled: boolean; onPick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!thumb) return;
    const u = URL.createObjectURL(thumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [thumb]);
  return (
    <button type="button" className="template-card mine" aria-busy={busy} disabled={disabled} onClick={onPick}>
      <span className="template-thumb">{url ? <img src={url} alt="" /> : <Icon name="design" size={28} />}</span>
      <span className="template-name">{name}</span>
    </button>
  );
}

export function slideMenu(x: number, y: number, index: number) {
  const doc = composite.getState().doc;
  if (!doc) return;
  const n = slideCount(doc);
  openMenu(x, y, [
    { label: "Add a slide before", disabled: n >= MAX_SLIDES, onSelect: () => editDocument("Add slide", (d) => insertSlides(d, index)) },
    { label: "Add a slide after", disabled: n >= MAX_SLIDES, onSelect: () => addSlide(index) },
    { label: "Duplicate slide", disabled: n >= MAX_SLIDES, onSelect: () => editDocument("Duplicate slide", (d) => duplicateSlide(d, index, () => createId("layer"))) },
    "separator",
    { label: "Move left", disabled: index === 0, onSelect: () => (editDocument("Move slide", (d) => moveSlide(d, index, index - 1)), focusSlide(index - 1)) },
    { label: "Move right", disabled: index >= n - 1, onSelect: () => (editDocument("Move slide", (d) => moveSlide(d, index, index + 1)), focusSlide(index + 1)) },
    "separator",
    {
      label: "Delete slide…",
      disabled: n < 2,
      onSelect: () => {
        if (!confirm(`Delete slide ${index + 1} and the layers on it?`)) return;
        editDocument("Delete slide", (d) => removeSlide(d, index));
        requestAnimationFrame(() => focusSlide(Math.min(index, slideCount(composite.getState().doc!) - 1), false));
      },
    },
  ]);
}

/**
 * The slides under the canvas: tap one to go to it (the view glides), All shows the whole
 * strip, + adds a slide, ⋯ on a slide inserts, duplicates, moves or deletes it; Preview
 * swipes through the carousel as it will be posted.
 */
export function SlidesBar({ onPreview }: { onPreview: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  useStore(composite, (s) => s.view);
  const [picking, setPicking] = useState<{ after?: number } | null>(null);
  const current = currentSlide();
  const strip = useRef<HTMLDivElement>(null);
  const n = doc ? slideCount(doc) : 0;
  // More slides than fit: the strip scrolls; its edges fade where there are more to see.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const edges = () => {
      el.dataset.moreBefore = String(el.scrollLeft > 1);
      el.dataset.moreAfter = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    edges();
    el.addEventListener("scroll", edges, { passive: true });
    const sizes = new ResizeObserver(edges);
    sizes.observe(el);
    return () => {
      el.removeEventListener("scroll", edges);
      sizes.disconnect();
    };
  }, [n, !!doc]);
  // The slide being worked on (with its ⋯) is always in view in the strip.
  useEffect(() => {
    const el = strip.current;
    const chip = current === null ? null : el?.querySelectorAll<HTMLElement>(".slide-item")[current];
    if (!el || !chip) return;
    const pad = 24;
    const box = el.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    if (r.left - pad < box.left) el.scrollLeft -= box.left - (r.left - pad);
    else if (r.right + pad > box.right) el.scrollLeft += r.right + pad - box.right;
  }, [current, n]);
  if (!doc) return null;
  return (
    <div className="slides-bar" role="toolbar" aria-label="Slides">
      <button type="button" className="btn small ghost slide-step" aria-label="Previous slide" disabled={current === null ? false : current === 0} onClick={() => focusSlide(current === null ? 0 : current - 1)}>
        ‹
      </button>
      <div ref={strip} className="slides" role="group" aria-label={`${n} slides`}>
        {doc.carousel && (
          <button type="button" className="slide-chip all" aria-pressed={current === null} onClick={showAllSlides}>
            All
          </button>
        )}
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className="slide-item">
            <button type="button" className="slide-chip" aria-pressed={current === i} aria-label={`Slide ${i + 1}`} onClick={() => focusSlide(i)} onContextMenu={(e) => (e.preventDefault(), slideMenu(e.clientX, e.clientY, i))}>
              {i + 1}
            </button>
            {doc.carousel && current === i && (
              <button type="button" className="slide-more" aria-label={`Slide ${i + 1} options`} onClick={(e) => slideMenu(e.clientX, e.clientY, i)}>
                ⋯
              </button>
            )}
          </span>
        ))}
      </div>
      {/* Outside the scrolling slide list, so both stay in reach on a phone. */}
      <div className="slide-adds">
        <button type="button" className="slide-chip add" title={doc.carousel ? "Add a blank slide" : "Make this a carousel: add a blank second slide"} aria-label="Add slide" onClick={() => addSlide(current ?? undefined)}>
          +
        </button>
        <button
          type="button"
          className="slide-chip add from-template"
          title="Add slides from a template with this slide shape"
          aria-label="Add slides from a template"
          disabled={slideCount(doc) >= MAX_SLIDES}
          onClick={() => setPicking({ after: current ?? undefined })}
        >
          <Icon name="presets" size={14} />
          <span className="slide-add-label">Template</span>
        </button>
      </div>
      {picking && <SlideTemplates after={picking.after} onClose={() => setPicking(null)} />}
      <button type="button" className="btn small ghost slide-step" aria-label="Next slide" disabled={current !== null && current >= n - 1} onClick={() => focusSlide(current === null ? 0 : current + 1)}>
        ›
      </button>
      {doc.carousel && (
        <button type="button" className="btn small slide-preview" aria-label="Preview" onClick={onPreview} title="Swipe through the carousel as it will be posted">
          <Icon name="play" size={12} /> <span className="slide-add-label">Preview</span>
        </button>
      )}
    </div>
  );
}

/**
 * The carousel as it will be posted: one render of the whole canvas behind a phone-width
 * window that swipes slide by slide (native scroll snapping and momentum), so a picture
 * running across slides is seen continuing from one to the next.
 */
export function CarouselPreview({ onClose }: { onClose: () => void }) {
  const doc = composite.getState().doc;
  const [url, setUrl] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const n = doc ? slideCount(doc) : 1;
  useEffect(() => {
    if (!doc) return;
    let live = true;
    let made: string | null = null;
    // A frame for "working" to show, then one render at preview size.
    requestAnimationFrame(() =>
      setTimeout(async () => {
        const scale = Math.min(1, (1350 * Math.min(2, window.devicePixelRatio || 1)) / doc.height, 8192 / doc.width);
        const image = developEngine().renderDocument(doc, scale);
        const canvas = new OffscreenCanvas(image.width, image.height);
        canvas.getContext("2d")!.putImageData(image, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      }, 0),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [doc]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(page + 1);
      else if (e.key === "ArrowLeft") go(page - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  // Mouse drag swipes too (touch and trackpads scroll natively).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let start: { x: number; left: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      start = { x: e.clientX, left: el.scrollLeft };
      el.style.scrollSnapType = "none";
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => start && (el.scrollLeft = start.left - (e.clientX - start.x));
    const up = () => {
      if (!start) return;
      const moved = el.scrollLeft - start.left;
      const from = Math.round(start.left / el.clientWidth);
      start = null;
      el.style.scrollSnapType = "";
      const turn = Math.abs(moved) > el.clientWidth / 5 ? Math.sign(moved) : 0;
      el.scrollTo({ left: (from + turn) * el.clientWidth, behavior: "smooth" });
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [url]);
  const go = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, Math.min(n - 1, i)) * el.clientWidth, behavior: "smooth" });
  };
  if (!doc) return null;
  const aspect = slideWidth(doc) / doc.height;
  return createPortal(
    <div className="carousel-preview" role="dialog" aria-modal="true" aria-label="Carousel preview" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="carousel-phone" style={{ ["--slide-aspect" as string]: String(aspect) }}>
        <div
          ref={scroller}
          className="carousel-scroller"
          onScroll={(e) => {
            const el = e.currentTarget;
            setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
          }}
        >
          <div className="carousel-track" style={{ width: `${n * 100}%` }}>
            {url && <img src={url} alt={`${doc.name}, ${n} slides`} draggable={false} />}
            {Array.from({ length: n }, (_, i) => (
              <span key={i} className="carousel-page" style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }} />
            ))}
          </div>
        </div>
        {!url && <div className="carousel-loading">Rendering the carousel…</div>}
        <div className="carousel-count" aria-live="polite">
          {page + 1}/{n}
        </div>
      </div>
      {/* Under the photo, as on Instagram: dots over a light slide would vanish. */}
      <div className="carousel-dots" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <i key={i} data-on={i === page || undefined} />
        ))}
      </div>
      <div className="carousel-actions">
        <button type="button" className="btn" aria-label="Previous slide" disabled={page === 0} onClick={() => go(page - 1)}>
          ‹
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
        <button type="button" className="btn" aria-label="Next slide" disabled={page >= n - 1} onClick={() => go(page + 1)}>
          ›
        </button>
      </div>
    </div>,
    document.body,
  );
}
