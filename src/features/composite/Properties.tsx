import { useStore } from "@/app/hooks";
import { selectAsset, setWorkspace, toast } from "@/app/state";
import { cutoutRun } from "@/components/cutoutFx";
import { openMenu } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { formatSigned, Slider } from "@/components/Slider";
import { getAsset } from "@/core/catalog/store";
import { basicRanges } from "@/core/develop/params";
import { defaultShape as defaultMaskShape, newComponent, setCutout, shapeLabels } from "@/core/develop/masks";
import type { Basic, MaskComponent } from "@/core/develop/recipe";
import { ANIMATION_LIMITS, DEFAULT_ANIMATION, docAnimation } from "@/core/document/animation";
import type { DocAnimation, Layer, ShapeStyle, TextMotionKind, TextStyle, Transform } from "@/core/document/model";
import { FONT_GROUPS, FONTS, fontLabel } from "@/core/text/fonts";
import { effectById } from "@/core/effects/registry";
import { emptyMask, fitTransform, locate, TEXT_MOTIONS } from "@/core/document/operations";
import { beginDocGesture, composite, editDocument, endDocGesture } from "@/core/document/session";
import { recipeFor, setRecipeFor } from "@/core/develop/session";
import { GradientEditor, Num, set } from "./fields";
import { PathSection, ReplacePhoto, SlotSection, StylesSection, TextExtras } from "./StyleSections";
import { EffectParams } from "@/features/effects/EffectParams";
import { openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { brush } from "@/features/develop/masks/brush";


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
  const active = mask.components.find((c) => c.id === maskComponentId) ?? null;
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
      {editing && active && <MaskToolControls layer={layer} component={active} />}
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

/**
 * Controls for the mask part being edited: the brush (paint/erase, size,
 * feather, flow, density; tool settings shared with Develop) or a radial
 * gradient's size and feather (stored in the mask).
 */
function MaskToolControls({ layer, component }: { layer: Layer; component: MaskComponent }) {
  const b = useStore(brush, (st) => st);
  const doc = useStore(composite, (st) => st.doc);
  const shape = component.shape;
  const setShape = (label: string, next: MaskComponent["shape"]) =>
    set(layer.id, label, (l) => ({ ...l, mask: l.mask ? { ...l.mask, components: l.mask.components.map((c) => (c.id === component.id ? { ...c, shape: next } : c)) } : null }));
  if (shape.kind === "brush") {
    const docLong = doc ? Math.max(doc.width, doc.height) : 1000;
    return (
      <div className="mask-tool" data-testid="mask-brush">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
          <div className="segmented" role="group" aria-label="Brush mode">
            <button type="button" aria-pressed={!b.erase} onClick={() => brush.setState({ erase: false })}>
              Paint
            </button>
            <button type="button" aria-pressed={b.erase} title="Erase (hold Alt)" onClick={() => brush.setState({ erase: true })}>
              Erase
            </button>
          </div>
          <button type="button" className="btn small" disabled={!shape.strokes.length} onClick={() => setShape("Clear brush", { kind: "brush", strokes: [] })}>
            Clear
          </button>
        </div>
        <Slider
          label="Size"
          value={Math.max(1, Math.round(b.size * docLong))}
          min={1}
          max={Math.round(docLong * 0.4)}
          defaultValue={Math.round(docLong * 0.06)}
          format={(v) => `${v}px`}
          onChange={(v) => brush.setState({ size: Math.max(0.0005, v / docLong) })}
        />
        <Slider label="Feather" value={Math.round(b.feather * 100)} min={0} max={100} defaultValue={60} format={(v) => `${v}%`} onChange={(v) => brush.setState({ feather: v / 100 })} />
        <Slider label="Flow" value={Math.round(b.flow * 100)} min={1} max={100} defaultValue={80} format={(v) => `${v}%`} onChange={(v) => brush.setState({ flow: v / 100 })} />
        <Slider label="Density" value={Math.round(b.density * 100)} min={1} max={100} defaultValue={100} format={(v) => `${v}%`} onChange={(v) => brush.setState({ density: v / 100 })} />
        <p className="faint" style={{ fontSize: 10, margin: "2px 0 0" }}>
          Paint on the canvas. [ and ] change the size, Alt erases. Size and feather apply to new strokes.
        </p>
      </div>
    );
  }
  if (shape.kind === "radial") {
    const size = Math.round(Math.max(shape.radiusX, shape.radiusY) * 100);
    return (
      <div className="mask-tool" data-testid="mask-radial">
        <Slider
          label="Size"
          value={size}
          min={1}
          max={300}
          defaultValue={size}
          format={(v) => `${v}%`}
          onGestureStart={() => beginDocGesture("Mask size")}
          onGestureEnd={endDocGesture}
          onChange={(v) => {
            const k = v / Math.max(1, size);
            setShape("Mask size", { ...shape, radiusX: Math.max(0.005, shape.radiusX * k), radiusY: Math.max(0.005, shape.radiusY * k) });
          }}
        />
        <Slider label="Feather" value={shape.feather} min={0} max={100} defaultValue={50} format={(v) => `${v}%`} onGestureStart={() => beginDocGesture("Mask feather")} onGestureEnd={endDocGesture} onChange={(v) => setShape("Mask feather", { ...shape, feather: v })} />
        <p className="faint" style={{ fontSize: 10, margin: "2px 0 0" }}>
          Drag on the canvas to place it.
        </p>
      </div>
    );
  }
  if (shape.kind === "linear")
    return (
      <p className="faint mask-tool" style={{ fontSize: 10 }}>
        Drag on the canvas: full at the start of the drag, fading to nothing at the end. A longer drag gives a softer edge.
      </p>
    );
  return null;
}

function GradientSection({ layer }: { layer: Extract<Layer, { kind: "gradient" }> }) {
  return <GradientEditor gradient={layer.gradient} onChange={(label, patch) => set(layer.id, label, (l) => (l.kind === "gradient" ? { ...l, gradient: { ...l.gradient, ...patch } } : l))} />;
}

function TextSection({ layer }: { layer: Extract<Layer, { kind: "text" }> }) {
  const s = layer.style;
  const motion = s.motion && s.motion.kind !== "none" ? s.motion : null;
  const update = (label: string, patch: Partial<TextStyle>) =>
    set(layer.id, label, (l) => {
      if (l.kind !== "text") return l;
      const style = { ...l.style, ...patch };
      if (!style.motion) delete (style as { motion?: unknown }).motion;
      return { ...l, style };
    });
  return (
    <>
      <div className="subhead">Text</div>
      <textarea className="input" rows={3} value={s.text} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => update("Edit text", { text: e.target.value })} aria-label="Text" style={{ width: "100%" }} />
      <select className="input" value={s.font} onChange={(e) => update("Font", { font: e.target.value })} aria-label="Font" style={{ width: "100%", margin: "6px 0", fontFamily: s.font }}>
        {!FONTS.some((f) => f.css === s.font) && <option value={s.font}>{fontLabel(s.font)}</option>}
        {FONT_GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {FONTS.filter((f) => f.group === group).map((f) => (
              <option key={f.css} value={f.css} style={{ fontFamily: f.css }}>
                {f.label}
              </option>
            ))}
          </optgroup>
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
      <label className="field" style={{ marginTop: 8 }}>
        <span>Animation</span>
        <select
          className="input"
          value={motion?.kind ?? "none"}
          onChange={(e) => {
            const kind = e.target.value as TextMotionKind;
            update("Text animation", { motion: kind === "none" ? undefined : { kind, speed: motion?.speed ?? 1, amount: motion?.amount ?? 0.5 } });
          }}
        >
          {TEXT_MOTIONS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {motion && (
        <>
          <Slider
            label="Strength"
            value={Math.round(motion.amount * 100)}
            min={0}
            max={100}
            defaultValue={50}
            format={(v) => `${v}%`}
            onGestureStart={() => beginDocGesture("Animation strength")}
            onGestureEnd={endDocGesture}
            onChange={(v) => update("Animation strength", { motion: { ...motion, amount: v / 100 } })}
          />
          {TEXT_MOTIONS.find((m) => m.id === motion.kind)?.repeats && (
            <Slider
              label="Speed"
              value={motion.speed}
              min={1}
              max={4}
              defaultValue={1}
              format={(v) => `${v}× per loop`}
              onGestureStart={() => beginDocGesture("Animation speed")}
              onGestureEnd={endDocGesture}
              onChange={(v) => update("Animation speed", { motion: { ...motion, speed: v } })}
            />
          )}
          <LoopSection />
        </>
      )}
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

/** Document-wide loop settings, shown on animated effect layers. */
function LoopSection() {
  const doc = useStore(composite, (s) => s.doc);
  const playing = useStore(composite, (s) => s.playing);
  if (!doc) return null;
  const animation = docAnimation(doc);
  const setAnimation = (label: string, change: Partial<DocAnimation>) => editDocument(label, (d) => ({ ...d, animation: { ...docAnimation(d), ...change } }));
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <strong>Loop</strong>
        <button type="button" className="btn small" aria-pressed={playing} onClick={() => composite.setState({ playing: !playing })}>
          {playing ? "Pause" : "Play"}
        </button>
      </div>
      <Slider
        label="Loop length"
        value={animation.duration}
        min={ANIMATION_LIMITS.duration[0]}
        max={ANIMATION_LIMITS.duration[1]}
        step={0.5}
        defaultValue={DEFAULT_ANIMATION.duration}
        format={(v) => `${v} s`}
        onGestureStart={() => beginDocGesture("Loop length")}
        onGestureEnd={endDocGesture}
        onChange={(v) => setAnimation("Loop length", { duration: v })}
      />
      <Slider
        label="Frame rate"
        value={animation.fps}
        min={ANIMATION_LIMITS.fps[0]}
        max={ANIMATION_LIMITS.fps[1]}
        defaultValue={DEFAULT_ANIMATION.fps}
        format={(v) => `${v} fps`}
        onGestureStart={() => beginDocGesture("Frame rate")}
        onGestureEnd={endDocGesture}
        onChange={(v) => setAnimation("Frame rate", { fps: v })}
      />
      <p className="faint" style={{ fontSize: 11 }}>Shared by every animated effect and text layer in this composition; GIF and MP4 exports use one loop.</p>
    </div>
  );
}

function EffectSection({ layer }: { layer: Extract<Layer, { kind: "effect" }> }) {
  return (
    <>
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
      {effectById(layer.effect.id)?.animated && <LoopSection />}
    </>
  );
}

function ImageSection({ layer }: { layer: Extract<Layer, { kind: "image" }> }) {
  const removing = useStore(cutoutRun, (st) => st.running);
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
        <ReplacePhoto layerId={layer.id} />
        <button
          type="button"
          className="btn small"
          title="Cut out the subject (AI, on this device)"
          disabled={removing}
          aria-busy={removing}
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
            await removeBackgroundFor(layer.assetId, layer.id);
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
      {layer.kind === "text" && <TextExtras layer={layer} />}
      {layer.kind === "shape" && <ShapeSection layer={layer} />}
      {layer.kind === "path" && <PathSection layer={layer} />}
      {layer.kind === "slot" && <SlotSection layer={layer} />}
      {layer.kind === "adjustment" && <AdjustmentSection layer={layer} />}
      {layer.kind === "effect" && <EffectSection layer={layer} />}
      {layer.kind === "fill" && (
        <div className="row" style={{ marginBottom: 6 }}>
          Color <input type="color" value={layer.color} aria-label="Fill color" onChange={(e) => set(layer.id, "Fill color", (l) => (l.kind === "fill" ? { ...l, color: e.target.value } : l))} />
        </div>
      )}
      {layer.kind !== "adjustment" && layer.kind !== "effect" && <StylesSection layer={layer} />}
      {hasTransform && <TransformSection layer={layer} />}
      {hasTransform && <CropSection layer={layer} />}
      <MaskSection layer={layer} />
    </Panel>
  );
}
