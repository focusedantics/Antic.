import { useStore } from "@/app/hooks";
import { openMenu } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { formatSigned, Slider } from "@/components/Slider";
import { defaultLocalAdjustments } from "@/core/develop/defaults";
import { apply, outputToSource } from "@/core/develop/geometry";
import {
  addComponent,
  addMask,
  defaultShape,
  duplicateMask,
  invertMask,
  newComponent,
  removeComponent,
  removeMask,
  setLocal,
  type ShapeKind,
  shapeLabels,
  setCutout,
  updateComponent,
  updateMask,
} from "@/core/develop/masks";
import { localRanges } from "@/core/develop/params";
import type { LocalAdjustments, Mask, MaskComponent, MaskOperation, MaskShape } from "@/core/develop/recipe";
import { beginGesture, develop, editRecipe, endGesture } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { TEMPERATURE_TRACK, TINT_TRACK } from "../edit";
import { brush } from "./brush";
import { aiPreferences, aiStatus } from "@/core/ai/client";
import { aiMenuItems, removeBackground } from "./ai";
import { cutoutRun } from "@/components/cutoutFx";

type ManualKind = Exclude<ShapeKind, "ai">;
const manualKinds: ManualKind[] = ["brush", "linear", "radial", "luminance", "color"];

/** Center of the current view, in source uv, so new gradients appear where the user is looking. */
function viewCenterSource() {
  const { assetId } = develop.getState();
  const engine = developEngine();
  const recipe = engine.displayRecipe();
  const src = assetId ? engine.sourceFor(assetId) : null;
  if (!recipe || !src) return { center: { x: 0.5, y: 0.5 }, aspect: 1.5 };
  const { view } = develop.getState();
  const [x, y] = apply(outputToSource(src.size, recipe.geometry), view.fit ? 0.5 : view.centerX, view.fit ? 0.5 : view.centerY);
  return { center: { x, y }, aspect: src.size.width / src.size.height };
}

function shapeFor(kind: ManualKind): MaskShape {
  const { center, aspect } = viewCenterSource();
  return defaultShape(kind, center, 0.25, aspect);
}

export function createMask(kind: ManualKind, preset?: { name: string; adjustments: Partial<LocalAdjustments> }) {
  editRecipe(preset ? preset.name : `New ${shapeLabels[kind]} mask`, (r) => {
    const { recipe, mask } = addMask(r, shapeFor(kind), preset?.name);
    queueMicrotask(() => develop.setState({ activeMaskId: mask.id, activeComponentId: mask.components[0].id, tool: "mask" }));
    return preset ? updateMask(recipe, mask.id, (m) => ({ ...m, adjustments: { ...m.adjustments, ...preset.adjustments } })) : recipe;
  });
}

function addTo(mask: Mask, kind: ManualKind, operation: MaskOperation) {
  const component = newComponent(shapeFor(kind), operation);
  editRecipe(`${operation === "add" ? "Add" : operation === "subtract" ? "Subtract" : "Intersect"} ${shapeLabels[kind]}`, (r) => addComponent(r, mask.id, component));
  develop.setState({ activeComponentId: component.id });
  if (kind === "brush") brush.setState({ erase: false });
}

function operationMenu(mask: Mask, operation: MaskOperation) {
  return (e: React.MouseEvent) =>
    openMenu(e.clientX, e.clientY, [
      ...manualKinds.map((k) => ({ label: shapeLabels[k], onSelect: () => addTo(mask, k, operation) })),
      "separator" as const,
      ...aiMenuItems(mask.id, operation),
    ]);
}

function componentLabel(c: MaskComponent) {
  if (c.shape.kind === "ai") return `AI: ${c.shape.target[0].toUpperCase()}${c.shape.target.slice(1)}`;
  return shapeLabels[c.shape.kind];
}

function ComponentRow({ mask, component, active }: { mask: Mask; component: MaskComponent; active: boolean }) {
  const set = (label: string, change: (c: MaskComponent) => MaskComponent) => editRecipe(label, (r) => updateComponent(r, mask.id, component.id, change));
  const first = mask.components[0].id === component.id;
  return (
    <div className="row" style={{ padding: "2px 0" }}>
      <button type="button" className="nav-item" aria-current={active} onClick={() => develop.setState({ activeComponentId: component.id })} style={{ flex: 1 }}>
        <span className="name">
          {first ? "" : component.operation === "add" ? "+ " : component.operation === "subtract" ? "− " : "∩ "}
          {componentLabel(component)}
        </span>
      </button>
      {!first && (
        <select className="input" aria-label="Combine" value={component.operation} onChange={(e) => set("Mask operation", (c) => ({ ...c, operation: e.target.value as MaskOperation }))} style={{ width: 86 }}>
          <option value="add">Add</option>
          <option value="subtract">Subtract</option>
          <option value="intersect">Intersect</option>
        </select>
      )}
      <button type="button" className="btn ghost small" aria-pressed={component.invert} title="Invert this component" onClick={() => set("Invert component", (c) => ({ ...c, invert: !c.invert }))}>
        Inv
      </button>
      <button
        type="button"
        className="btn ghost small"
        aria-label="Delete component"
        onClick={() => {
          if (mask.components.length === 1) {
            editRecipe("Delete mask", (r) => removeMask(r, mask.id));
            develop.setState({ activeMaskId: null, activeComponentId: null });
          } else {
            editRecipe("Delete mask component", (r) => removeComponent(r, mask.id, component.id));
            if (active) develop.setState({ activeComponentId: mask.components.find((c) => c.id !== component.id)?.id ?? null });
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}

function ComponentSettings({ mask, component }: { mask: Mask; component: MaskComponent }) {
  const b = useStore(brush, (s) => s);
  const set = (label: string, change: (c: MaskComponent) => MaskComponent) => editRecipe(label, (r) => updateComponent(r, mask.id, component.id, change));
  const shape = component.shape;
  const opacity = (
    <Slider
      label="Opacity"
      value={Math.round(component.opacity * 100)}
      min={0}
      max={100}
      defaultValue={100}
      format={(v) => `${v}%`}
      onGestureStart={() => beginGesture("Component opacity")}
      onGestureEnd={endGesture}
      onChange={(v) => set("Component opacity", (c) => ({ ...c, opacity: v / 100 }))}
    />
  );
  switch (shape.kind) {
    case "brush":
      return (
        <>
          <div className="row" style={{ marginBottom: 4 }}>
            <div className="segmented">
              <button type="button" aria-pressed={!b.erase} onClick={() => brush.setState({ erase: false })}>
                Paint
              </button>
              <button type="button" aria-pressed={b.erase} title="Erase (hold Alt)" onClick={() => brush.setState({ erase: true })}>
                Erase
              </button>
            </div>
            <span className="spacer" />
            <button type="button" className="btn small" disabled={!shape.strokes.length} onClick={() => set("Clear brush", (c) => ({ ...c, shape: { kind: "brush", strokes: [] } }))}>
              Clear
            </button>
          </div>
          <Slider label="Size" value={Math.round(b.size * 1000) / 10} min={0.2} max={40} step={0.1} defaultValue={6} format={(v) => v.toFixed(1)} onChange={(v) => brush.setState({ size: v / 100 })} />
          <Slider label="Feather" value={Math.round(b.feather * 100)} min={0} max={100} defaultValue={60} format={(v) => `${v}`} onChange={(v) => brush.setState({ feather: v / 100 })} />
          <Slider label="Flow" value={Math.round(b.flow * 100)} min={1} max={100} defaultValue={80} format={(v) => `${v}`} onChange={(v) => brush.setState({ flow: v / 100 })} />
          <Slider label="Density" value={Math.round(b.density * 100)} min={1} max={100} defaultValue={100} format={(v) => `${v}`} onChange={(v) => brush.setState({ density: v / 100 })} />
          <p className="faint" style={{ fontSize: 10 }}>
            Paint on the photo. [ and ] change the size, Alt erases.
          </p>
          {opacity}
        </>
      );
    case "linear":
      return (
        <>
          <p className="faint" style={{ fontSize: 10 }}>
            Drag on the photo to draw the gradient, or drag its handles.
          </p>
          {opacity}
        </>
      );
    case "radial":
      return (
        <>
          <p className="faint" style={{ fontSize: 10 }}>
            Drag on the photo to draw an ellipse; drag the center or edge handles to adjust.
          </p>
          <Slider label="Feather" value={shape.feather} min={0} max={100} defaultValue={50} format={(v) => `${v}`} onGestureStart={() => beginGesture("Radial feather")} onGestureEnd={endGesture} onChange={(v) => set("Radial feather", (c) => ({ ...c, shape: { ...shape, feather: v } }))} />
          {opacity}
        </>
      );
    case "luminance":
      return (
        <>
          <Slider
            label="Low"
            value={Math.round(shape.low * 100)}
            min={0}
            max={100}
            defaultValue={60}
            format={(v) => `${v}`}
            onGestureStart={() => beginGesture("Luminance range")}
            onGestureEnd={endGesture}
            onChange={(v) => set("Luminance range", (c) => ({ ...c, shape: { ...shape, low: Math.min(v / 100, shape.high) } }))}
          />
          <Slider
            label="High"
            value={Math.round(shape.high * 100)}
            min={0}
            max={100}
            defaultValue={100}
            format={(v) => `${v}`}
            onGestureStart={() => beginGesture("Luminance range")}
            onGestureEnd={endGesture}
            onChange={(v) => set("Luminance range", (c) => ({ ...c, shape: { ...shape, high: Math.max(v / 100, shape.low) } }))}
          />
          <Slider
            label="Smoothness"
            value={Math.round(shape.smoothness * 100)}
            min={0}
            max={100}
            defaultValue={15}
            format={(v) => `${v}`}
            onGestureStart={() => beginGesture("Luminance smoothness")}
            onGestureEnd={endGesture}
            onChange={(v) => set("Luminance smoothness", (c) => ({ ...c, shape: { ...shape, smoothness: v / 100 } }))}
          />
          <p className="faint" style={{ fontSize: 10 }}>
            Click the photo to select the tones around that point.
          </p>
          {opacity}
        </>
      );
    case "color":
      return (
        <>
          <div className="row wrap" style={{ margin: "4px 0" }}>
            {shape.samples.map((s, i) => (
              <span key={i} className="chip" title={`Sample ${i + 1}`}>
                <span className="label-chip" style={{ background: oklabCss(s) }} />
                <button type="button" aria-label="Remove sample" onClick={() => set("Remove color sample", (c) => ({ ...c, shape: { ...shape, samples: shape.samples.filter((_, j) => j !== i) } }))}>
                  ✕
                </button>
              </span>
            ))}
            {!shape.samples.length && <span className="faint">Click the photo to pick a color. Shift-click adds up to 5.</span>}
          </div>
          <Slider label="Refine" value={shape.refine} min={0} max={100} defaultValue={50} format={(v) => `${v}`} onGestureStart={() => beginGesture("Color refine")} onGestureEnd={endGesture} onChange={(v) => set("Color refine", (c) => ({ ...c, shape: { ...shape, refine: v } }))} />
          {opacity}
        </>
      );
    case "ai":
      return (
        <>
          <Slider label="Feather" value={shape.feather} min={0} max={100} defaultValue={0} format={(v) => `${v}`} onGestureStart={() => beginGesture("Selection feather")} onGestureEnd={endGesture} onChange={(v) => set("Selection feather", (c) => ({ ...c, shape: { ...shape, feather: v } }))} />
          <Slider label="Shift edge" value={shape.shift} min={-100} max={100} defaultValue={0} onGestureStart={() => beginGesture("Shift edge")} onGestureEnd={endGesture} onChange={(v) => set("Shift edge", (c) => ({ ...c, shape: { ...shape, shift: v } }))} />
          <p className="faint" style={{ fontSize: 10 }}>
            {shape.target === "object"
              ? "Click to add to the object, Alt-click to exclude."
              : "Detected on this device. Negative shift contracts the edge, positive expands. Add or subtract a brush to fix details."}
          </p>
          {opacity}
        </>
      );
  }
}

function oklabCss([L, a, b]: readonly [number, number, number]) {
  return `oklab(${(L * 100).toFixed(1)}% ${a.toFixed(3)} ${b.toFixed(3)})`;
}

const localKeys = Object.keys(localRanges) as (keyof LocalAdjustments)[];

function LocalSliders({ mask }: { mask: Mask }) {
  return (
    <>
      <div className="row">
        <div className="subhead" style={{ flex: 1 }}>
          Adjustments
        </div>
        <button type="button" className="btn ghost small" onClick={() => editRecipe("Reset mask sliders", (r) => updateMask(r, mask.id, (m) => ({ ...m, adjustments: defaultLocalAdjustments })))}>
          Reset
        </button>
      </div>
      <Slider
        label="Amount"
        value={Math.round(mask.amount * 100)}
        min={0}
        max={100}
        defaultValue={100}
        format={(v) => `${v}%`}
        onGestureStart={() => beginGesture("Mask amount")}
        onGestureEnd={endGesture}
        onChange={(v) => editRecipe("Mask amount", (r) => updateMask(r, mask.id, (m) => ({ ...m, amount: v / 100 })))}
      />
      {localKeys.map((key) => {
        const range = localRanges[key];
        return (
          <Slider
            key={key}
            label={range.label}
            value={mask.adjustments[key]}
            min={range.min}
            max={range.max}
            step={range.step}
            defaultValue={0}
            track={key === "temperature" ? TEMPERATURE_TRACK : key === "tint" ? TINT_TRACK : undefined}
            format={(v) => (key === "hue" ? `${formatSigned(v)}°` : formatSigned(v, range.step))}
            onGestureStart={() => beginGesture(`Mask ${range.label}`)}
            onGestureEnd={endGesture}
            onChange={(v) => editRecipe(`Mask ${range.label}`, (r) => setLocal(r, mask.id, key, v))}
          />
        );
      })}
    </>
  );
}

function AiModelPicker() {
  const quality = useStore(aiPreferences, (s) => s.quality);
  return (
    <label className="row dim" style={{ fontSize: 11, marginBottom: 6 }}>
      Subject AI
      <select className="input" style={{ flex: 1 }} value={quality} onChange={(e) => aiPreferences.setState({ quality: e.target.value as typeof quality })}>
        <option value="quality">Best — BiRefNet Lite (115 MB, downloads once)</option>
        <option value="fast">Fast — MODNet (7 MB, best for portraits)</option>
        <option value="offline">Offline — U²-Netp (bundled)</option>
      </select>
    </label>
  );
}

function AiStatusLine() {
  const status = useStore(aiStatus, (s) => s);
  if (status.busy)
    return (
      <div className="progress-pill" role="status" aria-live="polite" style={{ margin: "4px 0 8px" }}>
        {status.busy}
        {status.model && status.progress > 0 && status.progress < 100 ? ` · downloading ${status.model} ${status.progress}%` : "…"}
        <span className="progress-bar">
          <div style={{ width: `${status.progress || 8}%` }} />
        </span>
      </div>
    );
  if (status.lastModel)
    return (
      <p className="faint" style={{ fontSize: 10, margin: "0 0 6px" }}>
        Last AI selection: {status.lastModel}. Runs locally; photos are never uploaded.
      </p>
    );
  return null;
}

export function MasksPanel() {
  const masks = useStore(develop, (s) => s.recipe?.masks ?? []);
  const activeMaskId = useStore(develop, (s) => s.activeMaskId);
  const activeComponentId = useStore(develop, (s) => s.activeComponentId);
  const overlay = useStore(develop, (s) => s.maskOverlay);
  const bw = useStore(develop, (s) => s.maskBw);
  const active = masks.find((m) => m.id === activeMaskId) ?? null;
  const component = active?.components.find((c) => c.id === activeComponentId) ?? active?.components[0] ?? null;
  const removing = useStore(cutoutRun, (st) => st.running);
  const createMenu = (e: React.MouseEvent) =>
    openMenu(e.clientX, e.clientY, [
      ...manualKinds.map((k) => ({ label: shapeLabels[k], onSelect: () => createMask(k) })),
      "separator" as const,
      { label: "Dodge (brush, +⅓ stop)", onSelect: () => createMask("brush", { name: "Dodge", adjustments: { exposure: 0.35 } }) },
      { label: "Burn (brush, −⅓ stop)", onSelect: () => createMask("brush", { name: "Burn", adjustments: { exposure: -0.35 } }) },
      "separator" as const,
      ...aiMenuItems(null, "add"),
    ]);
  return (
    <Panel
      id="dev-masks"
      title="Masks"
      actions={
        <>
          {masks.some((m) => m.cutout) ? (
            // Like Composite's "Restore background": the photo is opaque again; the mask stays to reuse.
            <button type="button" className="btn small" title="Make the background visible again (the mask is kept)" disabled={removing} onClick={() => editRecipe("Restore background", (r) => setCutout(r, null))}>
              Restore BG
            </button>
          ) : (
            <button type="button" className="btn small" title="Make everything but the subject transparent" disabled={removing} aria-busy={removing} onClick={() => void removeBackground()}>
              Remove BG
            </button>
          )}
          <button type="button" className="btn small" onClick={createMenu}>
            + Create
          </button>
        </>
      }
    >
      <AiModelPicker />
      <AiStatusLine />
      {!masks.length && <p className="faint">Masks limit adjustments to part of the photo: paint them, draw gradients, pick tones or colors, or let the local AI select the subject or sky.</p>}
      {masks.map((m) => (
        <div key={m.id} className="row">
          <button
            type="button"
            className="nav-item"
            aria-current={m.id === activeMaskId}
            style={{ flex: 1 }}
            onClick={() => develop.setState({ activeMaskId: m.id, activeComponentId: m.components[0]?.id ?? null, tool: "mask" })}
            onDoubleClick={() => {
              const name = prompt("Mask name", m.name);
              if (name?.trim()) editRecipe("Rename mask", (r) => updateMask(r, m.id, (x) => ({ ...x, name: name.trim() })));
            }}
          >
            <span className="name">
              {m.cutout ? "◩ " : ""}
              {m.name}
            </span>
            <span className="count">{m.components.length > 1 ? `${m.components.length} parts` : ""}</span>
          </button>
          <button type="button" className="btn ghost small" aria-pressed={!m.visible} title={m.visible ? "Hide mask" : "Show mask"} onClick={() => editRecipe(m.visible ? "Hide mask" : "Show mask", (r) => updateMask(r, m.id, (x) => ({ ...x, visible: !x.visible })))}>
            {m.visible ? "◉" : "○"}
          </button>
          <button
            type="button"
            className="btn ghost small"
            aria-label={`More actions for ${m.name}`}
            onClick={(e) =>
              openMenu(e.clientX, e.clientY, [
                { label: m.invert ? "Uninvert mask" : "Invert mask", onSelect: () => editRecipe("Invert mask", (r) => invertMask(r, m.id)) },
                { label: "Duplicate mask", onSelect: () => editRecipe("Duplicate mask", (r) => duplicateMask(r, m.id)) },
                {
                  label: m.cutout ? "Stop using as transparency" : "Use as transparency (cut out)",
                  onSelect: () => editRecipe(m.cutout ? "Remove transparency" : "Use mask as transparency", (r) => setCutout(r, m.cutout ? null : m.id)),
                },
                {
                  label: "Rename…",
                  onSelect: () => {
                    const name = prompt("Mask name", m.name);
                    if (name?.trim()) editRecipe("Rename mask", (r) => updateMask(r, m.id, (x) => ({ ...x, name: name.trim() })));
                  },
                },
                "separator",
                {
                  label: "Delete mask",
                  danger: true,
                  onSelect: () => {
                    editRecipe("Delete mask", (r) => removeMask(r, m.id));
                    if (m.id === activeMaskId) develop.setState({ activeMaskId: null, activeComponentId: null });
                  },
                },
              ])
            }
          >
            ⋯
          </button>
        </div>
      ))}
      {active && (
        <>
          <div className="subhead">Components{active.invert ? " (inverted)" : ""}</div>
          {active.components.map((c) => (
            <ComponentRow key={c.id} mask={active} component={c} active={c.id === component?.id} />
          ))}
          <div className="row" style={{ marginTop: 4 }}>
            <button type="button" className="btn small" onClick={operationMenu(active, "add")}>
              Add
            </button>
            <button type="button" className="btn small" onClick={operationMenu(active, "subtract")}>
              Subtract
            </button>
            <button type="button" className="btn small" onClick={operationMenu(active, "intersect")}>
              Intersect
            </button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="check">
              <input type="checkbox" checked={overlay} onChange={(e) => develop.setState({ maskOverlay: e.target.checked })} /> Overlay (O)
            </label>
            <label className="check">
              <input type="checkbox" checked={bw} onChange={(e) => develop.setState({ maskBw: e.target.checked })} /> B&W mask
            </label>
          </div>
          {component && (
            <>
              <div className="subhead">{componentLabel(component)}</div>
              <ComponentSettings mask={active} component={component} />
            </>
          )}
          <LocalSliders mask={active} />
        </>
      )}
    </Panel>
  );
}
