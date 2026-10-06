import { useStore } from "@/app/hooks";
import { Icon, type IconName } from "@/components/icons";
import { Panel } from "@/components/Panel";
import type { TextStyle } from "@/core/document/model";
import { insertLayer, textLayer } from "@/core/document/operations";
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
          <Tile icon="shapes" label="Rectangle" onClick={() => addLayer("rectangle")} />
          <Tile icon="shapes" label="Ellipse" onClick={() => addLayer("ellipse")} />
          <Tile icon="color" label="Colour fill" onClick={() => addLayer("fill")} />
          <Tile icon="grade" label="Gradient" onClick={() => addLayer("gradient")} />
          <Tile icon="light" label="Adjustment" onClick={() => addLayer("adjustment")} />
          <Tile icon="effects" label="Effect…" onClick={() => openEffectsBrowser()} />
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
