import { type PointerEvent, useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
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
const curveChannel = createStore<{ channel: Channel }>(() => ({ channel: "master" }));

function setCurve(channel: Channel, curve: Curve, label = "Tone Curve") {
  editRecipe(label, (r) => ({ ...r, toneCurve: { ...r.toneCurve, [channel]: curve } }));
}

function CurveGraph({ tc, channel }: { tc: ToneCurve; channel: Channel }) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const points = tc[channel];
  const size = 256;
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  const evaluate = interpolatePchip(points);
  const par = parametric(tc.parametric);
  const path = (f: (x: number) => number) =>
    Array.from({ length: 65 }, (_, i) => {
      const x = i / 64;
      return `${i ? "L" : "M"}${x * size},${(1 - clamp(f(x))) * size}`;
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
    let index = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.04);
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
      viewBox={`0 0 ${size} ${size}`}
      style={{ width: "100%", aspectRatio: "1", background: "#101010", borderRadius: 3, touchAction: "none", cursor: "crosshair" }}
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
        const index = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.04);
        if (index > 0 && index < points.length - 1) setCurve(channel, points.filter((_, i) => i !== index), "Remove curve point");
      }}
    >
      {[0.25, 0.5, 0.75].map((t) => (
        <g key={t} stroke="#2a2a2a">
          <line x1={t * size} y1={0} x2={t * size} y2={size} />
          <line x1={0} y1={t * size} x2={size} y2={t * size} />
        </g>
      ))}
      <line x1={0} y1={size} x2={size} y2={0} stroke="#333" />
      {channel === "master" && <path d={path(par)} fill="none" stroke="#777" strokeDasharray="3 3" />}
      <path d={path((x) => evaluate(channel === "master" ? par(x) : x))} fill="none" stroke={channelColor[channel]} strokeWidth={1.5} />
      {points.map((p, i) => (
        <circle key={i} cx={p.x * size} cy={(1 - p.y) * size} r={4.5} fill={drag === i ? channelColor[channel] : "#111"} stroke={channelColor[channel]} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

/** The curve and its sliders. `inlineReset` puts Reset beside the channels (a phone has no panel header). */
export function ToneCurveControls({ inlineReset = false }: { inlineReset?: boolean }) {
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
        {inlineReset && (
          <button type="button" className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setCurve(channel, identityCurve, "Reset curve")}>
            Reset
          </button>
        )}
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
