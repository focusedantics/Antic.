import { useStore } from "@/app/hooks";
import { Icon, type IconName } from "@/components/icons";
import { Panel } from "@/components/Panel";
import type { TextStyle } from "@/core/document/model";
import type { Layer, SmartShapeKind } from "@/core/document/model";
import { insertLayer, pathLayer, slotLayer, textLayer } from "@/core/document/operations";
import { pathData, SMART_SHAPES, shapePaths, smartShape } from "@/core/document/shapes";
import { composite, editDocument } from "@/core/document/session";
import { ui } from "@/app/state";
import { addLayer } from "@/features/composite/LayersPanel";
import { openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { addLibraryPhotos, addPhotosFromDevice } from "./actions";

/** Text to start from, sized to the canvas (a fraction of its short side). */
export const TEXT_STYLES: readonly { id: string; label: string; size: number; style: Partial<TextStyle> }[] = [
  { id: "heading", label: "Heading", size: 1 / 7, style: { text: "Big heading", font: "Anton, Impact, sans-serif", weight: 400, letterSpacing: 0.01 } },
  { id: "subheading", label: "Subheading", size: 1 / 16, style: { text: "A subheading", font: "Montserrat, sans-serif", weight: 700 } },
  { id: "body", label: "Body text", size: 1 / 32, style: { text: "A line of body text", font: "Inter, system-ui, sans-serif", weight: 400 } },
  { id: "display", label: "Condensed", size: 1 / 6, style: { text: "BOLD", font: "'Bebas Neue', Impact, sans-serif", weight: 400, letterSpacing: 0.04 } },
  { id: "serif", label: "Elegant serif", size: 1 / 12, style: { text: "Elegant", font: "'Playfair Display', Georgia, serif", weight: 700, italic: true } },
  { id: "script", label: "Script", size: 1 / 10, style: { text: "Hello there", font: "Pacifico, cursive", weight: 400 } },
  { id: "hand", label: "Handwritten", size: 1 / 12, style: { text: "handwritten note", font: "Caveat, cursive", weight: 700 } },
  { id: "marker", label: "Marker", size: 1 / 10, style: { text: "MARKER", font: "'Permanent Marker', cursive", weight: 400 } },
  { id: "neon", label: "Neon", size: 1 / 10, style: { text: "NEON", font: "Monoton, sans-serif", weight: 400, color: "#ff5cf0" } },
  { id: "retro", label: "Pixel", size: 1 / 18, style: { text: "PRESS START", font: "'Press Start 2P', monospace", weight: 400 } },
];

/** Adds a layer above the selection and selects it. */
function addToDesign(layer: Layer, label: string) {
  const { doc, selection } = composite.getState();
  if (!doc) return;
  editDocument(label, (d) => insertLayer(d, layer, selection.at(-1)));
  composite.setState({ selection: [layer.id], tool: "move" });
}

/** A palette of shape colours that read on light and dark designs. */
const SHAPE_COLORS = ["#d9a441", "#e0457b", "#3d8bfd", "#2fbf71", "#8b5cf6", "#ff7a45"];
let shapeCount = 0;

export function addSmartShape(kind: SmartShapeKind) {
  const doc = composite.getState().doc;
  if (!doc) return;
  const layer = pathLayer(doc, smartShape(kind), kind === "line" ? { stroke: readableOn(doc.background) } : { fill: SHAPE_COLORS[shapeCount++ % SHAPE_COLORS.length] });
  addToDesign(layer, `Add ${layer.name.toLowerCase()}`);
}

export function addPhotoFrame(kind: SmartShapeKind = "rectangle") {
  const doc = composite.getState().doc;
  if (!doc) return;
  addToDesign(slotLayer(doc, smartShape(kind)), "Add photo frame");
}

/** A shape drawn small, from the same generator the canvas uses. */
export function ShapeGlyph({ kind, size = 28 }: { kind: SmartShapeKind; size?: number }) {
  const shape = smartShape(kind);
  const aspect = kind === "arrow" || kind === "double-arrow" || kind === "cloud" ? 1.6 : kind === "speech" ? 1.3 : 1;
  const w = aspect >= 1 ? size : size * aspect;
  const h = aspect >= 1 ? size / aspect : size;
  const d = pathData(shapePaths(shape, aspect), w, h, 1.5);
  const line = kind === "line";
  return (
    <svg width={size} height={size} viewBox={`${(w - size) / 2} ${(h - size) / 2} ${size} ${size}`} aria-hidden="true">
      <path d={d} fill={line ? "none" : "currentColor"} stroke={line ? "currentColor" : "none"} strokeWidth={3} strokeLinecap="round" fillRule={kind === "ring" ? "evenodd" : "nonzero"} />
    </svg>
  );
}

/** Dark text on a light background, white on a dark one (transparent counts as light). */
export function readableOn(background: string | null): string {
  const m = /^#([0-9a-f]{6})$/i.exec(background ?? "");
  if (!m) return "#111111";
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#111111" : "#ffffff";
}

/** Where the nth new text goes, so new text doesn't land on the last one. */
const TEXT_ROWS = [0.5, 0.66, 0.34, 0.82, 0.18];

/** Adds a text layer in one of the starting styles. */
export function addTextStyle(id: string) {
  const { doc, selection } = composite.getState();
  const preset = TEXT_STYLES.find((t) => t.id === id);
  if (!doc || !preset) return;
  const texts = doc.layers.filter((l) => l.kind === "text").length;
  const made = textLayer(doc, { color: readableOn(doc.background), ...preset.style, size: Math.round(Math.min(doc.width, doc.height) * preset.size) });
  const layer = { ...made, transform: { ...made.transform, y: Math.round(doc.height * TEXT_ROWS[texts % TEXT_ROWS.length]) } };
  editDocument(`Add ${preset.label.toLowerCase()}`, (d) => insertLayer(d, layer, selection.at(-1)));
  composite.setState({ selection: [layer.id], tool: "move" });
}

function Tile({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="make-tile" onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

/** Design's left column: what can be added to the design. */
export function MakePanel() {
  const selected = useStore(ui, (s) => s.selection.size);
  return (
    <>
      <Panel id="design-add" title="Add">
        <div className="make-grid">
          <Tile icon="text" label="Text" onClick={() => addTextStyle("heading")} />
          <Tile icon="image" label="Photo from device" onClick={() => void addPhotosFromDevice()} />
          <Tile icon="folders" label={selected ? `Library (${selected})` : "Library photo"} onClick={() => void addLibraryPhotos()} />
          <Tile icon="grid" label="Photo frame" onClick={() => addPhotoFrame()} />
          <Tile icon="color" label="Colour fill" onClick={() => addLayer("fill")} />
          <Tile icon="grade" label="Gradient" onClick={() => addLayer("gradient")} />
          <Tile icon="light" label="Adjustment" onClick={() => addLayer("adjustment")} />
          <Tile icon="effects" label="Effect…" onClick={() => openEffectsBrowser()} />
        </div>
      </Panel>
      <Panel id="design-shapes" title="Shapes">
        <div className="shape-grid">
          {SMART_SHAPES.map((sh) => (
            <button key={sh.kind} type="button" className="shape-tile" title={sh.label} aria-label={`Add ${sh.label.toLowerCase()}`} onClick={() => addSmartShape(sh.kind)}>
              <ShapeGlyph kind={sh.kind} />
            </button>
          ))}
        </div>
        <div className="subhead">Photo frames</div>
        <div className="shape-grid">
          {(["rectangle", "ellipse", "heart", "star", "polygon", "cloud"] as const).map((k) => (
            <button key={k} type="button" className="shape-tile frame" title={`${SMART_SHAPES.find((x) => x.kind === k)!.label} photo frame`} aria-label={`Add ${SMART_SHAPES.find((x) => x.kind === k)!.label.toLowerCase()} photo frame`} onClick={() => addPhotoFrame(k)}>
              <ShapeGlyph kind={k} />
            </button>
          ))}
        </div>
      </Panel>
      <Panel id="design-text" title="Text styles">
        <div className="text-styles">
          {TEXT_STYLES.map((t) => (
            <button key={t.id} type="button" className="text-style" onClick={() => addTextStyle(t.id)} style={{ fontFamily: t.style.font, fontWeight: t.style.weight, fontStyle: t.style.italic ? "italic" : undefined, color: t.style.color }}>
              {t.label}
            </button>
          ))}
        </div>
      </Panel>
    </>
  );
}
