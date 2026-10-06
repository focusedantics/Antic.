import { useStore } from "@/app/hooks";
import { ui } from "@/app/state";
import { openMenu } from "@/components/Menu";
import { Slider } from "@/components/Slider";
import { getAsset } from "@/core/catalog/store";
import type { GlowStyle, Gradient, Layer, LayerFx, OutlineStyle, PathLayer, PathStyle, ShadowStyle, SlotLayer, SmartShape, TextLayer, TextStyle } from "@/core/document/model";
import { defaultGradient, toEditablePath } from "@/core/document/operations";
import { SMART_SHAPES, smartShape } from "@/core/document/shapes";
import { beginDocGesture, composite, endDocGesture } from "@/core/document/session";
import { curveSag, fontShorthand, shownText } from "@/core/text/draw";
import { fillSlot, importPhotosFromDevice, replaceImage } from "./actions";
import { GradientEditor, set } from "./fields";

/** A slider that is one undoable step per drag. */
function Gesture({ label, history, value, min, max, step, def, format, onChange }: { label: string; history?: string; value: number; min: number; max: number; step?: number; def: number; format?: (v: number) => string; onChange: (v: number) => void }) {
  const name = history ?? label;
  return <Slider label={label} value={value} min={min} max={max} step={step} defaultValue={def} format={format} onGestureStart={() => beginDocGesture(name)} onGestureEnd={endDocGesture} onChange={onChange} />;
}

const pct = (v: number) => `${v}%`;
const px = (v: number) => `${v}px`;
/** A size relative to the canvas, for defaults that look right at any canvas size. */
const docUnit = () => {
  const d = composite.getState().doc;
  return d ? Math.min(d.width, d.height) / 100 : 10;
};

// ─── Smart shapes and paths ──────────────────────────────────────────────────

function ShapeParams({ shape, onChange }: { shape: SmartShape; onChange: (label: string, patch: Partial<SmartShape>) => void }) {
  const info = SMART_SHAPES.find((s) => s.kind === shape.kind);
  return (
    <>
      {info?.points && <Gesture label={shape.kind === "polygon" ? "Sides" : shape.kind === "cloud" ? "Puffs" : "Points"} value={shape.points} min={info.points[0]} max={info.points[1]} def={info.defaults.points} onChange={(v) => onChange("Shape points", { points: v })} />}
      {info?.ratio && <Gesture label={info.ratio} value={Math.round(shape.ratio * 100)} min={2} max={98} def={Math.round(info.defaults.ratio * 100)} format={pct} onChange={(v) => onChange("Shape proportions", { ratio: v / 100 })} />}
      {shape.kind !== "ellipse" && shape.kind !== "line" && shape.kind !== "heart" && shape.kind !== "teardrop" && shape.kind !== "ring" && shape.kind !== "crescent" && shape.kind !== "cloud" && (
        <Gesture label="Rounding" value={Math.round(shape.round * 100)} min={0} max={100} def={Math.round((info?.defaults.round ?? 0) * 100)} format={pct} onChange={(v) => onChange("Corner rounding", { round: v / 100 })} />
      )}
    </>
  );
}

function ShapeKindSelect({ shape, onChange, label = "Shape" }: { shape: SmartShape; onChange: (s: SmartShape) => void; label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="input" value={shape.kind} onChange={(e) => onChange({ ...smartShape(e.target.value as SmartShape["kind"]), round: shape.round })}>
        {SMART_SHAPES.filter((s) => s.kind !== "line" || label === "Shape").map((s) => (
          <option key={s.kind} value={s.kind}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const DASHES: { id: string; label: string; dash: number[] }[] = [
  { id: "solid", label: "Solid", dash: [] },
  { id: "dash", label: "Dashed", dash: [3, 2] },
  { id: "dot", label: "Dotted", dash: [0.01, 2] },
  { id: "long", label: "Long dash", dash: [6, 2.5] },
];

export function PathSection({ layer }: { layer: PathLayer }) {
  const s = layer.style;
  const update = (label: string, patch: Partial<PathStyle>) => set(layer.id, label, (l) => (l.kind === "path" ? { ...l, style: { ...l.style, ...patch } } : l));
  const setShape = (label: string, shape: SmartShape) => set(layer.id, label, (l) => (l.kind === "path" ? { ...l, shape, name: l.name === SMART_SHAPES.find((x) => x.kind === l.shape?.kind)?.label ? SMART_SHAPES.find((x) => x.kind === shape.kind)!.label : l.name } : l));
  const dashId = DASHES.find((d) => d.dash.join() === s.dash.join())?.id ?? "dash";
  return (
    <>
      <div className="subhead">{layer.shape ? "Shape" : "Path"}</div>
      {layer.shape ? (
        <>
          <ShapeKindSelect shape={layer.shape} onChange={(shape) => setShape("Change shape", shape)} />
          <ShapeParams shape={layer.shape} onChange={(label, patch) => layer.shape && setShape(label, { ...layer.shape, ...patch })} />
          <button type="button" className="btn small" style={{ marginTop: 4 }} title="Turn the shape into points you can move with the pen tool" onClick={() => set(layer.id, "Convert to path", (l) => (l.kind === "path" ? toEditablePath(l) : l))}>
            Convert to editable path
          </button>
        </>
      ) : (
        <p className="faint" style={{ margin: "0 0 6px" }}>
          {layer.paths.reduce((n, p) => n + p.nodes.length, 0)} points in {layer.paths.length} path{layer.paths.length === 1 ? "" : "s"}.
        </p>
      )}

      <div className="subhead">Fill</div>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={s.fill !== null} onChange={(e) => update(e.target.checked ? "Fill on" : "Fill off", { fill: e.target.checked ? "#d9a441" : null })} /> Fill
        </label>
        {s.fill !== null && (
          <>
            <input type="color" value={s.fill} aria-label="Fill colour" onChange={(e) => update("Fill colour", { fill: e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={!!s.fillGradient} onChange={(e) => update("Fill gradient", { fillGradient: e.target.checked ? { ...defaultGradient, stops: [{ offset: 0, color: s.fill ?? "#d9a441", opacity: 1 }, { offset: 1, color: "#e0457b", opacity: 1 }] } : undefined })} /> Gradient
            </label>
          </>
        )}
      </div>
      {s.fill !== null && (
        <>
          <Gesture label="Opacity" history="Fill opacity" value={Math.round(s.fillOpacity * 100)} min={0} max={100} def={100} format={pct} onChange={(v) => update("Fill opacity", { fillOpacity: v / 100 })} />
          {s.fillGradient && <GradientEditor title={null} gradient={s.fillGradient} onChange={(label, patch) => update(label, { fillGradient: { ...s.fillGradient!, ...patch } })} />}
        </>
      )}
      {!layer.shape && (
        <label className="check">
          <input type="checkbox" checked={s.fillRule === "evenodd"} onChange={(e) => update("Fill rule", { fillRule: e.target.checked ? "evenodd" : "nonzero" })} /> Overlaps make holes
        </label>
      )}

      <div className="subhead">Stroke</div>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={s.stroke !== null && s.strokeWidth > 0} onChange={(e) => update(e.target.checked ? "Stroke on" : "Stroke off", e.target.checked ? { stroke: s.stroke ?? "#111111", strokeWidth: s.strokeWidth || Math.max(1, Math.round(docUnit())) } : { stroke: null })} /> Stroke
        </label>
        {s.stroke !== null && s.strokeWidth > 0 && (
          <>
            <input type="color" value={s.stroke} aria-label="Stroke colour" onChange={(e) => update("Stroke colour", { stroke: e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={!!s.strokeGradient} onChange={(e) => update("Stroke gradient", { strokeGradient: e.target.checked ? { ...defaultGradient, stops: [{ offset: 0, color: s.stroke ?? "#111111", opacity: 1 }, { offset: 1, color: "#3dd6ff", opacity: 1 }] } : undefined })} /> Gradient
            </label>
          </>
        )}
      </div>
      {s.stroke !== null && s.strokeWidth > 0 && (
        <>
          <Gesture label="Width" history="Stroke width" value={s.strokeWidth} min={1} max={Math.max(200, Math.round(docUnit() * 20))} def={Math.max(1, Math.round(docUnit()))} format={px} onChange={(v) => update("Stroke width", { strokeWidth: v })} />
          <Gesture label="Opacity" history="Stroke opacity" value={Math.round(s.strokeOpacity * 100)} min={0} max={100} def={100} format={pct} onChange={(v) => update("Stroke opacity", { strokeOpacity: v / 100 })} />
          {s.strokeGradient && <GradientEditor title={null} gradient={s.strokeGradient} onChange={(label, patch) => update(label, { strokeGradient: { ...s.strokeGradient!, ...patch } })} />}
          <div className="row wrap" style={{ marginTop: 4 }}>
            <select className="input" aria-label="Line style" value={dashId} onChange={(e) => update("Line style", { dash: DASHES.find((d) => d.id === e.target.value)!.dash, ...(e.target.value === "dot" ? { cap: "round" as const } : {}) })}>
              {DASHES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <select className="input" aria-label="Line ends" value={s.cap} onChange={(e) => update("Line ends", { cap: e.target.value as PathStyle["cap"] })}>
              <option value="round">Round ends</option>
              <option value="butt">Flat ends</option>
              <option value="square">Square ends</option>
            </select>
            <select className="input" aria-label="Corners" value={s.join} onChange={(e) => update("Line corners", { join: e.target.value as PathStyle["join"] })}>
              <option value="round">Round corners</option>
              <option value="miter">Sharp corners</option>
              <option value="bevel">Bevelled corners</option>
            </select>
          </div>
        </>
      )}
    </>
  );
}

// ─── Photo frames ────────────────────────────────────────────────────────────

/** Opens a menu at the button to pick a photo from this device or the Library selection. */
function pickPhoto(e: React.MouseEvent<HTMLElement>, onPick: (assetId: string) => void) {
  const r = e.currentTarget.getBoundingClientRect();
  const selected = [...ui.getState().selection];
  openMenu(r.left, r.bottom + 4, [
    {
      label: "From this device…",
      onSelect: async () => {
        const [id] = await importPhotosFromDevice(false);
        if (id) onPick(id);
      },
    },
    { label: selected.length ? "Library selection" : "Library selection (select a photo first)", disabled: !selected.length, onSelect: () => onPick(selected[0]) },
  ]);
}

export function SlotSection({ layer }: { layer: SlotLayer }) {
  const fit = layer.fit;
  const setFit = (label: string, patch: Partial<SlotLayer["fit"]>) => set(layer.id, label, (l) => (l.kind === "slot" ? { ...l, fit: { ...l.fit, ...patch } } : l));
  const setFrame = (label: string, frame: SmartShape) => set(layer.id, label, (l) => (l.kind === "slot" ? { ...l, frame } : l));
  const asset = layer.assetId ? getAsset(layer.assetId) : null;
  return (
    <>
      <div className="subhead">Photo frame</div>
      <p className="dim" style={{ margin: "0 0 6px" }}>{layer.assetId ? (asset?.fileName ?? "Missing photo") : "Empty: add a photo to fill it."}</p>
      <div className="row wrap">
        <button type="button" className="btn small primary" onClick={(e) => pickPhoto(e, (id) => fillSlot(layer.id, id))}>
          {layer.assetId ? "Replace photo…" : "Add photo…"}
        </button>
        {layer.assetId && (
          <button type="button" className="btn small" onClick={() => set(layer.id, "Empty frame", (l) => (l.kind === "slot" ? { ...l, assetId: null, fit: { zoom: 1, x: 0, y: 0 } } : l))}>
            Remove photo
          </button>
        )}
      </div>
      {layer.assetId && (
        <>
          <Gesture label="Zoom" history="Photo zoom" value={Math.round(fit.zoom * 100)} min={100} max={800} def={100} format={pct} onChange={(v) => setFit("Photo zoom", { zoom: v / 100 })} />
          <Gesture label="Left ↔ right" history="Move photo" value={Math.round(-fit.x * 100)} min={-100} max={100} def={0} onChange={(v) => setFit("Move photo", { x: -v / 100 })} />
          <Gesture label="Up ↕ down" history="Move photo" value={Math.round(-fit.y * 100)} min={-100} max={100} def={0} onChange={(v) => setFit("Move photo", { y: -v / 100 })} />
        </>
      )}
      <ShapeKindSelect label="Frame shape" shape={layer.frame} onChange={(frame) => setFrame("Frame shape", frame)} />
      <ShapeParams shape={layer.frame} onChange={(label, patch) => setFrame(label, { ...layer.frame, ...patch })} />
      {!layer.assetId && (
        <div className="row" style={{ marginTop: 4 }}>
          Placeholder <input type="color" value={layer.placeholder} aria-label="Placeholder colour" onChange={(e) => set(layer.id, "Placeholder colour", (l) => (l.kind === "slot" ? { ...l, placeholder: e.target.value } : l))} />
        </div>
      )}
    </>
  );
}

/** Photo layers: swap the photo, keeping the layer's place, styles, clipping and mask. */
export function ReplacePhoto({ layerId }: { layerId: string }) {
  return (
    <button type="button" className="btn small" title="Use another photo in this layer's place" onClick={(e) => pickPhoto(e, (id) => replaceImage(layerId, id))}>
      Replace photo…
    </button>
  );
}

// ─── Text extras ─────────────────────────────────────────────────────────────

const CASES: { id: TextStyle["textCase"] | "none"; label: string; title: string }[] = [
  { id: "none", label: "Aa", title: "As typed" },
  { id: "upper", label: "AA", title: "Capitals" },
  { id: "lower", label: "aa", title: "Lower case" },
  { id: "title", label: "Tt", title: "Title Case" },
];

/** Grows a text layer's box to fit its arc when the text is curved. */
function fitCurve(l: TextLayer, style: TextStyle): TextLayer {
  if (!style.curve) return { ...l, style };
  const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
  ctx.font = fontShorthand(style);
  const lines = shownText(style).split("\n");
  const widest = Math.max(...lines.map((t) => ctx.measureText(t).width + style.letterSpacing * style.size * Math.max(0, [...t].length - 1)));
  const need = curveSag(style.curve, widest) + style.size * style.lineHeight * (lines.length - 1) + style.size * 1.3;
  return { ...l, style, transform: l.transform.corners ? l.transform : { ...l.transform, height: Math.max(l.transform.height, need) } };
}

export function TextExtras({ layer }: { layer: TextLayer }) {
  const s = layer.style;
  const update = (label: string, patch: Partial<TextStyle>) =>
    set(layer.id, label, (l) => {
      if (l.kind !== "text") return l;
      const style: TextStyle = { ...l.style, ...patch };
      for (const k of Object.keys(patch) as (keyof TextStyle)[]) if (style[k] === undefined) delete (style as Record<string, unknown>)[k];
      return "curve" in patch ? fitCurve(l, style) : { ...l, style };
    });
  const unit = s.size;
  return (
    <>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <div className="segmented" role="group" aria-label="Letter case">
          {CASES.map((c) => (
            <button key={c.label} type="button" title={c.title} aria-label={c.title} aria-pressed={(s.textCase ?? "none") === c.id} onClick={() => update("Letter case", { textCase: c.id === "none" ? undefined : c.id })}>
              {c.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn small" aria-pressed={!!s.underline} title="Underline" aria-label="Underline" onClick={() => update("Underline", { underline: s.underline ? undefined : true })}>
          <u>U</u>
        </button>
        <button type="button" className="btn small" aria-pressed={!!s.strike} title="Strike through" aria-label="Strike through" onClick={() => update("Strike through", { strike: s.strike ? undefined : true })}>
          <s>S</s>
        </button>
      </div>
      <Gesture label="Curve" history="Curve text" value={Math.round((s.curve ?? 0) * 100)} min={-100} max={100} def={0} format={pct} onChange={(v) => update("Curve text", { curve: v ? v / 100 : undefined })} />
      <div className="row wrap" style={{ marginTop: 4 }}>
        <label className="check">
          <input type="checkbox" checked={!!s.gradient} onChange={(e) => update("Text gradient", { gradient: e.target.checked ? { ...defaultGradient, angle: 0, stops: [{ offset: 0, color: "#ff5f6d", opacity: 1 }, { offset: 1, color: "#ffc371", opacity: 1 }] } : undefined })} /> Gradient fill
        </label>
        <label className="check">
          <input type="checkbox" checked={!!s.highlight} onChange={(e) => update("Text highlight", { highlight: e.target.checked ? { color: s.color === "#111111" || s.color === "#000000" ? "#ffe14d" : "#111111", opacity: 1, padding: 0.18, radius: 0.12 } : undefined })} /> Highlight
        </label>
      </div>
      {s.gradient && <GradientEditor title={null} gradient={s.gradient} onChange={(label, patch: Partial<Gradient>) => update(label, { gradient: { ...s.gradient!, ...patch } })} />}
      {s.highlight && (
        <>
          <div className="row">
            Highlight <input type="color" value={s.highlight.color} aria-label="Highlight colour" onChange={(e) => update("Highlight colour", { highlight: { ...s.highlight!, color: e.target.value } })} />
          </div>
          <Gesture label="Opacity" history="Highlight opacity" value={Math.round(s.highlight.opacity * 100)} min={0} max={100} def={100} format={pct} onChange={(v) => update("Highlight opacity", { highlight: { ...s.highlight!, opacity: v / 100 } })} />
          <Gesture label="Padding" history="Highlight padding" value={Math.round(s.highlight.padding * unit)} min={0} max={Math.round(unit)} def={Math.round(unit * 0.18)} format={px} onChange={(v) => update("Highlight padding", { highlight: { ...s.highlight!, padding: v / unit } })} />
          <Gesture label="Corners" history="Highlight corners" value={Math.round(s.highlight.radius * unit)} min={0} max={Math.round(unit)} def={Math.round(unit * 0.12)} format={px} onChange={(v) => update("Highlight corners", { highlight: { ...s.highlight!, radius: v / unit } })} />
        </>
      )}
    </>
  );
}

// ─── Layer styles ────────────────────────────────────────────────────────────

const shadowDefault = (): ShadowStyle => ({ color: "#000000", opacity: 0.45, angle: 90, distance: Math.round(docUnit()), blur: Math.round(docUnit() * 2), spread: 0 });
const glowDefault = (): GlowStyle => ({ color: "#ffe680", opacity: 0.9, blur: Math.round(docUnit() * 2.5), spread: 0.1 });
const outlineDefault = (): OutlineStyle => ({ color: "#ffffff", opacity: 1, width: Math.max(1, Math.round(docUnit() * 0.8)) });

/** Drop shadow, glow and outline: on any layer that has pixels of its own. */
export function StylesSection({ layer }: { layer: Layer }) {
  const fx = layer.fx ?? {};
  const doc = useStore(composite, (s) => s.doc);
  const big = doc ? Math.max(100, Math.round(Math.min(doc.width, doc.height) / 4)) : 200;
  const update = <K extends keyof LayerFx>(label: string, key: K, value: LayerFx[K] | undefined) =>
    set(layer.id, label, (l) => {
      const next: Record<string, unknown> = { ...(l.fx ?? {}), [key]: value };
      if (value === undefined) delete next[key];
      const { fx: _old, ...rest } = l;
      return Object.keys(next).length ? ({ ...rest, fx: next as LayerFx } as Layer) : (rest as Layer);
    });
  const sh = fx.shadow;
  const gl = fx.glow;
  const ol = fx.outline;
  return (
    <>
      <div className="subhead">Styles</div>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={!!sh} onChange={(e) => update("Drop shadow", "shadow", e.target.checked ? shadowDefault() : undefined)} /> Shadow
        </label>
        <label className="check">
          <input type="checkbox" checked={!!gl} onChange={(e) => update("Glow", "glow", e.target.checked ? glowDefault() : undefined)} /> Glow
        </label>
        <label className="check">
          <input type="checkbox" checked={!!ol} onChange={(e) => update("Outline", "outline", e.target.checked ? outlineDefault() : undefined)} /> Outline
        </label>
      </div>
      {sh && (
        <div className="style-group">
          <div className="row">
            Shadow <input type="color" value={sh.color} aria-label="Shadow colour" onChange={(e) => update("Shadow colour", "shadow", { ...sh, color: e.target.value })} />
          </div>
          <Gesture label="Opacity" history="Shadow opacity" value={Math.round(sh.opacity * 100)} min={0} max={100} def={45} format={pct} onChange={(v) => update("Shadow opacity", "shadow", { ...sh, opacity: v / 100 })} />
          <Gesture label="Distance" history="Shadow distance" value={sh.distance} min={0} max={big} def={Math.round(docUnit())} format={px} onChange={(v) => update("Shadow distance", "shadow", { ...sh, distance: v })} />
          <Gesture label="Angle" history="Shadow angle" value={sh.angle} min={-180} max={180} def={90} format={(v) => `${v}°`} onChange={(v) => update("Shadow angle", "shadow", { ...sh, angle: v })} />
          <Gesture label="Blur" history="Shadow blur" value={sh.blur} min={0} max={big} def={Math.round(docUnit() * 2)} format={px} onChange={(v) => update("Shadow blur", "shadow", { ...sh, blur: v })} />
          <Gesture label="Spread" history="Shadow spread" value={Math.round(sh.spread * 100)} min={0} max={100} def={0} format={pct} onChange={(v) => update("Shadow spread", "shadow", { ...sh, spread: v / 100 })} />
        </div>
      )}
      {gl && (
        <div className="style-group">
          <div className="row">
            Glow <input type="color" value={gl.color} aria-label="Glow colour" onChange={(e) => update("Glow colour", "glow", { ...gl, color: e.target.value })} />
          </div>
          <Gesture label="Opacity" history="Glow opacity" value={Math.round(gl.opacity * 100)} min={0} max={100} def={90} format={pct} onChange={(v) => update("Glow opacity", "glow", { ...gl, opacity: v / 100 })} />
          <Gesture label="Size" history="Glow size" value={gl.blur} min={0} max={big} def={Math.round(docUnit() * 2.5)} format={px} onChange={(v) => update("Glow size", "glow", { ...gl, blur: v })} />
          <Gesture label="Spread" history="Glow spread" value={Math.round(gl.spread * 100)} min={0} max={100} def={10} format={pct} onChange={(v) => update("Glow spread", "glow", { ...gl, spread: v / 100 })} />
        </div>
      )}
      {ol && (
        <div className="style-group">
          <div className="row">
            Outline <input type="color" value={ol.color} aria-label="Outline colour" onChange={(e) => update("Outline colour", "outline", { ...ol, color: e.target.value })} />
          </div>
          <Gesture label="Width" history="Outline width" value={ol.width} min={1} max={Math.round(big / 2)} def={Math.max(1, Math.round(docUnit() * 0.8))} format={px} onChange={(v) => update("Outline width", "outline", { ...ol, width: v })} />
          <Gesture label="Opacity" history="Outline opacity" value={Math.round(ol.opacity * 100)} min={0} max={100} def={100} format={pct} onChange={(v) => update("Outline opacity", "outline", { ...ol, opacity: v / 100 })} />
        </div>
      )}
      {(sh || gl || ol) && layer.fillOpacity < 1 && <p className="faint" style={{ fontSize: 10 }}>Fill opacity fades the layer but not its styles: at 0 % only the styles show.</p>}
    </>
  );
}
