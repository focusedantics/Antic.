import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { Icon } from "@/components/icons";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { identityCurve } from "@/core/develop/defaults";
import { parametricRanges } from "@/core/develop/params";
import type { Curve, ParametricCurve, ToneCurve } from "@/core/develop/recipe";
import { beginGesture, editRecipe, endGesture } from "@/core/develop/session";
import { parametric } from "@/core/gpu/curves";
import { clamp, interpolatePchip } from "@/lib/math";
import { useRecipe } from "../edit";

type Channel = "master" | "red" | "green" | "blue";
const channelColor: Record<Channel, string> = { master: "#dcdcdc", red: "#e0524a", green: "#5bbf4b", blue: "#4f7fe8" };
const GAP = 1 / 256;
/** The channel being edited, shared by the curve and the panel header's Reset. */
const curveChannel = createStore<{ channel: Channel; parametric: boolean }>(() => ({ channel: "master", parametric: false }));

function setCurve(channel: Channel, curve: Curve, label = "Tone Curve") {
  editRecipe(label, (r) => ({ ...r, toneCurve: { ...r.toneCurve, [channel]: curve } }));
}

/**
 * The curve editor. In a panel it is a dark square; `overlay` draws it over the photo
 * (a phone, like Lightroom mobile) at whatever size its box has, in that box's own
 * pixels so the points stay round, with larger points for fingers.
 */
function CurveGraph({ tc, channel, overlay = false }: { tc: ToneCurve; channel: Channel; overlay?: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [box, setBox] = useState({ w: 256, h: 256 });
  useLayoutEffect(() => {
    const el = svg.current;
    if (!overlay || !el) return;
    const measure = () => setBox({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [overlay]);
  const points = tc[channel];
  const { w, h } = box;
  const hit = overlay ? 0.07 : 0.04;
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  const evaluate = interpolatePchip(points);
  const par = parametric(tc.parametric);
  const path = (f: (x: number) => number) =>
    Array.from({ length: 65 }, (_, i) => {
      const x = i / 64;
      return `${i ? "L" : "M"}${x * w},${(1 - clamp(f(x))) * h}`;
    }).join("");

  const move = (index: number, p: { x: number; y: number }) => {
    const next = [...points];
    const lo = index === 0 ? 0 : points[index - 1].x + GAP;
    const hi = index === points.length - 1 ? 1 : points[index + 1].x - GAP;
    next[index] = { x: index === 0 ? Math.min(p.x, hi) : index === points.length - 1 ? Math.max(p.x, lo) : clamp(p.x, lo, hi), y: p.y };
    setCurve(channel, next);
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = toLocal(e);
    let index = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < hit);
    beginGesture("Tone Curve");
    if (index < 0) {
      index = points.findIndex((q) => q.x > p.x);
      if (index <= 0) {
        endGesture();
        return;
      }
      if (p.x - points[index - 1].x < GAP || points[index].x - p.x < GAP) {
        endGesture();
        return;
      }
      setCurve(channel, [...points.slice(0, index), { x: p.x, y: evaluate(p.x) }, ...points.slice(index)]);
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag(index);
  };
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${w} ${h}`}
      className={overlay ? "curve-graph overlay" : "curve-graph"}
      style={overlay ? undefined : { width: "100%", aspectRatio: "1", background: "#101010", borderRadius: 3, touchAction: "none", cursor: "crosshair" }}
      role="img"
      aria-label={`${channel} tone curve`}
      onPointerDown={onDown}
      onPointerMove={(e) => {
        if (drag === null) return;
        const p = toLocal(e);
        // Dragging an inner point far outside the graph removes it.
        const r = svg.current!.getBoundingClientRect();
        const outside = e.clientX < r.left - 30 || e.clientX > r.right + 30 || e.clientY < r.top - 30 || e.clientY > r.bottom + 30;
        if (outside && drag > 0 && drag < points.length - 1) {
          setCurve(channel, points.filter((_, i) => i !== drag));
          setDrag(null);
          return;
        }
        move(drag, p);
      }}
      onPointerUp={() => {
        setDrag(null);
        endGesture();
      }}
      onDoubleClick={(e) => {
        const p = toLocal(e);
        const index = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < hit);
        if (index > 0 && index < points.length - 1) setCurve(channel, points.filter((_, i) => i !== index), "Remove curve point");
      }}
    >
      {overlay && <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke="rgb(255 255 255 / 0.35)" />}
      {[0.25, 0.5, 0.75].map((t) => (
        <g key={t} stroke={overlay ? "rgb(255 255 255 / 0.22)" : "#2a2a2a"}>
          <line x1={t * w} y1={0} x2={t * w} y2={h} />
          <line x1={0} y1={t * h} x2={w} y2={t * h} />
        </g>
      ))}
      {!overlay && <line x1={0} y1={h} x2={w} y2={0} stroke="#333" />}
      {channel === "master" && <path d={path(par)} fill="none" stroke={overlay ? "rgb(255 255 255 / 0.4)" : "#777"} strokeDasharray="3 3" />}
      <path
        d={path((x) => evaluate(channel === "master" ? par(x) : x))}
        fill="none"
        stroke={channelColor[channel]}
        strokeWidth={overlay ? 2 : 1.5}
        style={overlay ? { filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.7))" } : undefined}
      />
      {points.map((p, i) =>
        overlay ? (
          <circle key={i} cx={p.x * w} cy={(1 - p.y) * h} r={drag === i ? 11 : 9} fill={drag === i ? "#fff" : "rgb(220 220 220 / 0.9)"} stroke="rgb(0 0 0 / 0.45)" strokeWidth={1} />
        ) : (
          <circle key={i} cx={p.x * w} cy={(1 - p.y) * h} r={4.5} fill={drag === i ? channelColor[channel] : "#111"} stroke={channelColor[channel]} strokeWidth={1.5} />
        ),
      )}
    </svg>
  );
}

/** The curve and its sliders (the panel header holds Reset). */
export function ToneCurveControls() {
  const recipe = useRecipe();
  const channel = useStore(curveChannel, (s) => s.channel);
  if (!recipe) return null;
  const tc = recipe.toneCurve;
  const setParam = (field: keyof ParametricCurve, value: number) =>
    editRecipe(parametricRanges[field].label, (r) => ({ ...r, toneCurve: { ...r.toneCurve, parametric: { ...r.toneCurve.parametric, [field]: value } } }));
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="segmented" role="group" aria-label="Curve channel">
          {(["master", "red", "green", "blue"] as const).map((c) => (
            <button key={c} type="button" aria-pressed={channel === c} onClick={() => curveChannel.setState({ channel: c })} style={{ color: c === "master" ? undefined : channelColor[c] }}>
              {c === "master" ? "RGB" : c[0].toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <CurveGraph tc={tc} channel={channel} />
      <p className="faint" style={{ fontSize: 10, margin: "4px 0 8px" }}>
        Click to add a point, drag to shape, double-click or drag out to remove.
      </p>
      {channel === "master" &&
        (["highlights", "lights", "darks", "shadows"] as const).map((f) => (
          <Slider
            key={f}
            label={parametricRanges[f].label}
            value={tc.parametric[f]}
            min={-100}
            max={100}
            defaultValue={0}
            onGestureStart={() => beginGesture(parametricRanges[f].label)}
            onGestureEnd={endGesture}
            onChange={(v) => setParam(f, v)}
          />
        ))}
    </>
  );
}

export function ToneCurvePanel() {
  const recipe = useRecipe();
  if (!recipe) return null;
  return (
    <Panel
      id="dev-curve"
      title="Tone Curve"
      actions={
        <button type="button" className="btn ghost small" onClick={() => setCurve(curveChannel.getState().channel, identityCurve, "Reset curve")}>
          Reset
        </button>
      }
    >
      <ToneCurveControls />
    </Panel>
  );
}

/** A phone's curve: drawn over the photo while the Curve group is open (see `CurveBar`). */
export function CurveOverlay() {
  const recipe = useRecipe();
  const channel = useStore(curveChannel, (s) => s.channel);
  if (!recipe) return null;
  return (
    <div className="curve-overlay">
      <CurveGraph tc={recipe.toneCurve} channel={channel} overlay />
    </div>
  );
}

const channelNames: Record<Channel, string> = { master: "RGB", red: "Red", green: "Green", blue: "Blue" };

/**
 * A phone's Curve panel, like Lightroom mobile's: a slim bar under the photo (the
 * curve itself is drawn over the photo) with the channels, the parametric sliders
 * behind a toggle, Reset, and Done to go back to the other groups.
 */
export function CurveBar({ onDone }: { onDone: () => void }) {
  const recipe = useRecipe();
  const { channel, parametric: showParametric } = useStore(curveChannel, (s) => s);
  if (!recipe) return null;
  const tc = recipe.toneCurve;
  const setParam = (field: keyof ParametricCurve, value: number) =>
    editRecipe(parametricRanges[field].label, (r) => ({ ...r, toneCurve: { ...r.toneCurve, parametric: { ...r.toneCurve.parametric, [field]: value } } }));
  return (
    <div className="curve-bar">
      <div className="curve-bar-head">
        <strong>Curve</strong>
        <button type="button" className="btn ghost small" onClick={() => setCurve(channel, identityCurve, "Reset curve")}>
          Reset
        </button>
        <button type="button" className="done-pill" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="curve-channels" role="group" aria-label="Curve channel">
        {(["master", "red", "green", "blue"] as const).map((c) => (
          <button
            key={c}
            type="button"
            className="curve-channel"
            aria-label={channelNames[c]}
            aria-pressed={channel === c && !showParametric}
            style={{ "--channel": channelColor[c] } as React.CSSProperties}
            onClick={() => curveChannel.setState({ channel: c, parametric: false })}
          />
        ))}
        <button
          type="button"
          className="curve-channel parametric"
          aria-label="Parametric sliders"
          aria-pressed={showParametric}
          onClick={() => curveChannel.setState({ channel: "master", parametric: !showParametric })}
        >
          <Icon name="edit" size={22} />
        </button>
      </div>
      {showParametric && (
        <div className="deck-scroll curve-params">
          {(["highlights", "lights", "darks", "shadows"] as const).map((f) => (
            <Slider
              key={f}
              label={parametricRanges[f].label}
              value={tc.parametric[f]}
              min={-100}
              max={100}
              defaultValue={0}
              onGestureStart={() => beginGesture(parametricRanges[f].label)}
              onGestureEnd={endGesture}
              onChange={(v) => setParam(f, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
