import { layoutCanvas, ontoWorkingSlide } from "@/features/composite/slide";
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
import { ELEMENT_GROUPS, ELEMENTS, type Element, type ElementGroup } from "./elements";
import { insertElement } from "./insert";
import { LayerSketch } from "./preview";
import { useEffect, useMemo, useState } from "react";
import { openMenu } from "@/components/Menu";
import { assetData, designAssets, type ElementData, loadDesignAssets, removeDesignAsset, updateDesignAsset } from "@/core/design/assets";
import { insertMyElement } from "./actions";

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

/** Adds a layer (laid out on one slide's canvas) on the slide being worked on, above the selection, and selects it. */
function addToDesign(laidOut: Layer, label: string) {
  const { doc, selection } = composite.getState();
  if (!doc) return;
  const layer = ontoWorkingSlide(doc, laidOut);
  editDocument(label, (d) => insertLayer(d, layer, selection.at(-1)));
  composite.setState({ selection: [layer.id], tool: "move" });
}

/** A palette of shape colours that read on light and dark designs. */
const SHAPE_COLORS = ["#d9a441", "#e0457b", "#3d8bfd", "#2fbf71", "#8b5cf6", "#ff7a45"];
let shapeCount = 0;

export function addSmartShape(kind: SmartShapeKind) {
  const doc = composite.getState().doc;
  if (!doc) return;
  const layer = pathLayer(layoutCanvas(doc), smartShape(kind), kind === "line" ? { stroke: readableOn(doc.background) } : { fill: SHAPE_COLORS[shapeCount++ % SHAPE_COLORS.length] });
  addToDesign(layer, `Add ${layer.name.toLowerCase()}`);
}

export function addPhotoFrame(kind: SmartShapeKind = "rectangle") {
  const doc = composite.getState().doc;
  if (!doc) return;
  addToDesign(slotLayer(layoutCanvas(doc), smartShape(kind)), "Add photo frame");
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
  // Sized for one slide of a carousel, and placed on the slide being worked on.
  const canvas = layoutCanvas(doc);
  const made = textLayer(canvas, { color: readableOn(doc.background), ...preset.style, size: Math.round(Math.min(canvas.width, canvas.height) * preset.size) });
  const layer = ontoWorkingSlide(doc, { ...made, transform: { ...made.transform, y: Math.round(doc.height * TEXT_ROWS[texts % TEXT_ROWS.length]) } });
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

/** Element previews, built once (a square sketch canvas). */
const sketches = new Map<string, React.ReactNode>();
function ElementSketch({ element }: { element: Element }) {
  let node = sketches.get(element.id);
  if (!node) {
    const doc = { width: 600, height: 600 };
    node = <LayerSketch className="element-sketch" width={600} height={600} layers={[element.make(doc, "#e8e8e8", 0.92)]} />;
    sketches.set(element.id, node);
  }
  return node;
}

export function addElement(element: Element) {
  const doc = composite.getState().doc;
  if (!doc) return;
  void insertElement(element.make(layoutCanvas(doc), readableOn(doc.background)), `Add ${element.label.toLowerCase()}`);
}

function ElementGrid({ group }: { group: ElementGroup }) {
  return (
    <div className="element-grid">
      {ELEMENTS.filter((e) => e.group === group).map((e) => (
        <button key={e.id} type="button" className="element-tile" title={e.label} aria-label={`Add ${e.label.toLowerCase()}`} onClick={() => addElement(e)}>
          <ElementSketch element={e} />
        </button>
      ))}
    </div>
  );
}

/** My saved elements, sketched from their layers. */
function MyElements() {
  const items = useStore(designAssets, (s) => s.items);
  const mine = useMemo(() => items.filter((a) => a.kind === "element"), [items]);
  if (!mine.length) return <p className="faint">Select layers in a design, then More → Save selection as element.</p>;
  return (
    <div className="element-grid">
      {mine.map((a) => {
        const data = assetData(a) as ElementData | null;
        if (!data) return null;
        return (
          <div key={a.id} className="element-mine">
            <button type="button" className="element-tile" title={a.folder ? `${a.name} (${a.folder})` : a.name} aria-label={`Add ${a.name}`} onClick={() => void insertMyElement(a)}>
              <LayerSketch className="element-sketch" width={data.width} height={data.height} layers={data.layers} />
            </button>
            <button
              type="button"
              className="btn ghost small element-more"
              aria-label={`More for ${a.name}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openMenu(r.left, r.bottom + 4, [
                  {
                    label: "Rename…",
                    onSelect: () => {
                      const name = prompt("Element name", a.name);
                      if (name) void updateDesignAsset(a.id, { name });
                    },
                  },
                  {
                    label: "Move to folder…",
                    onSelect: () => {
                      const folder = prompt("Folder (empty for none; use / for subfolders)", a.folder);
                      if (folder !== null) void updateDesignAsset(a.id, { folder });
                    },
                  },
                  "separator",
                  { label: "Delete…", onSelect: () => confirm(`Delete the element “${a.name}”?`) && void removeDesignAsset(a.id) },
                ]);
              }}
            >
              ⋯
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Badges, doodles, decorations and photo frames (text combinations are with the text), and mine. */
function ElementsPanel() {
  const groups = [...ELEMENT_GROUPS.filter((g) => g !== "Text"), "Mine"] as const;
  const [group, setGroup] = useState<(typeof groups)[number]>(groups[0]);
  useEffect(() => {
    void loadDesignAssets();
  }, []);
  return (
    <Panel id="design-elements" title="Elements">
      <div className="chip-row" role="group" aria-label="Element groups">
        {groups.map((g) => (
          <button key={g} type="button" className="filter-chip" aria-pressed={group === g} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      {group === "Mine" ? <MyElements /> : <ElementGrid group={group} />}
    </Panel>
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
      <ElementsPanel />
      <Panel id="design-text" title="Text">
        <div className="text-styles">
          {TEXT_STYLES.map((t) => (
            <button key={t.id} type="button" className="text-style" onClick={() => addTextStyle(t.id)} style={{ fontFamily: t.style.font, fontWeight: t.style.weight, fontStyle: t.style.italic ? "italic" : undefined, color: t.style.color }}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="subhead">Combinations</div>
        <ElementGrid group="Text" />
      </Panel>
    </>
  );
}
