import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { effectById } from "@/core/effects/registry";
import type { Segment } from "@/core/video/model";
import { beginVideoGesture, editVideo, endVideoGesture, video } from "@/core/video/session";
import { formatClock } from "./format";
import { editor, moveSelection, select } from "./actions";
import { engine, player } from "./engine";

const RULER = 22;
const TRACK = 64;
const WAVE = 44;
const THUMB_W = 72;
/** Zooms the mounted timeline (keyboard shortcuts). */
let timelineZoom: ((factor: number | "fit") => void) | null = null;
export const zoomTimeline = (factor: number | "fit") => timelineZoom?.(factor);

const CLIP_COLORS = ["#5b7cfa", "#e0794a", "#3fae7c", "#c25bd6", "#d6b43f", "#4fb3c9"];

/** Short labels for a segment's treatments. */
function badges(s: Segment): string[] {
  const b: string[] = [];
  if (s.reverse) b.push("REV");
  if (s.speed !== 1) b.push(`${+s.speed.toFixed(2)}×`);
  if (s.pitch) b.push(`${s.pitch > 0 ? "+" : ""}${s.pitch}st`);
  if (s.stutter > 1) b.push(`STUT×${s.stutter}`);
  if (s.pingPong) b.push(`DANCE×${s.pingPong}`);
  if (s.hold) b.push(`STARE ${+s.hold.toFixed(1)}s`);
  if (s.mute) b.push("MUTE");
  const a = s.audio;
  if (a.earrape) b.push("EAR");
  if (a.sus) b.push("SUS");
  if (a.echo) b.push("ECHO");
  if (a.reverb) b.push("VERB");
  if (a.chorus) b.push("CHORUS");
  if (a.vibrato) b.push("VIB");
  if (a.bitcrush) b.push("CRUSH");
  const v = s.visual;
  if (v.mirror) b.push("MIRROR");
  if (v.flip) b.push("FLIP");
  if (v.invert) b.push("INV");
  if (v.rainbow) b.push("RAINBOW");
  if (v.zoom > 1) b.push(`ZOOM ${+v.zoom.toFixed(1)}×`);
  if (v.contrast) b.push("FRIED");
  if (s.effect) b.push(effectById(s.effect.id)?.name ?? "FX");
  return b;
}

export function Timeline() {
  const edit = useStore(video, (s) => s.edit);
  const clips = useStore(video, (s) => s.clips);
  const frames = useStore(player, (s) => s.frames);
  const fps = useStore(player, (s) => s.fps);
  const soundtrackVersion = useStore(player, (s) => s.soundtrackVersion);
  const selection = useStore(editor, (s) => s.selection);
  const zoom = useStore(editor, (s) => s.zoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const [viewWidth, setViewWidth] = useState(800);
  const [scroll, setScroll] = useState(0);
  const [drop, setDrop] = useState<number | null>(null);
  const [, redraw] = useState(0);
  const zoomRef = useRef<((factor: number | "fit", anchorX?: number) => void) | null>(null);
  const duration = frames / fps;
  // Pixels per second: "fit" fills the view.
  const fit = Math.max(4, (viewWidth - 24) / Math.max(0.5, duration));
  // Most zoomed in: about 24 px per frame, and always at least 4× past "fit".
  const maxPps = Math.max(fit * 4, 24 * fps);
  const pps = Math.min(zoom ?? fit, maxPps);
  const width = Math.max(viewWidth, duration * pps + 24);
  const plan = engine.plan;
  const selected = new Set(selection);
  const colorOf = (clip: string | null) => (clip === null ? CLIP_COLORS[0] : CLIP_COLORS[(clips.findIndex((c) => c.id === clip) % (CLIP_COLORS.length - 1)) + 1]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Thumbnails and waveform are drawn for the visible part only.
  const paint = useCallback(() => {
    const dpr = window.devicePixelRatio || 1;
    const thumbs = thumbsRef.current;
    const wave = waveRef.current;
    if (!thumbs || !wave || !plan) return;
    for (const c of [thumbs, wave]) {
      c.width = Math.round(viewWidth * dpr);
      c.height = Math.round((c === thumbs ? TRACK : WAVE) * dpr);
    }
    const tctx = thumbs.getContext("2d")!;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, viewWidth, TRACK);
    const first = Math.floor(scroll / THUMB_W);
    for (let i = first; i * THUMB_W < scroll + viewWidth; i++) {
      const x = i * THUMB_W;
      const k = Math.floor(((x + THUMB_W / 2) / pps) * fps);
      if (k >= frames) break;
      const bitmap = engine.thumbnail(k, () => redraw((n) => n + 1));
      if (!bitmap) continue;
      const h = TRACK - 18;
      const w = Math.min(THUMB_W, (bitmap.width / bitmap.height) * h);
      tctx.drawImage(bitmap, x - scroll + (THUMB_W - w) / 2, 16, w, h);
    }
    const wctx = wave.getContext("2d")!;
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, viewWidth, WAVE);
    const peaks = engine.peaks;
    if (peaks) {
      wctx.fillStyle = "#7fd1a5";
      const mid = WAVE / 2;
      for (let x = 0; x < viewWidth; x++) {
        const t0 = (x + scroll) / pps;
        const t1 = (x + 1 + scroll) / pps;
        const b0 = Math.floor(t0 * peaks.rate);
        const b1 = Math.max(b0 + 1, Math.floor(t1 * peaks.rate));
        if (b0 >= peaks.min.length) break;
        let lo = 0;
        let hi = 0;
        for (let b = b0; b < Math.min(b1, peaks.min.length); b++) {
          lo = Math.min(lo, peaks.min[b]);
          hi = Math.max(hi, peaks.max[b]);
        }
        wctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
      }
    }
  }, [plan, viewWidth, scroll, pps, fps, frames]);

  useEffect(() => {
    paint();
  });
  useEffect(() => paint(), [soundtrackVersion, paint]);

  // Keep the playhead in view while playing.
  useEffect(
    () =>
      player.subscribe((s, prev) => {
        if (s.frame === prev.frame || !s.playing) return;
        const el = scrollRef.current;
        if (!el) return;
        const x = (s.frame / s.fps) * pps;
        if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 40);
      }),
    [pps],
  );

  const frameAtX = (clientX: number) => {
    const el = scrollRef.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.floor((x / pps) * fps);
  };

  /** Drag on the ruler or the waveform: scrub with sound. */
  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    engine.pause();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    engine.scrub(frameAtX(e.clientX));
    const move = (ev: PointerEvent) => engine.scrub(frameAtX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Pointer down on a segment: select (and seek), or drag to reorder. */
  const grabSegment = (e: ReactPointerEvent, s: Segment) => {
    if (e.button !== 0 || !edit) return;
    e.stopPropagation();
    const startX = e.clientX;
    const already = selected.has(s.id);
    const ids = e.shiftKey || e.metaKey || e.ctrlKey ? (already ? selection.filter((id) => id !== s.id) : [...selection, s.id]) : already ? selection : [s.id];
    select(ids);
    let dragging = false;
    const indexAt = (clientX: number) => {
      if (!plan) return 0;
      const t = frameAtX(clientX) / fps;
      let i = 0;
      while (i < plan.spans.length && t > (plan.spans[i].start + plan.spans[i].end) / 2) i++;
      return i;
    };
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) > 5) dragging = true;
      if (dragging) setDrop(indexAt(ev.clientX));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrop(null);
      if (dragging) {
        const moving = new Set(ids.length ? ids : [s.id]);
        const at = indexAt(ev.clientX);
        // Index among the segments that stay.
        const before = edit.segments.slice(0, at).filter((x) => !moving.has(x.id)).length;
        moveSelection(moving, before);
      } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
        // A plain click (no drag) selects just this segment, even inside a group selection.
        select([s.id]);
        engine.pause();
        engine.seek(frameAtX(ev.clientX));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Drag a segment's edge to trim its source range (the rest of the timeline follows). */
  const trim = (e: ReactPointerEvent, s: Segment, side: "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const info = engine.infoOf(s.clip ?? video.getState().openId ?? "");
    if (!info) return;
    const startX = e.clientX;
    const original = s;
    const oneFrame = 1 / info.fps;
    beginVideoGesture("Trim");
    // On screen the left edge is the start of playback: the source "in" point, or "out" when reversed.
    const editsIn = (side === "start") !== s.reverse;
    const move = (ev: PointerEvent) => {
      // Source seconds the dragged edge moved; dragging the left edge right shortens the start, the right edge right lengthens the end.
      const delta = ((ev.clientX - startX) / pps) * original.speed;
      const snap = (t: number) => Math.round(t * info.fps) / info.fps;
      editVideo("Trim", (ed) => ({
        ...ed,
        segments: ed.segments.map((x) => {
          if (x.id !== s.id) return x;
          if (editsIn) return { ...x, in: Math.min(original.out - oneFrame, Math.max(0, snap(original.in + (side === "start" ? delta : -delta)))) };
          return { ...x, out: Math.max(original.in + oneFrame, Math.min(info.duration, snap(original.out + (side === "end" ? delta : -delta)))) };
        }),
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      endVideoGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /**
   * Zooms by `factor` ("fit" shows the whole timeline), keeping the time at
   * `anchorX` (px from the view's left edge; default: the playhead, or the
   * middle when the playhead is off screen) where it is.
   */
  const zoomBy = (factor: number | "fit", anchorX?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    if (factor === "fit") {
      editor.setState({ zoom: null });
      requestAnimationFrame(() => (el.scrollLeft = 0));
      return;
    }
    const head = (player.getState().frame / fps) * pps - el.scrollLeft;
    const x = anchorX ?? (head >= 0 && head <= el.clientWidth ? head : el.clientWidth / 2);
    const anchor = (x + el.scrollLeft) / pps;
    const next = Math.max(fit, Math.min(maxPps, pps * factor));
    editor.setState({ zoom: next <= fit * 1.001 ? null : next });
    requestAnimationFrame(() => (el.scrollLeft = Math.max(0, anchor * next - x)));
  };
  zoomRef.current = zoomBy;

  // Ctrl/⌘ + wheel (or trackpad pinch) zooms. A native, non-passive listener so the page itself doesn't zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomRef.current?.(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => {
    timelineZoom = (f) => zoomRef.current?.(f);
    return () => {
      timelineZoom = null;
    };
  }, []);

  // Ruler ticks: a readable step for the zoom.
  const steps = [1 / fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const tick = steps.find((s) => s * pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.floor(scroll / pps / tick) * tick; t <= (scroll + viewWidth) / pps && t <= duration + tick; t += tick) ticks.push(t);

  return (
    <div className="vt">
      <div className="vt-bar">
        <span className="faint" style={{ fontSize: 11 }}>
          Timeline
        </span>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Timeline zoom">
          <button type="button" title="Zoom out (−)" aria-label="Zoom out" disabled={zoom === null} onClick={() => zoomBy(1 / 1.5)}>
            −
          </button>
          <button type="button" title="Fit the whole timeline (0)" aria-pressed={zoom === null} onClick={() => zoomBy("fit")}>
            Fit
          </button>
          <button type="button" title="Zoom in (+ or Ctrl+scroll)" aria-label="Zoom in" disabled={pps >= maxPps * 0.999} onClick={() => zoomBy(1.5)}>
            +
          </button>
        </div>
        <span className="faint num vt-zoom" data-testid="timeline-zoom">
          {zoom === null ? "Fit" : `${Math.round((pps / fit) * 100)}%`}
        </span>
      </div>
      <div className="vt-scroll" ref={scrollRef} onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}>
        <div className="vt-content" style={{ width }}>
          <div className="vt-ruler" style={{ height: RULER }} onPointerDown={scrub} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.max(0, frames - 1)} aria-valuenow={player.getState().frame} tabIndex={0}>
            {ticks.map((t) => (
              <span key={t} className="vt-tick" style={{ left: t * pps }}>
                {formatClock(t, tick < 1)}
              </span>
            ))}
          </div>
          <div className="vt-track" style={{ height: TRACK }}>
            <canvas ref={thumbsRef} className="vt-canvas" style={{ left: scroll, width: viewWidth, height: TRACK }} />
            {edit &&
              plan &&
              edit.segments.map((s, i) => {
                const span = plan.spans[i];
                if (!span) return null;
                const left = span.start * pps;
                const w = Math.max(3, (span.end - span.start) * pps);
                return (
                  <div
                    key={s.id}
                    className="vt-seg"
                    aria-selected={selected.has(s.id)}
                    style={{ left, width: w, borderColor: colorOf(s.clip) }}
                    onPointerDown={(e) => grabSegment(e, s)}
                    title={`${i + 1}: ${formatClock(s.in, true)}–${formatClock(s.out, true)} of ${s.clip ? (clips.find((c) => c.id === s.clip)?.name ?? "another clip") : "this clip"}`}
                    data-testid="segment"
                  >
                    <span className="vt-seg-label" style={{ background: colorOf(s.clip) }}>
                      {i + 1}
                    </span>
                    {w > 40 && <span className="vt-badges">{badges(s).join(" · ")}</span>}
                    <span className="vt-handle start" onPointerDown={(e) => trim(e, s, "start")} aria-label="Trim start" />
                    <span className="vt-handle end" onPointerDown={(e) => trim(e, s, "end")} aria-label="Trim end" />
                  </div>
                );
              })}
            {drop !== null && plan && <div className="vt-drop" style={{ left: (plan.spans[drop]?.start ?? plan.duration) * pps }} />}
          </div>
          <div className="vt-wave" style={{ height: WAVE }} onPointerDown={scrub}>
            <canvas ref={waveRef} className="vt-canvas" style={{ left: scroll, width: viewWidth, height: WAVE }} />
          </div>
          <Playhead pps={pps} />
        </div>
      </div>
    </div>
  );
}

function Playhead({ pps }: { pps: number }) {
  const frame = useStore(player, (s) => s.frame);
  const fps = useStore(player, (s) => s.fps);
  return <div className="vt-playhead" style={{ left: (frame / fps) * pps }} />;
}
