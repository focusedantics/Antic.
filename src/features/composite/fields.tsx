import { Slider } from "@/components/Slider";
import type { Gradient, GradientStop, Layer } from "@/core/document/model";
import { updateLayer } from "@/core/document/operations";
import { beginDocGesture, editDocument, endDocGesture } from "@/core/document/session";

/** One undoable change to a layer. */
export const set = (id: string, label: string, change: (l: Layer) => Layer) => editDocument(label, (d) => updateLayer(d, id, change));

export function Num({ label, value, onCommit, step = 1, suffix }: { label: string; value: number; onCommit: (v: number) => void; step?: number; suffix?: string }) {
  return (
    <label className="field" style={{ minWidth: 0 }}>
      <span>{label}</span>
      <input
        className="input num"
        type="number"
        step={step}
        value={Math.round(value / step) * step}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onCommit(v);
        }}
        aria-label={`${label}${suffix ? ` (${suffix})` : ""}`}
      />
    </label>
  );
}

export function stopsCss(g: Gradient) {
  const stops = g.stops.map((s) => {
    const r = parseInt(s.color.slice(1, 3), 16);
    const gg = parseInt(s.color.slice(3, 5), 16);
    const b = parseInt(s.color.slice(5, 7), 16);
    return `rgba(${r},${gg},${b},${s.opacity}) ${Math.round(s.offset * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")}), conic-gradient(#555 25%, #333 0 50%, #555 0 75%, #333 0) 0 0 / 10px 10px`;
}

/** Edits a gradient: type, stops, angle, scale, offset, reverse. Used by gradient layers, text and paths. */
export function GradientEditor({ gradient: g, onChange, title = "Gradient" }: { gradient: Gradient; onChange: (label: string, patch: Partial<Gradient>) => void; title?: string | null }) {
  const update = onChange;
  const setStop = (i: number, patch: Partial<GradientStop>) => update("Gradient stop", { stops: g.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)).sort((a, b) => a.offset - b.offset) });
  return (
    <>
      {title && <div className="subhead">{title}</div>}
      <div className="segmented" style={{ marginBottom: 6 }}>
        <button type="button" aria-pressed={g.type === "linear"} onClick={() => update("Linear gradient", { type: "linear" })}>
          Linear
        </button>
        <button type="button" aria-pressed={g.type === "radial"} onClick={() => update("Radial gradient", { type: "radial" })}>
          Radial
        </button>
      </div>
      <div className="gradient-preview" style={{ background: stopsCss(g) }} />
      {g.stops.map((s, i) => (
        <div className="stop-row" key={i}>
          <input type="color" value={s.color} aria-label={`Stop ${i + 1} color`} onChange={(e) => setStop(i, { color: e.target.value })} />
          <input type="range" min={0} max={100} value={Math.round(s.offset * 100)} aria-label={`Stop ${i + 1} position`} onChange={(e) => setStop(i, { offset: Number(e.target.value) / 100 })} />
          <input className="input num" type="number" min={0} max={100} value={Math.round(s.opacity * 100)} aria-label={`Stop ${i + 1} opacity %`} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setStop(i, { opacity: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })} />
          <button type="button" className="btn ghost small" disabled={g.stops.length <= 2} aria-label={`Remove stop ${i + 1}`} onClick={() => update("Remove stop", { stops: g.stops.filter((_, j) => j !== i) })}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn small"
        disabled={g.stops.length >= 16}
        onClick={() => {
          const a = g.stops[0];
          const b = g.stops[g.stops.length - 1];
          update("Add stop", { stops: [...g.stops, { offset: (a.offset + b.offset) / 2, color: a.color, opacity: (a.opacity + b.opacity) / 2 }].sort((x, y) => x.offset - y.offset) });
        }}
      >
        + Stop
      </button>
      {g.type === "linear" && (
        <Slider label="Angle" value={g.angle} min={-180} max={180} defaultValue={90} format={(v) => `${v}°`} onGestureStart={() => beginDocGesture("Gradient angle")} onGestureEnd={endDocGesture} onChange={(v) => update("Gradient angle", { angle: v })} />
      )}
      <Slider label="Scale" value={Math.round(g.scale * 100)} min={10} max={300} defaultValue={100} format={(v) => `${v}%`} onGestureStart={() => beginDocGesture("Gradient scale")} onGestureEnd={endDocGesture} onChange={(v) => update("Gradient scale", { scale: v / 100 })} />
      <Slider label="Offset X" value={Math.round(g.offsetX * 100)} min={-100} max={100} defaultValue={0} onGestureStart={() => beginDocGesture("Gradient position")} onGestureEnd={endDocGesture} onChange={(v) => update("Gradient position", { offsetX: v / 100 })} />
      <Slider label="Offset Y" value={Math.round(g.offsetY * 100)} min={-100} max={100} defaultValue={0} onGestureStart={() => beginDocGesture("Gradient position")} onGestureEnd={endDocGesture} onChange={(v) => update("Gradient position", { offsetY: v / 100 })} />
      <label className="check">
        <input type="checkbox" checked={g.reverse} onChange={(e) => update("Reverse gradient", { reverse: e.target.checked })} /> Reverse
      </label>
    </>
  );
}

