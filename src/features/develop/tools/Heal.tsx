import { type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { apply, outputToSource, sourceToOutput } from "@/core/develop/geometry";
import type { Spot } from "@/core/develop/recipe";
import { findSource, newSpot } from "@/core/develop/retouch";
import { beginGesture, develop, editRecipe, endGesture } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";

/** Heal tool settings and the selected spot (tool state, not recipe content). */
export const heal = createStore<{ mode: Spot["mode"]; radius: number; feather: number; selected: string | null }>(() => ({
  mode: "heal",
  radius: 0.012,
  feather: 50,
  selected: null,
}));

type Pt = { x: number; y: number };

function mapping() {
  const engine = developEngine();
  const { assetId } = develop.getState();
  const recipe = engine.displayRecipe();
  const src = assetId ? engine.sourceFor(assetId) : null;
  if (!recipe || !src) return null;
  const toSrc = outputToSource(src.size, recipe.geometry);
  const toOut = sourceToOutput(src.size, recipe.geometry);
  const long = Math.max(src.size.width, src.size.height);
  return {
    src,
    long,
    unitX: long / src.size.width,
    unitY: long / src.size.height,
    clientToSource(cx: number, cy: number): Pt {
      const [u, v] = engine.clientToOutput(cx, cy);
      const [x, y] = apply(toSrc, u, v);
      return { x, y };
    },
    sourceToClient(p: Pt): Pt {
      const [u, v] = apply(toOut, p.x, p.y);
      const [x, y] = engine.outputToClient(u, v);
      return { x, y };
    },
  };
}

const updateSpot = (id: string, label: string, patch: Partial<Spot>) =>
  editRecipe(label, (r) => ({ ...r, retouch: r.retouch.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

export function deleteSelectedSpot() {
  const id = heal.getState().selected;
  if (!id) return false;
  editRecipe("Delete spot", (r) => ({ ...r, retouch: r.retouch.filter((s) => s.id !== id) }));
  heal.setState({ selected: null });
  return true;
}

/** Automatic source: search rings around the blemish on a small readback of the photo. */
function autoSource(center: Pt, radius: number): Pt {
  const map = mapping();
  if (!map) return { x: center.x + radius * 2.5, y: center.y };
  const spanX = radius * 10 * map.unitX;
  const spanY = radius * 10 * map.unitY;
  const size = 64;
  const pixels = developEngine().pipelineRef.sampleSource(map.src, size, size, { x: center.x - spanX / 2, y: center.y - spanY / 2, width: spanX, height: spanY });
  // The window spans 10 radii, so one radius is a tenth of the grid.
  const radiusCells = size / 10;
  const { dx, dy } = findSource(pixels, size, radiusCells);
  return {
    x: Math.min(1, Math.max(0, center.x + (dx / size) * spanX)),
    y: Math.min(1, Math.max(0, center.y + (dy / size) * spanY)),
  };
}

export function HealPanel() {
  const spots = useStore(develop, (s) => s.recipe?.retouch ?? []);
  const settings = useStore(heal, (s) => s);
  const selected = spots.find((s) => s.id === settings.selected) ?? null;
  const setSelected = (label: string, patch: Partial<Spot>) => selected && updateSpot(selected.id, label, patch);
  return (
    <Panel id="dev-heal" title="Spot Removal">
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="segmented">
          <button type="button" aria-pressed={(selected?.mode ?? settings.mode) === "heal"} onClick={() => (selected ? setSelected("Heal", { mode: "heal" }) : heal.setState({ mode: "heal" }))}>
            Heal
          </button>
          <button type="button" aria-pressed={(selected?.mode ?? settings.mode) === "clone"} onClick={() => (selected ? setSelected("Clone", { mode: "clone" }) : heal.setState({ mode: "clone" }))}>
            Clone
          </button>
        </div>
        <span className="spacer" />
        <button type="button" className="btn small" disabled={!spots.length} onClick={() => editRecipe("Clear spots", (r) => ({ ...r, retouch: [] }))}>
          Clear all
        </button>
      </div>
      <Slider
        label="Size"
        value={Math.round((selected?.radius ?? settings.radius) * 2000) / 10}
        min={0.2}
        max={20}
        step={0.1}
        defaultValue={2.4}
        format={(v) => v.toFixed(1)}
        onGestureStart={() => selected && beginGesture("Spot size")}
        onGestureEnd={() => selected && endGesture()}
        onChange={(v) => (selected ? setSelected("Spot size", { radius: v / 200 }) : heal.setState({ radius: v / 200 }))}
      />
      <Slider
        label="Feather"
        value={selected?.feather ?? settings.feather}
        min={0}
        max={100}
        defaultValue={50}
        format={(v) => `${v}`}
        onGestureStart={() => selected && beginGesture("Spot feather")}
        onGestureEnd={() => selected && endGesture()}
        onChange={(v) => (selected ? setSelected("Spot feather", { feather: v }) : heal.setState({ feather: v }))}
      />
      {selected && (
        <Slider label="Opacity" value={Math.round(selected.opacity * 100)} min={0} max={100} defaultValue={100} format={(v) => `${v}%`} onGestureStart={() => beginGesture("Spot opacity")} onGestureEnd={endGesture} onChange={(v) => setSelected("Spot opacity", { opacity: v / 100 })} />
      )}
      <p className="faint" style={{ fontSize: 10 }}>
        Click a blemish: a matching source is found automatically. Alt-drag from the blemish to choose the source yourself. Drag circles to adjust; Delete removes the selected spot. {spots.length} spot{spots.length === 1 ? "" : "s"}.
      </p>
    </Panel>
  );
}

export function HealOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    const engine = developEngine();
    const previous = engine.onFrame;
    engine.onFrame = () => force((n) => n + 1);
    return () => {
      engine.onFrame = previous;
    };
  }, []);
  const spots = useStore(develop, (s) => s.recipe?.retouch ?? []);
  const settings = useStore(heal, (s) => s);
  const map = mapping();
  if (!map) return null;
  const rect = developEngine().canvas.getBoundingClientRect();
  const local = (p: Pt) => {
    const c = map.sourceToClient(p);
    return { x: c.x - rect.left, y: c.y - rect.top };
  };
  const screenRadius = (p: Pt, r: number) => {
    const a = local(p);
    const b = local({ x: p.x + r * map.unitX, y: p.y });
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  const drag = (e: ReactPointerEvent, label: string, onMove: (p: Pt, start: Pt) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const start = map.clientToSource(e.clientX, e.clientY);
    beginGesture(label);
    const move = (ev: PointerEvent) => onMove(map.clientToSource(ev.clientX, ev.clientY), start);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      endGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const p = map.clientToSource(e.clientX, e.clientY);
    if (p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1) return;
    const radius = settings.radius;
    if (e.altKey) {
      // Manual source: press on the blemish, release on the source.
      const spot = newSpot(p.x, p.y, p.x, p.y, radius, settings.mode);
      beginGesture("Add spot");
      editRecipe("Add spot", (r) => ({ ...r, retouch: [...r.retouch, { ...spot, feather: settings.feather }] }));
      heal.setState({ selected: spot.id });
      drag(e, "Add spot", (q) => updateSpot(spot.id, "Add spot", { sourceX: q.x, sourceY: q.y }));
      return;
    }
    const source = autoSource(p, radius);
    const spot = { ...newSpot(p.x, p.y, source.x, source.y, radius, settings.mode), feather: settings.feather };
    editRecipe("Add spot", (r) => ({ ...r, retouch: [...r.retouch, spot] }));
    heal.setState({ selected: spot.id });
  };

  return (
    <div className="mask-layer" style={{ cursor: "crosshair" }} onPointerDown={onDown}>
      <svg className="mask-svg" width="100%" height="100%">
        {spots.map((s) => {
          const d = local({ x: s.x, y: s.y });
          const src = local({ x: s.sourceX, y: s.sourceY });
          const r = screenRadius({ x: s.x, y: s.y }, s.radius);
          const selected = s.id === settings.selected;
          const moveDest = (e: ReactPointerEvent) => {
            heal.setState({ selected: s.id });
            drag(e, "Move spot", (q, start) => updateSpot(s.id, "Move spot", { x: s.x + q.x - start.x, y: s.y + q.y - start.y }));
          };
          const moveSource = (e: ReactPointerEvent) => {
            heal.setState({ selected: s.id });
            drag(e, "Move spot source", (q, start) => updateSpot(s.id, "Move spot source", { sourceX: s.sourceX + q.x - start.x, sourceY: s.sourceY + q.y - start.y }));
          };
          return (
            <g key={s.id} opacity={selected ? 1 : 0.7}>
              {selected && <line x1={d.x} y1={d.y} x2={src.x} y2={src.y} stroke="#fff" strokeDasharray="3 3" />}
              {selected && <circle cx={src.x} cy={src.y} r={r} fill="none" stroke="#fff" strokeDasharray="4 3" strokeWidth={1.5} style={{ pointerEvents: "stroke", cursor: "move" }} onPointerDown={moveSource} />}
              <circle cx={d.x} cy={d.y} r={r} fill="transparent" stroke={selected ? "#fff" : "#ddd"} strokeWidth={selected ? 2 : 1} style={{ pointerEvents: "all", cursor: "move" }} onPointerDown={moveDest} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
