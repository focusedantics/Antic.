import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { useStore } from "@/app/hooks";
import { registerShortcuts } from "@/app/shortcuts";
import { toast, ui } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { type DocumentRecord, getDocument } from "@/core/catalog/db";
import { align, type Alignment, distribute, groupLayers, locate, moveTransform, nudgeLayer, ungroup, updateLayers } from "@/core/document/operations";
import {
  composite,
  compositeHistory,
  editDocument,
  flushDocument,
  openDocument,
  openStoredDocument,
  refreshDocumentList,
  removeStoredDocument,
} from "@/core/document/session";
import { openProject, saveProject } from "@/core/document/project";
import { isAnimated } from "@/core/document/animation";
import { newDocument } from "./actions";
import { addLayerMenu, deleteSelected, duplicateSelected, LayersPanel } from "./LayersPanel";
import { PropertiesPanel } from "./Properties";
import { openLooks } from "@/features/looks/LooksDialog";
import { readLookFile } from "@/core/looks/look";
import { saveLook } from "@/core/looks/store";
import { ExportDocumentDialog } from "./ExportDocument";
import { EffectsBrowserHost, openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { CompositeView, zoomComposite } from "./View";

type ShellProps = { left: ReactNode; center: ReactNode; right: ReactNode };

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
        {bg !== null && <input type="color" value={bg} aria-label="Background color" onChange={(e) => setBg(e.target.value)} />}
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

function openProjectFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".focused,application/zip";
  input.onchange = async () => {
    const file = input.files?.[0];
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
  };
  input.click();
}

function DocumentsPanel({ onNew }: { onNew: () => void }) {
  const docs = useStore(composite, (s) => s.documents);
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

function CanvasPanel() {
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
          <span>Width</span>
          <input className="input" type="number" value={doc.width} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => editDocument("Canvas size", (d) => ({ ...d, width: Math.max(16, Math.min(30000, Number(e.target.value) || 16)) }))} />
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
        {doc.background && <input type="color" value={doc.background} aria-label="Background color" onChange={(e) => editDocument("Background", (d) => ({ ...d, background: e.target.value }))} />}
      </div>
    </Panel>
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
  return (
    <div className="toolbar" role="toolbar" aria-label="Composite tools">
      <div className="segmented" role="group" aria-label="Tool">
        <button type="button" aria-pressed={tool === "move"} title="Move & transform (V)" onClick={() => composite.setState({ tool: "move", maskLayerId: null })}>
          Move
        </button>
        <button type="button" aria-pressed={tool === "mask"} disabled={!composite.getState().maskLayerId} title="Paint the selected layer's mask">
          Mask
        </button>
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
      <button type="button" className="btn small" disabled={!history?.status().canUndo} onClick={() => history?.undo()} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" className="btn small" disabled={!history?.status().canRedo} onClick={() => history?.redo()} title="Redo (Ctrl+Shift+Z)">
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
      <button type="button" className="btn small primary" disabled={!doc} onClick={onExport} title="Export (Ctrl+Shift+E)">
        Export…
      </button>
    </div>
  );
}

function compositeShortcuts(e: KeyboardEvent, openExport: () => void): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const { selection, doc } = composite.getState();
  const history = compositeHistory();
  if (!doc) return false;
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
    let id: string | null = null;
    editDocument("Group layers", (d) => {
      const r = groupLayers(d, selection);
      id = r.id;
      return r.doc;
    });
    if (id) composite.setState({ selection: [id] });
    return true;
  }
  if (mod && (key === "]" || key === "[")) {
    for (const id of selection) editDocument("Arrange", (d) => nudgeLayer(d, id, key === "]" ? 1 : -1));
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
  if (key === "delete" || key === "backspace") {
    deleteSelected();
    return true;
  }
  if (key === "v") {
    composite.setState({ tool: "move", maskLayerId: null });
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

export default function Composite({ Shell }: { Shell: ComponentType<ShellProps> }) {
  const doc = useStore(composite, (s) => s.doc);
  const docs = useStore(composite, (s) => s.documents);
  const [dialog, setDialog] = useState<"new" | "export" | null>(null);
  useEffect(() => registerShortcuts("composite", (e) => compositeShortcuts(e, () => setDialog("export"))), []);
  useEffect(() => () => flushDocument(), []);
  // Reopen the most recent composition.
  useEffect(() => {
    if (!composite.getState().doc) void refreshDocumentList().then(() => {
      const first = composite.getState().documents[0];
      if (first && !composite.getState().doc) void openStoredDocument(first.id);
    });
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
      />
      <EffectsBrowserHost />
      {dialog === "new" && <NewDocumentDialog onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDocumentDialog onClose={() => setDialog(null)} />}
    </>
  );
}

