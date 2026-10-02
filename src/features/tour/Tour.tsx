import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { CHAPTERS, chapterStart, parseBody, STEPS, type TourTarget } from "./steps";
import { endTour, goToStep, nextStep, previousStep, skipChapter, tour } from "./tour";
import "@/styles/tour.css";

type Rect = { x: number; y: number; w: number; h: number };

const PAD = 6;
const GAP = 14;
const MARGIN = 12;

/** The first candidate element that is actually on screen. */
function locate(targets: readonly TourTarget[] | undefined): Rect | null {
  for (const t of targets ?? []) {
    for (const el of document.querySelectorAll<HTMLElement>(t.selector)) {
      if (t.text && el.textContent?.trim() !== t.text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
  }
  return null;
}

const same = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** Where the card goes: beside a small target, inside a big one, centred without one. */
function place(target: Rect | null, card: { w: number; h: number }): { left: number; top: number } {
  const W = innerWidth;
  const H = innerHeight;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  if (!target) return { left: (W - card.w) / 2, top: (H - card.h) / 2 };
  if (target.w * target.h > W * H * 0.3) {
    // A whole viewer or panel: sit inside it, bottom-left, like a caption.
    return { left: clamp(target.x + 24, MARGIN, W - card.w - MARGIN), top: clamp(target.y + target.h - card.h - 24, MARGIN, H - card.h - MARGIN) };
  }
  const below = target.y + target.h + PAD + GAP;
  const above = target.y - PAD - GAP - card.h;
  const right = target.x + target.w + PAD + GAP;
  const left = target.x - PAD - GAP - card.w;
  const alignX = clamp(target.x + target.w / 2 - card.w / 2, MARGIN, W - card.w - MARGIN);
  const alignY = clamp(target.y + target.h / 2 - card.h / 2, MARGIN, H - card.h - MARGIN);
  if (below + card.h <= H - MARGIN) return { left: alignX, top: below };
  if (above >= MARGIN) return { left: alignX, top: above };
  if (right + card.w <= W - MARGIN) return { left: right, top: alignY };
  if (left >= MARGIN) return { left, top: alignY };
  return { left: (W - card.w) / 2, top: (H - card.h) / 2 };
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * The guided tour: a spotlight on the part of the app being explained and a
 * card that says what it does. It never blocks the app; you can try each
 * thing while the card is up.
 */
export default function Tour() {
  const index = useStore(tour, (s) => s.index);
  const step = STEPS[index];
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const rectRef = useRef<Rect | null>(null);

  // Follow the target: workspaces load lazily and panels move, so measure every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const r = locate(step.targets);
      if (!same(r, rectRef.current)) {
        rectRef.current = r;
        setRect(r);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    setPos(place(rect, { w: el.offsetWidth, h: el.offsetHeight }));
  }, [rect, index]);

  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [index]);

  // Arrow keys and Esc drive the tour; every other key still reaches the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector(".dialog-backdrop, .menu")) return;
      const onButton = e.target instanceof HTMLButtonElement;
      if (e.key === "Escape") endTour();
      else if (e.key === "ArrowRight" || (e.key === "Enter" && !onButton)) nextStep();
      else if (e.key === "ArrowLeft") previousStep();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const first = index === 0;
  const last = index === STEPS.length - 1;
  const chapterSteps = STEPS.filter((s) => s.chapter === step.chapter);
  const inChapter = chapterSteps.indexOf(step) + 1;
  const spot = rect ? { left: rect.x - PAD, top: rect.y - PAD, width: rect.w + PAD * 2, height: rect.h + PAD * 2 } : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };

  return (
    <div className="tour" data-testid="tour">
      <div className={`tour-spot${rect ? " on" : ""}`} style={spot} aria-hidden="true" />
      <div
        ref={card}
        key={index}
        className="tour-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      >
        <div className="tour-head">
          <span className="tour-chapter">{step.chapter ? `Chapter ${step.chapter} · ${CHAPTERS[step.chapter]}` : "Quick tour"}</span>
          {step.chapter > 0 && chapterSteps.length > 1 && (
            <span className="tour-count num">
              {inChapter}/{chapterSteps.length}
            </span>
          )}
          <button type="button" className="tour-close" aria-label="Close tour" title="Close tour (Esc)" onClick={endTour}>
            ✕
          </button>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">
          {parseBody(step.body).map((part, i) => (part.key ? <kbd key={i}>{part.text}</kbd> : <span key={i}>{part.text}</span>))}
        </p>
        {!first && (
          <nav className="tour-chapters" aria-label="Tour chapters">
            {CHAPTERS.slice(1).map((name, i) => (
              <button
                key={name}
                type="button"
                aria-label={`Chapter ${i + 1}: ${name}`}
                title={name}
                aria-current={step.chapter === i + 1 ? "step" : undefined}
                data-done={step.chapter > i + 1 || undefined}
                onClick={() => goToStep(chapterStart(i + 1))}
              />
            ))}
          </nav>
        )}
        <div className="tour-actions">
          {first ? (
            <>
              <button type="button" className="btn small ghost" onClick={endTour}>
                Skip
              </button>
              <span className="tour-hint">Esc closes · ← → move</span>
              <button ref={primary} type="button" className="btn small primary" onClick={nextStep}>
                Start tour
              </button>
            </>
          ) : (
            <>
              {!last && step.chapter < CHAPTERS.length - 1 && (
                <button type="button" className="btn small ghost" onClick={skipChapter} title="Jump to the next chapter">
                  Skip chapter
                </button>
              )}
              {!last && (
                <button type="button" className="btn small ghost" onClick={endTour}>
                  Skip tour
                </button>
              )}
              <span className="tour-spacer" />
              <button type="button" className="btn small" onClick={previousStep}>
                Back
              </button>
              <button ref={primary} type="button" className="btn small primary" onClick={nextStep}>
                {last ? "Done" : "Next"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
