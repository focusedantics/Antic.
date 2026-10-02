import { viewDpr } from "@/lib/device";
import { useEffect, useRef } from "react";
import { useStore } from "@/app/hooks";
import { develop } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { clamp } from "@/lib/math";
import { MaskOverlay } from "./masks/MaskOverlay";
import { CropOverlay } from "./tools/Crop";
import { HealOverlay } from "./tools/Heal";

/** Zoom so that the point under the cursor stays put. */
export function zoomTo(zoom: number, clientX?: number, clientY?: number) {
  const engine = developEngine();
  const { view } = develop.getState();
  const size = engine.outputSize();
  if (!size) return;
  const fit = engine.fitScale(size);
  if (zoom <= fit * 1.001) {
    develop.setState({ view: { ...view, fit: true, zoom: fit } });
    return;
  }
  let center = view.fit ? { x: 0.5, y: 0.5 } : { x: view.centerX, y: view.centerY };
  if (clientX !== undefined && clientY !== undefined) {
    const [u, v] = engine.clientToOutput(clientX, clientY);
    const current = engine.displayScale(size);
    const k = current / zoom;
    center = { x: u + (center.x - u) * k, y: v + (center.y - v) * k };
  }
  develop.setState({ view: { fit: false, zoom, centerX: clamp(center.x), centerY: clamp(center.y) } });
}

export function DevelopView() {
  const ref = useRef<HTMLDivElement>(null);
  const tool = useStore(develop, (s) => s.tool);
  const compare = useStore(develop, (s) => s.compare);
  const split = useStore(develop, (s) => s.splitPosition);
  const status = useStore(develop, (s) => (s.error ? `error:${s.error}` : s.loading ? (s.source === "preview" ? "preview" : "loading") : ""));
  useEffect(() => {
    const engine = developEngine();
    engine.attach(ref.current!);
    return () => engine.detach();
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const engine = developEngine();
    let panning: { x: number; y: number; cx: number; cy: number } | null = null;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; x: number; y: number } | null = null;
    let space = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        space = e.type === "keydown";
        el.style.cursor = space ? "grab" : "";
        if (space) e.preventDefault();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (pinch) return;
      const { view, tool } = develop.getState();
      const toolWantsPointer = tool === "crop" || tool === "mask" || tool === "heal";
      if (e.button === 1 || space || (e.button === 0 && !view.fit && !toolWantsPointer)) {
        const size = engine.outputSize();
        if (!size || view.fit) return;
        panning = { x: e.clientX, y: e.clientY, cx: view.centerX, cy: view.centerY };
        el.setPointerCapture(e.pointerId);
        el.style.cursor = "grabbing";
        e.preventDefault();
        // Panning wins over tools (brush strokes, crop handles) underneath.
        e.stopPropagation();
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!panning || pinch) return;
      const size = engine.outputSize();
      if (!size) return;
      const s = engine.displayScale(size);
      const dpr = viewDpr();
      const { view } = develop.getState();
      develop.setState({
        view: {
          ...view,
          centerX: clamp(panning.cx - ((e.clientX - panning.x) * dpr) / (s * size.width)),
          centerY: clamp(panning.cy - ((e.clientY - panning.y) * dpr) / (s * size.height)),
        },
      });
    };
    const onUp = () => {
      panning = null;
      el.style.cursor = space ? "grab" : "";
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const size = engine.outputSize();
      if (!size) return;
      const current = engine.displayScale(size);
      zoomTo(clamp(current * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), engine.fitScale(size), 8), e.clientX, e.clientY);
    };
    const onDouble = (e: MouseEvent) => {
      if (develop.getState().tool !== "adjust") return;
      const { view } = develop.getState();
      if (view.fit) zoomTo(1, e.clientX, e.clientY);
      else develop.setState({ view: { ...view, fit: true } });
    };
    // Touch: two fingers pinch to zoom and pan together (over any tool); a double tap
    // toggles 100% like a double click. Mouse and pen input are unchanged.
    let lastTap = { t: 0, x: 0, y: 0 };
    let touchDoubled = 0;
    const midpoint = () => {
      const [a, b] = [...touches.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const onTouchDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        pinch = midpoint();
        panning = null;
        // The second finger turns the gesture into a pinch; tools underneath do not see it.
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const onTouchMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size < 2) return;
      e.stopPropagation();
      const size = engine.outputSize();
      if (!size) return;
      const now = midpoint();
      const current = engine.displayScale(size);
      zoomTo(clamp((current * now.dist) / Math.max(1, pinch.dist), engine.fitScale(size), 8), now.x, now.y);
      const { view } = develop.getState();
      if (!view.fit) {
        const s = engine.displayScale(size);
        const dpr = viewDpr();
        develop.setState({
          view: { ...view, centerX: clamp(view.centerX - ((now.x - pinch.x) * dpr) / (s * size.width)), centerY: clamp(view.centerY - ((now.y - pinch.y) * dpr) / (s * size.height)) },
        });
      }
      pinch = now;
    };
    const onTouchUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const wasPinch = !!pinch;
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (wasPinch || touches.size) return;
      const t = performance.now();
      if (t - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = { t: 0, x: 0, y: 0 };
        touchDoubled = t;
        onDouble(e);
      } else lastTap = { t, x: e.clientX, y: e.clientY };
    };
    const onDoubleClick = (e: MouseEvent) => {
      // A double tap already handled above; browsers may also send dblclick for it.
      if (performance.now() - touchDoubled < 600) return;
      onDouble(e);
    };
    el.addEventListener("pointerdown", onTouchDown, true);
    el.addEventListener("pointermove", onTouchMove, true);
    el.addEventListener("pointerup", onTouchUp, true);
    el.addEventListener("pointercancel", onTouchUp, true);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      el.removeEventListener("pointerdown", onTouchDown, true);
      el.removeEventListener("pointermove", onTouchMove, true);
      el.removeEventListener("pointerup", onTouchUp, true);
      el.removeEventListener("pointercancel", onTouchUp, true);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  return (
    <div className="develop-view" ref={ref}>
      {tool === "crop" && <CropOverlay />}
      {tool === "mask" && <MaskOverlay />}
      {tool === "heal" && <HealOverlay />}
      {compare === "split" && tool === "adjust" && <SplitHandle position={split} />}
      {status === "preview" && <div className="develop-status">Showing the camera preview while the original decodes…</div>}
      {status === "loading" && <div className="develop-status">Decoding original…</div>}
      {status.startsWith("error:") && <div className="develop-status error">{status.slice(6)}</div>}
      {compare !== "off" && (
        <div className="develop-status" style={{ bottom: "auto", top: 10 }}>
          {compare === "split" ? "Before | After" : "Before · After"}
        </div>
      )}
    </div>
  );
}

function SplitHandle({ position }: { position: number }) {
  const engine = developEngine();
  const region = engine.regions()[0];
  const dpr = viewDpr();
  const left = (region.x + region.width * position) / dpr;
  return (
    <div
      className="split-handle"
      style={{ left }}
      role="separator"
      aria-label="Before/after divider"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return;
        const rect = engine.canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * dpr;
        develop.setState({ splitPosition: clamp((x - region.x) / region.width, 0.02, 0.98) });
      }}
    />
  );
}
