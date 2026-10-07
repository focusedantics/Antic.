import { clipboardShortcut, useLayerClipboard } from "./clipboard";
import { chooseFiles, pickerAccept } from "@/lib/files";
import { CompactActions, type DockItem, type ShellProps, TopAction } from "@/app/Shell";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { useStore } from "@/app/hooks";
import { loadCustomFonts } from "@/core/text/custom-fonts";
import { layout } from "@/app/layout";
import { Icon, type IconName } from "@/components/icons";
import { registerShortcuts } from "@/app/shortcuts";
import { toast, ui } from "@/app/state";
import { Dialog, openMenu } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { type DocumentRecord, getDocument } from "@/core/catalog/db";
import { align, type Alignment, distribute, locate, moveTransform, ungroup, updateLayers } from "@/core/document/operations";
import {
  composite,
  type CompositeTool,
  compositeHistory,
  editDocument,
  flushDocument,
  openDocument,
  openStoredDocument,
  openLatest,
  refreshDocumentList,
  removeStoredDocument,
} from "@/core/document/session";
import { openProject, saveProject } from "@/core/document/project";
import { isAnimated } from "@/core/document/animation";
import { newDocument } from "./actions";
import { addLayerMenu, arrangeSelected, deleteSelected, duplicateSelected, groupSelected, LayersPanel } from "./LayersPanel";
import { PropertiesPanel } from "./Properties";
import { DocColor } from "./fields";
import { ColorField } from "@/features/color/ColorField";
import { openLooks } from "@/features/looks/LooksDialog";
import { readLookFile } from "@/core/looks/look";
import { saveLook } from "@/core/looks/store";
import { ExportDocumentDialog } from "./ExportDocument";
import { EffectsBrowserHost, openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { CompositeView, zoomComposite } from "./View";
import { brush } from "@/features/develop/masks/brush";


const presets = [
  { label: "Instagram portrait 4:5", w: 1080, h: 1350 },
  { label: "Square 1:1", w: 2048, h: 2048 },
  { label: "Story 9:16", w: 1080, h: 1920 },
  { label: "Full HD 16:9", w: 1920, h: 1080 },
  { label: "4K UHD", w: 3840, h: 2160 },
  { label: "A4 300 ppi", w: 2480, h: 3508 },
  { label: "3:2 photo 24 MP", w: 6000, h: 4000 },
];

function NewDocumentDialog({ onClose }: { onClose: () => void }) {
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [name, setName] = useState("Untitled");
  const [bg, setBg] = useState<string | null>("#ffffff");
  return (
    <Dialog
      title="New Composition"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              newDocument(w, h, name || "Untitled", bg);
              onClose();
            }}
          >
            Create
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Preset</span>
        <select
          className="input"
          value=""
          onChange={(e) => {
            const p = presets[Number(e.target.value)];
            if (p) {
              setW(p.w);
              setH(p.h);
            }
          }}
        >
          <option value="">Choose…</option>
          {presets.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label} — {p.w} × {p.h}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Width (px)</span>
          <input className="input" type="number" min={16} max={30000} value={w} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setW(Math.max(16, Number(e.target.value) || 16))} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Height (px)</span>
          <input className="input" type="number" min={16} max={30000} value={h} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setH(Math.max(16, Number(e.target.value) || 16))} />
        </label>
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={bg === null} onChange={(e) => setBg(e.target.checked ? null : "#ffffff")} /> Transparent background
        </label>
        {bg !== null && <ColorField label="Background color" value={bg} onChange={setBg} />}
      </div>
    </Dialog>
  );
}

async function saveProjectFile() {
  const doc = composite.getState().doc;
  if (!doc) return;
  const includeOriginals = confirm("Include the original photo files in the project?\n\nOK: a self-contained file you can move to another computer.\nCancel: a small file that relinks to photos already in the library.");
  try {
    const blob = await saveProject(doc, { includeOriginals });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.name}.focused`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    toast(`Could not save the project: ${error instanceof Error ? error.message : error}`, "error");
  }
}

async function openProjectFile() {
  const [file] = await chooseFiles({ accept: pickerAccept(".focused,application/zip", {}) });
  if (!file) return;
  try {
    // A .focused file is either a look (reusable edits) or a project.
    const look = await readLookFile(file);
    if (look) {
      await saveLook(look);
      toast(`Added the look “${look.name}”.`);
      openLooks({ kind: "composite" });
      return;
    }
    const { document: doc, missing } = await openProject(file);
    openDocument(doc);
    if (missing.length) toast(`Opened. ${missing.length} photo(s) were not in the library or the file: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`, "error");
    else toast(`Opened “${doc.name}”.`);
  } catch (error) {
    toast(`Could not open the project: ${error instanceof Error ? error.message : error}`, "error");
  }
}

function DocumentsPanel({ onNew }: { onNew: () => void }) {
  // Designs are listed in the Design workspace.
  const all = useStore(composite, (s) => s.documents);
  const docs = useMemo(() => all.filter((d) => !d.design), [all]);
  const current = useStore(composite, (s) => s.doc?.id);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    void refreshDocumentList();
  }, []);
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    void Promise.all(docs.map((d) => getDocument(d.id))).then((records) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const r of records.filter((x): x is DocumentRecord => !!x && !!x.thumb)) {
        const url = URL.createObjectURL(r.thumb!);
        urls.push(url);
        next[r.id] = url;
      }
      setThumbs(next);
    });
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [docs]);
  return (
    <Panel
      id="cmp-docs"
      title="Compositions"
      actions={
        <button type="button" className="btn small" onClick={onNew}>
          + New
        </button>
      }
    >
      {!docs.length && <p className="faint">No compositions yet.</p>}
      <div className="row wrap" style={{ marginBottom: 6 }}>
        <button type="button" className="btn small" onClick={openProjectFile}>
          Open .focused…
        </button>
        <button type="button" className="btn small" disabled={!current} onClick={() => void saveProjectFile()}>
          Save .focused…
        </button>
      </div>
      {docs.map((d) => (
        <div key={d.id} className="row">
          <button type="button" className="doc-card" aria-current={d.id === current} onClick={() => void openStoredDocument(d.id)}>
            {thumbs[d.id] ? <img src={thumbs[d.id]} alt="" /> : <span className="ph" />}
            <span className="name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {d.name}
            </span>
          </button>
          <button
            type="button"
            className="btn ghost small"
            aria-label={`Delete ${d.name}`}
            onClick={() => {
              if (confirm(`Delete composition “${d.name}”? Photos stay in the library.`)) void removeStoredDocument(d.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </Panel>
  );
}

/** The open document's name, size and background (Design shows it too). */
export function CanvasPanel() {
  const doc = useStore(composite, (s) => s.doc);
  if (!doc) return null;
  return (
    <Panel id="cmp-canvas" title="Canvas" defaultOpen={false}>
      <label className="field">
        <span>Name</span>
        <input className="input" value={doc.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => editDocument("Rename", (d) => ({ ...d, name: e.target.value }))} />
      </label>
      <div className="row" style={{ marginTop: 6 }}>
        <label className="field" style={{ flex: 1 }}>
          {/* A carousel's width is per slide (the canvas is that many slides wide). */}
          <span>{doc.carousel ? `Slide width (${doc.carousel.slides} slides)` : "Width"}</span>
          <input
            className="input"
            type="number"
            value={Math.round(doc.width / (doc.carousel?.slides ?? 1))}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const n = doc.carousel?.slides ?? 1;
              editDocument("Canvas size", (d) => ({ ...d, width: Math.max(16, Math.min(30000, (Number(e.target.value) || 16) * n)) }));
            }}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Height</span>
          <input className="input" type="number" value={doc.height} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => editDocument("Canvas size", (d) => ({ ...d, height: Math.max(16, Math.min(30000, Number(e.target.value) || 16)) }))} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <label className="check">
          <input type="checkbox" checked={doc.background === null} onChange={(e) => editDocument("Background", (d) => ({ ...d, background: e.target.checked ? null : "#ffffff" }))} /> Transparent
        </label>
        {doc.background && <DocColor label="Background color" value={doc.background} onChange={(c) => editDocument("Background", (d) => ({ ...d, background: c }))} />}
      </div>
    </Panel>
  );
}

/** Switches the canvas tool (pen, points, drawing), leaving any mask being painted. */
export const setTool = (tool: CompositeTool) => composite.setState({ tool, maskLayerId: null });

/** Pen, points and drawing tools in a segmented group (computers). */
export function DrawingTools() {
  const tool = useStore(composite, (s) => s.tool);
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  const selected = doc && selection.length ? locate(doc.layers, selection[selection.length - 1])?.layer : null;
  return (
    <>
      <button type="button" aria-pressed={tool === "pen"} disabled={!doc} title="Pen: draw lines and shapes point by point (P)" onClick={() => setTool("pen")}>
        Pen
      </button>
      <button type="button" aria-pressed={tool === "nodes"} disabled={selected?.kind !== "path"} title="Edit the selected path's points (A, or double-click the path)" onClick={() => setTool("nodes")}>
        Points
      </button>
      <button type="button" aria-pressed={tool === "paint"} disabled={!doc} title="Draw with brushes and fill areas (Shift+B)" onClick={() => setTool("paint")}>
        Draw
      </button>
    </>
  );
}

/** A phone toolbar button: a large icon with its name for screen readers and as a tooltip. */
function ToolIcon({ icon, label, onClick, pressed, disabled }: { icon: IconName; label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; pressed?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className="tool-icon" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={22} />
    </button>
  );
}

function Toolbar({ onExport }: { onExport: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  const snap = useStore(composite, (s) => s.snap);
  const showGuides = useStore(composite, (s) => s.showGuides);
  const playing = useStore(composite, (s) => s.playing);
  const view = useStore(composite, (s) => s.view);
  const tool = useStore(composite, (s) => s.tool);
  const history = compositeHistory();
  const alignTo = (a: Alignment) => editDocument(`Align ${a}`, (d) => align(d, selection, a));
  const compact = useStore(layout, (s) => s.compact);
  const actions = (
    <CompactActions>
      <TopAction icon="undo" label="Undo" disabled={!history?.status().canUndo} onClick={() => history?.undo()} />
      <TopAction icon="redo" label="Redo" disabled={!history?.status().canRedo} onClick={() => history?.redo()} />
      <TopAction icon="export" label="Export" primary disabled={!doc} onClick={onExport} />
    </CompactActions>
  );
  if (compact)
    // Phones: the same tools as large icons; alignment and distribution in one menu.
    return (
      <div className="toolbar icon-toolbar" role="toolbar" aria-label="Composite tools">
        <ToolIcon icon="move" label="Move & transform" pressed={tool === "move"} onClick={() => composite.setState({ tool: "move", maskLayerId: null })} />
        <ToolIcon icon="brush" label="Paint the mask" pressed={tool === "mask"} disabled={!composite.getState().maskLayerId} onClick={() => composite.setState({ tool: "mask" })} />
        <ToolIcon icon="pen" label="Pen (P)" pressed={tool === "pen"} disabled={!doc} onClick={() => setTool("pen")} />
        <ToolIcon icon="draw" label="Draw (Shift+B)" pressed={tool === "paint"} disabled={!doc} onClick={() => setTool("paint")} />
        <ToolIcon
          icon="align"
          label="Align and distribute"
          disabled={!selection.length}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 4, [
              ...(["left", "center", "right", "top", "middle", "bottom"] as const).map((a) => ({ label: `Align ${a}${selection.length === 1 ? " to canvas" : ""}`, onSelect: () => alignTo(a) })),
              "separator" as const,
              { label: "Distribute horizontally", disabled: selection.length < 3, onSelect: () => editDocument("Distribute", (d) => distribute(d, selection, "x")) },
              { label: "Distribute vertically", disabled: selection.length < 3, onSelect: () => editDocument("Distribute", (d) => distribute(d, selection, "y")) },
            ]);
          }}
        />
        <ToolIcon icon="magnet" label="Snap" pressed={snap} onClick={() => composite.setState({ snap: !snap })} />
        <ToolIcon icon="guides" label="Guides" pressed={showGuides} onClick={() => composite.setState({ showGuides: !showGuides })} />
        {doc && isAnimated(doc) && <ToolIcon icon="animate" label={playing ? "Stop animating" : "Animate"} pressed={playing} onClick={() => composite.setState({ playing: !playing })} />}
        <ToolIcon icon="fit" label="Fit" pressed={view.fit} onClick={() => composite.setState({ view: { ...view, fit: true } })} />
        <ToolIcon icon="plus" label="Add a layer" disabled={!doc} onClick={(e) => addLayerMenu(e.clientX, e.clientY)} />
        <ToolIcon icon="presets" label="Looks" disabled={!doc} onClick={() => openLooks({ kind: "composite" })} />
        {actions}
      </div>
    );
  return (
    <div className="toolbar" role="toolbar" aria-label="Composite tools">
      <div className="segmented" role="group" aria-label="Tool">
        <button type="button" aria-pressed={tool === "move"} title="Move & transform (V)" onClick={() => composite.setState({ tool: "move", maskLayerId: null })}>
          Move
        </button>
        <button type="button" aria-pressed={tool === "mask"} disabled={!composite.getState().maskLayerId} title="Paint the selected layer's mask">
          Mask
        </button>
        <DrawingTools />
      </div>
      <div className="segmented" role="group" aria-label="Align">
        {(["left", "center", "right", "top", "middle", "bottom"] as const).map((a) => (
          <button key={a} type="button" disabled={!selection.length} title={`Align ${a}${selection.length === 1 ? " to canvas" : ""}`} onClick={() => alignTo(a)}>
            {{ left: "⇤", center: "↔", right: "⇥", top: "⤒", middle: "↕", bottom: "⤓" }[a]}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="Distribute">
        <button type="button" disabled={selection.length < 3} title="Distribute horizontally" onClick={() => editDocument("Distribute", (d) => distribute(d, selection, "x"))}>
          ⋯
        </button>
        <button type="button" disabled={selection.length < 3} title="Distribute vertically" onClick={() => editDocument("Distribute", (d) => distribute(d, selection, "y"))}>
          ⋮
        </button>
      </div>
      <button type="button" className="btn small" aria-pressed={snap} title="Snap to canvas, guides and layers (hold Alt to bypass)" onClick={() => composite.setState({ snap: !snap })}>
        Snap
      </button>
      <button type="button" className="btn small" aria-pressed={showGuides} title="Show guides (Ctrl+;)" onClick={() => composite.setState({ showGuides: !showGuides })}>
        Guides
      </button>
      {doc && isAnimated(doc) && (
        <button type="button" className="btn small" aria-pressed={playing} title="Play animated effects in the canvas (exports are unaffected)" onClick={() => composite.setState({ playing: !playing })}>
          {playing ? "❚❚ Animating" : "▶ Animate"}
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
      <button type="button" className="btn small wide-only" disabled={!history?.status().canUndo} onClick={() => history?.undo()} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" className="btn small wide-only" disabled={!history?.status().canRedo} onClick={() => history?.redo()} title="Redo (Ctrl+Shift+Z)">
        Redo
      </button>
      <button type="button" className="btn small" disabled={!doc} onClick={(e) => addLayerMenu(e.clientX, e.clientY)}>
        + Layer
      </button>
      <button type="button" className="btn small" disabled={!doc} onClick={() => openEffectsBrowser()} title="Add an effect layer (Shift+E)">
        ✦ Effects
      </button>
      <button type="button" className="btn small" disabled={!doc} onClick={() => openLooks({ kind: "composite" })} title="Save this composition's effects and edits as a look, or apply one">
        Looks…
      </button>
      <button type="button" className="btn small primary wide-only" disabled={!doc} onClick={onExport} title="Export (Ctrl+Shift+E)">
        Export…
      </button>
      {actions}
    </div>
  );
}

/** The canvas editor's keys (Design uses them too). */
export function compositeShortcuts(e: KeyboardEvent, openExport: () => void): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const { selection, doc } = composite.getState();
  const history = compositeHistory();
  if (!doc) return false;
  clipboardShortcut(e);
  if (mod && key === "z") {
    if (e.shiftKey) history?.redo();
    else history?.undo();
    return true;
  }
  if (mod && key === "j") {
    duplicateSelected();
    return true;
  }
  if (mod && e.altKey && key === "g") {
    editDocument("Clipping mask", (d) => updateLayers(d, selection, (l) => ({ ...l, clip: !l.clip })));
    return true;
  }
  if (mod && e.shiftKey && key === "g") {
    for (const id of selection) editDocument("Ungroup", (d) => ungroup(d, id));
    return true;
  }
  if (mod && key === "g") {
    groupSelected();
    return true;
  }
  // Arrange: Ctrl+] / Ctrl+[ one step, with Shift to the front / back (by key position: Shift+] types "}").
  if (mod && (e.code === "BracketRight" || e.code === "BracketLeft" || key === "]" || key === "[")) {
    const up = e.code === "BracketRight" || key === "]";
    arrangeSelected(e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward");
    return true;
  }
  if (mod && e.shiftKey && key === "e") {
    openExport();
    return true;
  }
  if (mod && key === ";") {
    composite.setState((s) => ({ showGuides: !s.showGuides }));
    return true;
  }
  if (mod) return false;
  // Mask brush size while painting a layer mask.
  if ((key === "[" || key === "]") && composite.getState().tool === "mask") {
    brush.setState((st) => ({ size: key === "]" ? Math.min(0.4, st.size * 1.15) : Math.max(0.0005, st.size / 1.15) }));
    return true;
  }
  if (key === "delete" || key === "backspace") {
    deleteSelected();
    return true;
  }
  if (key === "v") {
    composite.setState({ tool: "move", maskLayerId: null });
    return true;
  }
  if (key === "p" && !e.shiftKey) {
    setTool("pen");
    return true;
  }
  if (key === "b" && e.shiftKey) {
    setTool("paint");
    return true;
  }
  if (key === "a" && !e.shiftKey) {
    const selected = selection.length ? locate(doc.layers, selection[selection.length - 1])?.layer : null;
    if (selected?.kind !== "path") return false;
    setTool("nodes");
    return true;
  }
  if (key === "e" && e.shiftKey) {
    openEffectsBrowser();
    return true;
  }
  if (key === "1") {
    composite.setState((s) => ({ view: { ...s.view, fit: true } }));
    return true;
  }
  if (key === "2") {
    zoomComposite(1);
    return true;
  }
  if (key.startsWith("arrow") && selection.length) {
    const step = e.shiftKey ? 10 : 1;
    const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
    const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
    editDocument("Nudge", (d) => updateLayers(d, selection.filter((id) => !locate(d.layers, id)?.layer.locked), (l) => ({ ...l, transform: moveTransform(l.transform, dx, dy) })));
    return true;
  }
  if (key === "escape") {
    composite.setState({ tool: "move", maskLayerId: null, selection: [] });
    return true;
  }
  return false;
}

/** Phones: the documents, the layers and their properties, and the effects browser. */
const compositeDock = (hasDoc: boolean): DockItem[] => [
  { id: "documents", label: "Documents", icon: "documents", side: "left" },
  { id: "layers", label: "Layers", icon: "layers", side: "right" },
  { id: "effects", label: "Effects", icon: "effects", disabled: !hasDoc, onSelect: () => openEffectsBrowser() },
];

export default function Composite({ Shell }: { Shell: ComponentType<ShellProps> }) {
  // A design open from the Design workspace is not shown here (it is replaced as this opens).
  // Only whether one is open: subscribing to the document re-rendered every panel per edit.
  const doc = useStore(composite, (s) => !!s.doc && !s.doc.purpose);
  const allDocs = useStore(composite, (s) => s.documents);
  const docs = useMemo(() => allDocs.filter((d) => !d.design), [allDocs]);
  const [dialog, setDialog] = useState<"new" | "export" | null>(null);
  useEffect(() => registerShortcuts("composite", (e) => compositeShortcuts(e, () => setDialog("export"))), []);
  useLayerClipboard(() => ui.getState().workspace === "composite" && !!composite.getState().doc && !composite.getState().doc!.purpose);
  useEffect(() => () => void flushDocument(), []);
  // Fonts the user imported, for text in these documents.
  useEffect(() => {
    void loadCustomFonts();
  }, []);
  // Reopen the most recent composition (the open document may be a design, from the Design workspace).
  useEffect(() => {
    void openLatest(false);
  }, []);
  const selectionSize = useStore(ui, (s) => s.selection.size);
  return (
    <>
      <Shell
        left={
          <>
            <DocumentsPanel onNew={() => setDialog("new")} />
            <CanvasPanel />
          </>
        }
        center={
          <>
            <Toolbar onExport={() => setDialog("export")} />
            {doc ? (
              <CompositeView />
            ) : (
              <div className="empty-state">
                <h2>Composite</h2>
                <p>Build layered compositions from your developed photos, with gradients, text, shapes, masks and blend modes.</p>
                <div className="row" style={{ justifyContent: "center" }}>
                  <button type="button" className="btn primary" onClick={() => setDialog("new")}>
                    New Composition…
                  </button>
                  {selectionSize > 0 && (
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const { addAssetsToComposite } = await import("./actions");
                        await addAssetsToComposite([...ui.getState().selection]);
                      }}
                    >
                      Start from {selectionSize} selected photo{selectionSize === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
                {docs.length > 0 && <p className="faint" style={{ marginTop: 14 }}>Or open one from the list on the left.</p>}
              </div>
            )}
          </>
        }
        right={
          doc ? (
            <>
              <LayersPanel />
              <PropertiesPanel />
            </>
          ) : null
        }
        dock={compositeDock(!!doc)}
      />
      <EffectsBrowserHost />
      {dialog === "new" && <NewDocumentDialog onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDocumentDialog onClose={() => setDialog(null)} />}
    </>
  );
}

