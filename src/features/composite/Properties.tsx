import { useStore } from "@/app/hooks";
import { selectAsset, setWorkspace, toast } from "@/app/state";
import { openMenu } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { formatSigned, Slider } from "@/components/Slider";
import { getAsset } from "@/core/catalog/store";
import { basicRanges } from "@/core/develop/params";
import { defaultShape as defaultMaskShape, newComponent, setCutout, shapeLabels } from "@/core/develop/masks";
import type { Basic, MaskComponent } from "@/core/develop/recipe";
import type { Gradient, GradientStop, Layer, ShapeStyle, TextStyle, Transform } from "@/core/document/model";
import { emptyMask, fitTransform, locate, updateLayer } from "@/core/document/operations";
import { beginDocGesture, composite, editDocument, endDocGesture } from "@/core/document/session";
import { recipeFor, setRecipeFor } from "@/core/develop/session";
import { EffectParams } from "@/features/effects/EffectParams";
import { openEffectsBrowser } from "@/features/effects/EffectsBrowser";

const set = (id: string, label: string, change: (l: Layer) => Layer) => editDocument(label, (d) => updateLayer(d, id, change));

function Num({ label, value, onCommit, step = 1, suffix }: { label: string; value: number; onCommit: (v: number) => void; step?: number; suffix?: string }) {
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

function TransformSection({ layer }: { layer: Layer }) {
  const t = layer.transform;
  const update = (label: string, patch: Partial<Transform>) => set(layer.id, label, (l) => ({ ...l, transform: { ...l.transform, ...patch, corners: undefined } }));
  const aspect = t.width / t.height;
  return (
    <>
      <div className="subhead">Transform</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        <Num label="X" value={t.x} onCommit={(x) => update("Move", { x })} />
        <Num label="Y" value={t.y} onCommit={(y) => update("Move", { y })} />
        <Num label="Angle°" value={t.rotation} step={0.1} onCommit={(rotation) => update("Rotate", { rotation })} />
        <Num label="W" value={t.width} onCommit={(width) => update("Resize", { width: Math.max(1, width), height: Math.max(1, width / aspect) })} />
        <Num label="H" value={t.height} onCommit={(height) => update("Resize", { height: Math.max(1, height), width: Math.max(1, height * aspect) })} />
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <button type="button" className="btn small" aria-pressed={t.flipX} onClick={() => update("Flip horizontal", { flipX: !t.flipX })}>
          Flip H
        </button>
        <button type="button" className="btn small" aria-pressed={t.flipY} onClick={() => update("Flip vertical", { flipY: !t.flipY })}>
          Flip V
        </button>
        {t.corners && (
          <button type="button" className="btn small" onClick={() => update("Remove perspective", {})}>
            Reset perspective
          </button>
        )}
        <button
          type="button"
          className="btn small"
          onClick={() => {
            const doc = composite.getState().doc;
            if (doc) set(layer.id, "Fit to canvas", (l) => ({ ...l, transform: fitTransform(doc, t.width, t.height, true) }));
          }}
        >
          Fill canvas
        </button>
      </div>
      <p className="faint" style={{ fontSize: 10 }}>
        Drag corners to scale (Shift: free aspect), the round handle to rotate, Ctrl-drag a corner for perspective.
      </p>
    </>
  );
}

function CropSection({ layer }: { layer: Layer }) {
  const c = layer.crop;
  const edge = (key: keyof typeof c, label: string) => (
    <Slider
      label={label}
      value={Math.round((key === "right" || key === "bottom" ? 1 - c[key] : c[key]) * 100)}
      min={0}
      max={95}
      defaultValue={0}
      format={(v) => `${v}%`}
      onGestureStart={() => beginDocGesture("Crop layer")}
      onGestureEnd={endDocGesture}
      onChange={(v) =>
        set(layer.id, "Crop layer", (l) => {
          const next = { ...l.crop, [key]: key === "right" || key === "bottom" ? 1 - v / 100 : v / 100 };
          if (next.right - next.left < 0.02 || next.bottom - next.top < 0.02) return l;
          return { ...l, crop: next };
        })
      }
    />
  );
  return (
    <>
      <div className="subhead">Crop</div>
      {edge("left", "Left")}
      {edge("right", "Right")}
      {edge("top", "Top")}
      {edge("bottom", "Bottom")}
    </>
  );
}

function MaskSection({ layer }: { layer: Layer }) {
  const maskLayerId = useStore(composite, (s) => s.maskLayerId);
  const maskComponentId = useStore(composite, (s) => s.maskComponentId);
  const mask = layer.mask;
  if (!mask)
    return (
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn small" onClick={() => set(layer.id, "Add layer mask", (l) => ({ ...l, mask: emptyMask() }))}>
          Add layer mask
        </button>
      </div>
    );
  const add = (kind: "brush" | "linear" | "radial", operation: MaskComponent["operation"]) => {
    const component = newComponent(defaultMaskShape(kind, { x: 0.5, y: 0.5 }, 0.3, layer.transform.width / layer.transform.height), operation);
    set(layer.id, `Mask: add ${shapeLabels[kind]}`, (l) => ({ ...l, mask: { ...l.mask!, components: [...l.mask!.components, component] } }));
    composite.setState({ maskLayerId: layer.id, maskComponentId: component.id, tool: "mask" });
  };
  const editing = maskLayerId === layer.id;
  return (
    <>
      <div className="subhead">Layer Mask</div>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={mask.enabled} onChange={(e) => set(layer.id, "Toggle mask", (l) => ({ ...l, mask: { ...l.mask!, enabled: e.target.checked } }))} /> Enabled
        </label>
        <label className="check">
          <input type="checkbox" checked={mask.invert} onChange={(e) => set(layer.id, "Invert mask", (l) => ({ ...l, mask: { ...l.mask!, invert: e.target.checked } }))} /> Invert
        </label>
        <span className="spacer" />
        <button type="button" className="btn small danger" onClick={() => set(layer.id, "Delete layer mask", (l) => ({ ...l, mask: null }))}>
          Delete
        </button>
      </div>
      <Slider
        label="Density"
        value={Math.round(mask.density * 100)}
        min={0}
        max={100}
        defaultValue={100}
        format={(v) => `${v}%`}
        onGestureStart={() => beginDocGesture("Mask density")}
        onGestureEnd={endDocGesture}
        onChange={(v) => set(layer.id, "Mask density", (l) => ({ ...l, mask: { ...l.mask!, density: v / 100 } }))}
      />
      {mask.components.map((c) => (
        <div key={c.id} className="row">
          <button type="button" className="nav-item" aria-current={editing && maskComponentId === c.id} style={{ flex: 1 }} onClick={() => composite.setState({ maskLayerId: layer.id, maskComponentId: c.id, tool: "mask" })}>
            <span className="name">
              {c.operation === "subtract" ? "− " : c.operation === "intersect" ? "∩ " : "+ "}
              {c.shape.kind === "ai" ? "AI" : shapeLabels[c.shape.kind]}
            </span>
          </button>
          <button type="button" className="btn ghost small" aria-pressed={c.invert} onClick={() => set(layer.id, "Invert component", (l) => ({ ...l, mask: { ...l.mask!, components: l.mask!.components.map((x) => (x.id === c.id ? { ...x, invert: !x.invert } : x)) } }))}>
            Inv
          </button>
          <button type="button" className="btn ghost small" aria-label="Delete mask component" onClick={() => set(layer.id, "Delete mask component", (l) => ({ ...l, mask: { ...l.mask!, components: l.mask!.components.filter((x) => x.id !== c.id) } }))}>
            ✕
          </button>
        </div>
      ))}
      <div className="row wrap" style={{ marginTop: 4 }}>
        <button type="button" className="btn small" onClick={(e) => openMenu(e.clientX, e.clientY, (["brush", "linear", "radial"] as const).map((k) => ({ label: `Reveal: ${shapeLabels[k]}`, onSelect: () => add(k, "add") })))}>
          Add
        </button>
        <button type="button" className="btn small" onClick={(e) => openMenu(e.clientX, e.clientY, (["brush", "linear", "radial"] as const).map((k) => ({ label: `Hide: ${shapeLabels[k]}`, onSelect: () => add(k, "subtract") })))}>
          Subtract
        </button>
        {editing && (
          <button type="button" className="btn small" onClick={() => composite.setState({ maskLayerId: null, maskComponentId: null, tool: "move" })}>
            Done
          </button>
        )}
      </div>
      <p className="faint" style={{ fontSize: 10 }}>
        With no components the mask reveals nothing: add a brush to paint where the layer shows.
      </p>
    </>
  );
}

function stopsCss(g: Gradient) {
  const stops = g.stops.map((s) => {
    const r = parseInt(s.color.slice(1, 3), 16);
    const gg = parseInt(s.color.slice(3, 5), 16);
    const b = parseInt(s.color.slice(5, 7), 16);
    return `rgba(${r},${gg},${b},${s.opacity}) ${Math.round(s.offset * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")}), conic-gradient(#555 25%, #333 0 50%, #555 0 75%, #333 0) 0 0 / 10px 10px`;
}

function GradientSection({ layer }: { layer: Extract<Layer, { kind: "gradient" }> }) {
  const g = layer.gradient;
  const update = (label: string, patch: Partial<Gradient>) => set(layer.id, label, (l) => (l.kind === "gradient" ? { ...l, gradient: { ...l.gradient, ...patch } } : l));
  const setStop = (i: number, patch: Partial<GradientStop>) => update("Gradient stop", { stops: g.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)).sort((a, b) => a.offset - b.offset) });
  return (
    <>
      <div className="subhead">Gradient</div>
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

const fonts = [
  "Inter, system-ui, sans-serif",
  "Georgia, serif",
  "'Times New Roman', serif",
  "'Helvetica Neue', Arial, sans-serif",
  "'Courier New', monospace",
  "'Trebuchet MS', sans-serif",
  "Impact, sans-serif",
  "'Brush Script MT', cursive",
];

function TextSection({ layer }: { layer: Extract<Layer, { kind: "text" }> }) {
  const s = layer.style;
  const update = (label: string, patch: Partial<TextStyle>) => set(layer.id, label, (l) => (l.kind === "text" ? { ...l, style: { ...l.style, ...patch } } : l));
  return (
    <>
      <div className="subhead">Text</div>
      <textarea className="input" rows={3} value={s.text} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => update("Edit text", { text: e.target.value })} aria-label="Text" style={{ width: "100%" }} />
      <select className="input" value={s.font} onChange={(e) => update("Font", { font: e.target.value })} aria-label="Font" style={{ width: "100%", margin: "6px 0" }}>
        {fonts.map((f) => (
          <option key={f} value={f}>
            {f.split(",")[0].replace(/'/g, "")}
          </option>
        ))}
      </select>
      <div className="row">
        <input type="color" value={s.color} aria-label="Text color" onChange={(e) => update("Text color", { color: e.target.value })} />
        <select className="input" value={s.weight} aria-label="Weight" onChange={(e) => update("Font weight", { weight: Number(e.target.value) })}>
          {[300, 400, 500, 600, 700, 800, 900].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <button type="button" className="btn small" aria-pressed={s.italic} onClick={() => update("Italic", { italic: !s.italic })}>
          <i>I</i>
        </button>
        <div className="segmented">
          {(["left", "center", "right"] as const).map((a) => (
            <button key={a} type="button" aria-pressed={s.align === a} onClick={() => update("Align text", { align: a })}>
              {a === "left" ? "⇤" : a === "center" ? "↔" : "⇥"}
            </button>
          ))}
        </div>
      </div>
      <Slider label="Size" value={s.size} min={4} max={1000} defaultValue={96} format={(v) => `${v}px`} onGestureStart={() => beginDocGesture("Font size")} onGestureEnd={endDocGesture} onChange={(v) => update("Font size", { size: v })} />
      <Slider label="Line height" value={Math.round(s.lineHeight * 100)} min={60} max={300} defaultValue={115} format={(v) => `${v}%`} onGestureStart={() => beginDocGesture("Line height")} onGestureEnd={endDocGesture} onChange={(v) => update("Line height", { lineHeight: v / 100 })} />
      <Slider label="Tracking" value={Math.round(s.letterSpacing * 1000)} min={-100} max={500} defaultValue={0} onGestureStart={() => beginDocGesture("Tracking")} onGestureEnd={endDocGesture} onChange={(v) => update("Tracking", { letterSpacing: v / 1000 })} />
    </>
  );
}

function ShapeSection({ layer }: { layer: Extract<Layer, { kind: "shape" }> }) {
  const s = layer.style;
  const update = (label: string, patch: Partial<ShapeStyle>) => set(layer.id, label, (l) => (l.kind === "shape" ? { ...l, style: { ...l.style, ...patch } } : l));
  return (
    <>
      <div className="subhead">Shape</div>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="segmented">
          <button type="button" aria-pressed={s.shape === "rectangle"} onClick={() => update("Rectangle", { shape: "rectangle" })}>
            Rectangle
          </button>
          <button type="button" aria-pressed={s.shape === "ellipse"} onClick={() => update("Ellipse", { shape: "ellipse" })}>
            Ellipse
          </button>
        </div>
      </div>
      <div className="row">
        Fill <input type="color" value={s.fill} aria-label="Fill color" onChange={(e) => update("Fill color", { fill: e.target.value })} />
        Stroke <input type="color" value={s.stroke} aria-label="Stroke color" onChange={(e) => update("Stroke color", { stroke: e.target.value })} />
      </div>
      <Slider label="Fill alpha" value={Math.round(s.fillOpacity * 100)} min={0} max={100} defaultValue={100} format={(v) => `${v}%`} onGestureStart={() => beginDocGesture("Shape fill")} onGestureEnd={endDocGesture} onChange={(v) => update("Shape fill", { fillOpacity: v / 100 })} />
      <Slider label="Stroke" value={s.strokeWidth} min={0} max={200} defaultValue={0} format={(v) => `${v}px`} onGestureStart={() => beginDocGesture("Stroke width")} onGestureEnd={endDocGesture} onChange={(v) => update("Stroke width", { strokeWidth: v })} />
      {s.shape === "rectangle" && (
        <Slider label="Corners" value={s.radius} min={0} max={1000} defaultValue={0} format={(v) => `${v}px`} onGestureStart={() => beginDocGesture("Corner radius")} onGestureEnd={endDocGesture} onChange={(v) => update("Corner radius", { radius: v })} />
      )}
    </>
  );
}

const lookKeys: (keyof Basic)[] = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation"];

function AdjustmentSection({ layer }: { layer: Extract<Layer, { kind: "adjustment" }> }) {
  const a = layer.adjustment;
  return (
    <>
      <div className="subhead">Adjustment</div>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="segmented">
          <button type="button" aria-pressed={a.profile === "color"} onClick={() => set(layer.id, "Adjustment: color", (l) => (l.kind === "adjustment" ? { ...l, adjustment: { ...l.adjustment, profile: "color" } } : l))}>
            Color
          </button>
          <button type="button" aria-pressed={a.profile === "monochrome"} onClick={() => set(layer.id, "Adjustment: B&W", (l) => (l.kind === "adjustment" ? { ...l, adjustment: { ...l.adjustment, profile: "monochrome" } } : l))}>
            B&W
          </button>
        </div>
      </div>
      {lookKeys.map((k) => {
        const r = basicRanges[k];
        return (
          <Slider
            key={k}
            label={r.label}
            value={a.basic[k]}
            min={r.min}
            max={r.max}
            step={r.step}
            defaultValue={0}
            format={(v) => formatSigned(v, r.step)}
            onGestureStart={() => beginDocGesture(`Adjustment ${r.label}`)}
            onGestureEnd={endDocGesture}
            onChange={(v) => set(layer.id, `Adjustment ${r.label}`, (l) => (l.kind === "adjustment" ? { ...l, adjustment: { ...l.adjustment, basic: { ...l.adjustment.basic, [k]: v } } } : l))}
          />
        );
      })}
      <p className="faint" style={{ fontSize: 10 }}>
        Affects every layer below it. Clip it (right-click → Create Clipping Mask) to affect only the layer beneath.
      </p>
    </>
  );
}

function EffectSection({ layer }: { layer: Extract<Layer, { kind: "effect" }> }) {
  return (
    <EffectParams
      effect={layer.effect}
      onParam={(key, label, value) =>
        set(layer.id, label, (l) => (l.kind === "effect" ? { ...l, effect: { ...l.effect, params: { ...l.effect.params, [key]: value } } } : l))
      }
      onGestureStart={beginDocGesture}
      onGestureEnd={endDocGesture}
      onReset={(fresh) => set(layer.id, "Reset effect", (l) => (l.kind === "effect" ? { ...l, effect: fresh } : l))}
      onChangeEffect={() => openEffectsBrowser({ mode: "replace", layerId: layer.id })}
      note="Applies to everything below it. Clip it (Ctrl+Alt+G) to affect only the layer beneath, add a mask to limit where, or change its blend mode and opacity above."
    />
  );
}

function ImageSection({ layer }: { layer: Extract<Layer, { kind: "image" }> }) {
  const asset = getAsset(layer.assetId);
  return (
    <>
      <div className="subhead">Photo</div>
      <p className="dim" style={{ margin: "0 0 6px" }}>{asset?.fileName ?? "Missing photo"}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={layer.develop === "asset"}
          onChange={(e) =>
            set(layer.id, e.target.checked ? "Follow photo settings" : "Independent settings", (l) =>
              l.kind === "image" ? { ...l, develop: e.target.checked ? "asset" : (recipeFor(l.assetId) ?? "asset") } : l,
            )
          }
        />
        Follow the photo's Develop settings
      </label>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <button
          type="button"
          className="btn small"
          disabled={layer.develop !== "asset"}
          title="Edit the photo in Develop; this layer updates"
          onClick={() => {
            selectAsset(layer.assetId);
            setWorkspace("develop");
          }}
        >
          Open in Develop
        </button>
        <button
          type="button"
          className="btn small"
          title="Cut out the subject (AI, on this device)"
          onClick={async () => {
            if (layer.develop !== "asset") {
              toast("Remove Background works on photos that follow their Develop settings.");
              return;
            }
            const recipe = recipeFor(layer.assetId);
            const existing = recipe?.masks.find((m) => m.cutout);
            if (existing) {
              toast("This photo already has a cutout. Edit it in Develop → Masks.");
              return;
            }
            const { removeBackgroundFor } = await import("./cutout");
            await removeBackgroundFor(layer.assetId);
          }}
        >
          Remove Background
        </button>
      </div>
      {recipeFor(layer.assetId)?.masks.some((m) => m.cutout) && layer.develop === "asset" && (
        <button type="button" className="btn small ghost" style={{ marginTop: 4 }} onClick={() => {
          const r = recipeFor(layer.assetId);
          if (r) setRecipeFor(layer.assetId, setCutout(r, null), "Restore background");
        }}>
          Restore background
        </button>
      )}
    </>
  );
}

export function PropertiesPanel() {
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  if (!doc) return null;
  const layer = selection.length ? (locate(doc.layers, selection[selection.length - 1])?.layer ?? null) : null;
  if (!layer)
    return (
      <Panel id="cmp-props" title="Properties">
        <p className="faint">Select a layer.</p>
      </Panel>
    );
  const hasTransform = layer.kind !== "fill" && layer.kind !== "adjustment" && layer.kind !== "effect" && layer.kind !== "group";
  return (
    <Panel id="cmp-props" title={`Properties · ${layer.name}`}>
      {layer.kind === "image" && <ImageSection layer={layer} />}
      {layer.kind === "gradient" && <GradientSection layer={layer} />}
      {layer.kind === "text" && <TextSection layer={layer} />}
      {layer.kind === "shape" && <ShapeSection layer={layer} />}
      {layer.kind === "adjustment" && <AdjustmentSection layer={layer} />}
      {layer.kind === "effect" && <EffectSection layer={layer} />}
      {layer.kind === "fill" && (
        <div className="row" style={{ marginBottom: 6 }}>
          Color <input type="color" value={layer.color} aria-label="Fill color" onChange={(e) => set(layer.id, "Fill color", (l) => (l.kind === "fill" ? { ...l, color: e.target.value } : l))} />
        </div>
      )}
      {hasTransform && <TransformSection layer={layer} />}
      {hasTransform && <CropSection layer={layer} />}
      <MaskSection layer={layer} />
    </Panel>
  );
}
