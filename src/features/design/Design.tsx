import { type ComponentType, useEffect, useMemo, useState } from "react";
import { CompactActions, type DockItem, type ShellProps, TopAction } from "@/app/Shell";
import { useStore } from "@/app/hooks";
import { layout } from "@/app/layout";
import { registerShortcuts } from "@/app/shortcuts";
import { toast } from "@/app/state";
import { Icon, type IconName } from "@/components/icons";
import { openMenu } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { getDocument } from "@/core/catalog/db";
import { isAnimated } from "@/core/document/animation";
import { openProject } from "@/core/document/project";
import { align, type Alignment } from "@/core/document/operations";
import { composite, compositeHistory, editDocument, flushDocument, isDesign } from "@/core/document/session";
import { chooseFiles, pickerAccept } from "@/lib/files";
import { CanvasPanel, compositeShortcuts, DrawingTools, setTool } from "@/features/composite/Composite";
import { addLayer, LayersPanel } from "@/features/composite/LayersPanel";
import { PropertiesPanel } from "@/features/composite/Properties";
import { ExportDocumentDialog } from "@/features/composite/ExportDocument";
import { CompositeView, zoomComposite } from "@/features/composite/View";
import { EffectsBrowserHost, openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { openLooks } from "@/features/looks/LooksDialog";
import { addPhotosFromDevice, moveToDesign, startFrom } from "./actions";
import { DesignHome } from "./Home";
import { TemplatesSection } from "./Gallery";
import { SaveAssetDialog } from "./SaveDialog";
import { moveToComposite } from "./actions";
import { addPhotoFrame, addSmartShape, addTextStyle, MakePanel } from "./MakePanel";
import { SMART_SHAPES } from "@/core/document/shapes";
import { design } from "./state";
import "@/styles/design.css";

/** The design's "more" menu: saving it or a selection for reuse, moving it to Composite. */
function moreMenu(e: React.MouseEvent<HTMLElement>, openSave: (kind: "template" | "element") => void) {
  const r = e.currentTarget.getBoundingClientRect();
  const { doc, selection } = composite.getState();
  openMenu(r.left, r.bottom + 4, [
    { label: "Save as template…", disabled: !doc, onSelect: () => openSave("template") },
    { label: "Save selection as element…", disabled: !selection.length, onSelect: () => openSave("element") },
    "separator",
    { label: "Move to Composite", disabled: !doc, onSelect: () => doc && void moveToComposite(doc.id) },
  ]);
}

/** Back to the start screen; the design stays saved. */
export function goHome() {
  void flushDocument();
  design.setState({ home: true });
}

function ToolIcon({ icon, label, onClick, pressed, disabled }: { icon: IconName; label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; pressed?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className="tool-icon" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={22} />
    </button>
  );
}

function shapeMenu(e: React.MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [
    ...SMART_SHAPES.map((s) => ({ label: s.label, onSelect: () => addSmartShape(s.kind) })),
    "separator",
    { label: "Photo frame", onSelect: () => addPhotoFrame() },
    { label: "Colour fill", onSelect: () => addLayer("fill") },
    { label: "Gradient", onSelect: () => addLayer("gradient") },
  ]);
}

function alignMenu(e: React.MouseEvent<HTMLElement>, selection: readonly string[]) {
  const r = e.currentTarget.getBoundingClientRect();
  const to = (a: Alignment) => editDocument(`Align ${a}`, (d) => align(d, selection, a));
  openMenu(
    r.left,
    r.bottom + 4,
    (["left", "center", "right", "top", "middle", "bottom"] as const).map((a) => ({ label: `Align ${a}${selection.length === 1 ? " to canvas" : ""}`, onSelect: () => to(a) })),
  );
}

/** The strip above the canvas: the things a design is made of, then view and history. */
function DesignToolbar({ onExport, onSave }: { onExport: () => void; onSave: (kind: "template" | "element") => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  const snap = useStore(composite, (s) => s.snap);
  const showGuides = useStore(composite, (s) => s.showGuides);
  const playing = useStore(composite, (s) => s.playing);
  const view = useStore(composite, (s) => s.view);
  const tool = useStore(composite, (s) => s.tool);
  const compact = useStore(layout, (s) => s.compact);
  const history = compositeHistory();
  const animated = !!doc && isAnimated(doc);
  const actions = (
    <CompactActions>
      <TopAction icon="undo" label="Undo" disabled={!history?.status().canUndo} onClick={() => history?.undo()} />
      <TopAction icon="redo" label="Redo" disabled={!history?.status().canRedo} onClick={() => history?.redo()} />
      <TopAction icon="export" label="Export" primary disabled={!doc} onClick={onExport} />
    </CompactActions>
  );
  if (compact)
    return (
      <div className="toolbar icon-toolbar" role="toolbar" aria-label="Design tools">
        <ToolIcon icon="home" label="Designs" onClick={goHome} />
        <ToolIcon icon="text" label="Add text" onClick={() => addTextStyle("heading")} />
        <ToolIcon icon="image" label="Add a photo" onClick={() => void addPhotosFromDevice()} />
        <ToolIcon icon="shapes" label="Add a shape" onClick={shapeMenu} />
        <ToolIcon icon="effects" label="Add an effect" onClick={() => openEffectsBrowser()} />
        <ToolIcon icon="pen" label="Pen" pressed={tool === "pen"} onClick={() => setTool(tool === "pen" ? "move" : "pen")} />
        <ToolIcon icon="draw" label="Draw" pressed={tool === "paint"} onClick={() => setTool(tool === "paint" ? "move" : "paint")} />
        <ToolIcon icon="align" label="Align" disabled={!selection.length} onClick={(e) => alignMenu(e, selection)} />
        <ToolIcon icon="magnet" label="Snap" pressed={snap} onClick={() => composite.setState({ snap: !snap })} />
        <ToolIcon icon="presets" label="Looks" onClick={() => openLooks({ kind: "composite" })} />
        {animated && <ToolIcon icon="animate" label={playing ? "Stop animating" : "Animate"} pressed={playing} onClick={() => composite.setState({ playing: !playing })} />}
        <ToolIcon icon="fit" label="Fit" pressed={view.fit} onClick={() => composite.setState({ view: { ...view, fit: true } })} />
        <ToolIcon icon="more" label="More" onClick={(e) => moreMenu(e, onSave)} />
        {actions}
      </div>
    );
  return (
    <div className="toolbar design-toolbar" role="toolbar" aria-label="Design tools">
      <button type="button" className="btn small" aria-label="Designs" onClick={goHome} title="All designs (the open one stays saved)">
        <Icon name="home" size={14} /> <span className="tb-label">Designs</span>
      </button>
      <span className="toolbar-sep" aria-hidden="true" />
      <div className="segmented" role="group" aria-label="Tool">
        <button type="button" aria-pressed={tool === "move"} title="Select and move (V)" onClick={() => setTool("move")}>
          Move
        </button>
        <DrawingTools />
      </div>
      <button type="button" className="btn small" aria-label="Text" onClick={() => addTextStyle("heading")} title="Add text (T)">
        <Icon name="text" size={14} /> <span className="tb-label">Text</span>
      </button>
      <button type="button" className="btn small" aria-label="Photo" onClick={() => void addPhotosFromDevice()} title="Add a photo from this device">
        <Icon name="image" size={14} /> <span className="tb-label">Photo</span>
      </button>
      <button type="button" className="btn small" aria-label="Shape" onClick={shapeMenu} title="Add a shape or a fill">
        <Icon name="shapes" size={14} /> <span className="tb-label">Shape</span>
      </button>
      <button type="button" className="btn small" aria-label="Effects" onClick={() => openEffectsBrowser()} title="Add an effect layer (Shift+E)">
        <Icon name="effects" size={14} /> <span className="tb-label">Effects</span>
      </button>
      <button type="button" className="btn small" onClick={() => openLooks({ kind: "composite" })} title="Save this design's effects as a look, or apply one">
        Looks…
      </button>
      <button type="button" className="btn small" aria-label="More" title="Save as template or element, move to Composite" onClick={(e) => moreMenu(e, onSave)}>
        <Icon name="more" size={14} />
      </button>
      <span className="toolbar-sep" aria-hidden="true" />
      <button type="button" className="btn small" disabled={!selection.length} onClick={(e) => alignMenu(e, selection)}>
        Align
      </button>
      <div className="segmented" role="group" aria-label="Snapping and guides">
        <button type="button" aria-pressed={snap} title="Snap to canvas, guides and layers (hold Alt to bypass)" onClick={() => composite.setState({ snap: !snap })}>
          Snap
        </button>
        <button type="button" aria-pressed={showGuides} title="Show guides (Ctrl+;)" onClick={() => composite.setState({ showGuides: !showGuides })}>
          Guides
        </button>
      </div>
      {animated && (
        <button type="button" className="btn small" aria-pressed={playing} title="Play animations in the canvas (exports are unaffected)" onClick={() => composite.setState({ playing: !playing })}>
          {playing ? "❚❚" : "▶"} Animate
        </button>
      )}
      <span className="spacer" />
      <div className="segmented" role="group" aria-label="Zoom">
        <button type="button" aria-pressed={view.fit} title="Fit (1)" onClick={() => composite.setState({ view: { ...view, fit: true } })}>
          Fit
        </button>
        <button type="button" aria-pressed={!view.fit && view.zoom === 1} title="100% (2)" onClick={() => zoomComposite(1)}>
          1:1
        </button>
      </div>
      <button type="button" className="btn small icon wide-only" disabled={!history?.status().canUndo} onClick={() => history?.undo()} title="Undo (Ctrl+Z)" aria-label="Undo">
        <Icon name="undo" size={14} />
      </button>
      <button type="button" className="btn small icon wide-only" disabled={!history?.status().canRedo} onClick={() => history?.redo()} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
        <Icon name="redo" size={14} />
      </button>
      <button type="button" className="btn small primary wide-only" disabled={!doc} onClick={onExport} title="Export (Ctrl+Shift+E)">
        Export…
      </button>
      {actions}
    </div>
  );
}

async function openProjectAsDesign() {
  const [file] = await chooseFiles({ accept: pickerAccept(".focused,application/zip", {}) });
  if (!file) return;
  try {
    const { document: doc, missing } = await openProject(file);
    startFrom(doc);
    if (missing.length) toast(`Opened. ${missing.length} photo(s) were not in the library or the file.`, "error");
  } catch (error) {
    toast(`Could not open the file: ${error instanceof Error ? error.message : error}`, "error");
  }
}

/** The start screen's side column: other ways in. */
function StartPanel() {
  const all = useStore(composite, (s) => s.documents);
  const compositions = useMemo(() => all.filter((d) => !d.design), [all]);
  return (
    <Panel id="design-start" title="Start">
      <div className="stack">
        <button type="button" className="btn" onClick={() => void openProjectAsDesign()}>
          Open a .focused project…
        </button>
        <button
          type="button"
          className="btn"
          disabled={!compositions.length}
          title="Bring one of your Composite documents here; it becomes a design"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(
              r.left,
              r.bottom + 4,
              compositions.map((c) => ({
                label: c.name,
                onSelect: async () => {
                  const record = await getDocument(c.id);
                  if (record) await moveToDesign(record.data as Parameters<typeof moveToDesign>[0]);
                },
              })),
            );
          }}
        >
          Bring a composition here…
        </button>
      </div>
      <p className="faint">Designs are saved on this device as you work. Export them as PNG, JPEG, WebP, GIF or MP4.</p>
    </Panel>
  );
}

const homeDock: DockItem[] = [{ id: "start", label: "Start", icon: "home", side: "left" }];
const editorDock: DockItem[] = [
  { id: "designs", label: "Designs", icon: "grid", onSelect: goHome },
  { id: "add", label: "Add", icon: "plus", side: "left" },
  { id: "layers", label: "Layers", icon: "layers", side: "right" },
  { id: "effects", label: "Effects", icon: "effects", onSelect: () => openEffectsBrowser() },
];

export default function Design({ Shell }: { Shell: ComponentType<ShellProps> }) {
  const home = useStore(design, (s) => s.home);
  const open = useStore(composite, (s) => s.doc);
  const doc = isDesign(open) ? open : null;
  const editing = !home && !!doc;
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState<"template" | "element" | null>(null);
  useEffect(() => registerShortcuts("design", (e) => {
    if (design.getState().home || !isDesign(composite.getState().doc)) return false;
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "t") {
      addTextStyle("heading");
      return true;
    }
    return compositeShortcuts(e, () => setExporting(true));
  }), []);
  useEffect(() => () => void flushDocument(), []);
  // A composition left open by Composite is not a design: start at the home screen.
  useEffect(() => {
    if (!isDesign(composite.getState().doc)) design.setState({ home: true });
  }, []);
  return (
    <>
      <Shell
        left={
          editing ? (
            <>
              <MakePanel />
              <CanvasPanel />
            </>
          ) : (
            <StartPanel />
          )
        }
        center={
          editing ? (
            <>
              <DesignToolbar onExport={() => setExporting(true)} onSave={setSaving} />
              <CompositeView />
            </>
          ) : (
            <DesignHome templates={(q) => <TemplatesSection query={q} />} />
          )
        }
        right={
          editing ? (
            <>
              <LayersPanel />
              <PropertiesPanel />
            </>
          ) : null
        }
        dock={editing ? editorDock : homeDock}
      />
      <EffectsBrowserHost />
      {exporting && editing && <ExportDocumentDialog onClose={() => setExporting(false)} />}
      {saving && editing && <SaveAssetDialog kind={saving} onClose={() => setSaving(null)} />}
    </>
  );
}
