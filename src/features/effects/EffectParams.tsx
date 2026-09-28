import { Slider } from "@/components/Slider";
import { effectById, newEffect } from "@/core/effects/registry";
import type { EffectInstance, ParamValue } from "@/core/effects/types";

/** Every parameter of an effect as controls; used by effect layers and video edits. */
const decimalsFor = (step: number) => (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step))));

export function EffectParams({
  effect,
  onParam,
  onGestureStart,
  onGestureEnd,
  onReset,
  onChangeEffect,
  note,
}: {
  effect: EffectInstance;
  onParam: (key: string, label: string, value: ParamValue) => void;
  onGestureStart: (label: string) => void;
  onGestureEnd: () => void;
  onReset: (fresh: EffectInstance) => void;
  onChangeEffect: () => void;
  note?: string;
}) {
  const def = effectById(effect.id);
  if (!def) return <p className="faint">Unknown effect.</p>;
  const params = effect.params;
  const setParam = (key: string, label: string, value: ParamValue) => onParam(key, `${def.name}: ${label}`, value);
  const hasSeed = def.params.some((p) => p.key === "seed");
  return (
    <>
      <div className="subhead">Effect</div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong>{def.name}</strong> <span className="faint">· {def.category}</span>
        </span>
        <button type="button" className="btn small" onClick={onChangeEffect}>
          Change…
        </button>
      </div>
      <p className="dim" style={{ margin: "0 0 8px", fontSize: 11 }}>{def.description}</p>
      {def.params.map((p) => {
        const v = params[p.key] ?? p.default;
        if (p.type === "number") {
          if (p.key === "seed") return null;
          const step = p.step ?? 0.01;
          return (
            <Slider
              key={p.key}
              label={p.label}
              value={typeof v === "number" ? v : p.default}
              min={p.min}
              max={p.max}
              step={step}
              defaultValue={p.default}
              origin={p.min}
              format={(x) => x.toFixed(decimalsFor(step))}
              onGestureStart={() => onGestureStart(`${def.name}: ${p.label}`)}
              onGestureEnd={onGestureEnd}
              onChange={(x) => setParam(p.key, p.label, x)}
            />
          );
        }
        if (p.type === "select")
          return (
            <label key={p.key} className="field" style={{ marginBottom: 6 }}>
              <span>{p.label}</span>
              <select className="input" value={String(v)} onChange={(e) => setParam(p.key, p.label, e.target.value)}>
                {p.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        if (p.type === "color")
          return (
            <label key={p.key} className="row" style={{ marginBottom: 6 }}>
              <input type="color" value={String(v)} aria-label={p.label} onChange={(e) => setParam(p.key, p.label, e.target.value)} />
              <span>{p.label}</span>
            </label>
          );
        if (p.type === "toggle")
          return (
            <label key={p.key} className="check" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={v === true} onChange={(e) => setParam(p.key, p.label, e.target.checked)} /> {p.label}
            </label>
          );
        return (
          <label key={p.key} className="field" style={{ marginBottom: 6 }}>
            <span>{p.label}</span>
            <input
              className="input"
              type="text"
              maxLength={p.maxLength}
              value={String(v)}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setParam(p.key, p.label, e.target.value)}
            />
          </label>
        );
      })}
      <div className="row wrap" style={{ marginTop: 6 }}>
        {hasSeed && (
          <button type="button" className="btn small" title="New random pattern" onClick={() => setParam("seed", "Shuffle", Math.floor(Math.random() * 100))}>
            Shuffle
          </button>
        )}
        <button
          type="button"
          className="btn small ghost"
          onClick={() => onReset(newEffect(def.id)!)}
        >
          Reset
        </button>
      </div>
      {note && (
        <p className="faint" style={{ fontSize: 10 }}>
          {note}
        </p>
      )}
    </>
  );
}

