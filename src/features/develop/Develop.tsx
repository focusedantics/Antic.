import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { useStore } from "@/app/hooks";
import { registerShortcuts } from "@/app/shortcuts";
import { toast, ui } from "@/app/state";
import { catalog } from "@/core/catalog/store";
import { currentHistory, develop, type DevelopTool, flushDevelop } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { ExportDialog } from "@/features/export/ExportDialog";
import { showInDevelop } from "./loader";
import { autoWhiteBalance, BasicPanel } from "./panels/Basic";
import { ColorGradingPanel, ColorMixerPanel } from "./panels/Color";
import { DetailPanel, EffectsPanel, LensPanel } from "./panels/Detail";
import { HistogramView } from "./panels/Histogram";
import { copySettings, DevelopLeftPanel, pasteSettings } from "./panels/Left";
import { ToneCurvePanel } from "./panels/ToneCurve";
import { CropPanel } from "./tools/Crop";
import { startEyedropper } from "./tools/eyedropper";
import { DevelopView, zoomTo } from "./View";

type ShellProps = { left: ReactNode; center: ReactNode; right: ReactNode };

export function setTool(tool: DevelopTool) {
  const current = develop.getState().tool;
  develop.setState({ tool: current === tool ? "adjust" : tool });
}

function cycleCompare() {
  const order = ["off", "split", "side-by-side"] as const;
  const { compare } = develop.getState();
  develop.setState({ compare: order[(order.indexOf(compare) + 1) % order.length] });
}

function Toolbar({ onExport }: { onExport: () => void }) {
  const view = useStore(develop, (s) => s.view);
  const compare = useStore(develop, (s) => s.compare);
  const clipping = useStore(develop, (s) => s.clipping);
  const history = useStore(develop, (s) => s.recipe) && currentHistory();
  const zoomLabel = view.fit ? "Fit" : `${Math.round(view.zoom * 100)}%`;
  return (
    <div className="toolbar" role="toolbar" aria-label="Develop view">
      <div className="segmented" role="group" aria-label="Zoom">
        <button type="button" aria-pressed={view.fit} title="Fit (1)" onClick={() => develop.setState({ view: { ...view, fit: true } })}>
          Fit
        </button>
        <button type="button" aria-pressed={!view.fit && view.zoom === 1} title="100% (2)" onClick={() => zoomTo(1)}>
          1:1
        </button>
        <button type="button" aria-pressed={!view.fit && view.zoom === 2} title="200% (3)" onClick={() => zoomTo(2)}>
          2:1
        </button>
      </div>
      <span className="dim num" style={{ minWidth: 40 }}>
        {zoomLabel}
      </span>
      <div className="segmented" role="group" aria-label="Before and after">
        {(["off", "split", "side-by-side"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={compare === m} title="Cycle with 5 or Y" onClick={() => develop.setState({ compare: m })}>
            {m === "off" ? "After" : m === "split" ? "Split" : "Side by side"}
          </button>
        ))}
      </div>
      <button type="button" className="btn small" aria-pressed={clipping} title="Show clipping (J)" onClick={() => develop.setState({ clipping: !clipping })}>
        Clipping
      </button>
      <span className="spacer" />
      <button type="button" className="btn small" disabled={!history?.status().canUndo} title="Undo (Ctrl+Z)" onClick={() => history?.undo()}>
        Undo
      </button>
      <button type="button" className="btn small" disabled={!history?.status().canRedo} title="Redo (Ctrl+Shift+Z)" onClick={() => history?.redo()}>
        Redo
      </button>
      <button type="button" className="btn small primary" title="Export (Ctrl+Shift+E)" onClick={onExport}>
        Export…
      </button>
    </div>
  );
}

function ToolStrip() {
  const tool = useStore(develop, (s) => s.tool);
  const tools: { id: DevelopTool; label: string; key: string }[] = [
    { id: "adjust", label: "Edit", key: "" },
    { id: "crop", label: "Crop", key: "R" },
  ];
  return (
    <div className="tool-strip" role="toolbar" aria-label="Develop tools">
      {tools.map((t) => (
        <button key={t.id} type="button" className="btn small" aria-pressed={tool === t.id} title={t.key ? `${t.label} (${t.key})` : t.label} onClick={() => develop.setState({ tool: t.id })}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function RightPanel() {
  const tool = useStore(develop, (s) => s.tool);
  const hasRecipe = useStore(develop, (s) => !!s.recipe);
  if (!hasRecipe) return null;
  return (
    <>
      <HistogramView />
      <ToolStrip />
      {tool === "crop" && <CropPanel />}
      <BasicPanel />
      <ToneCurvePanel />
      <ColorMixerPanel />
      <ColorGradingPanel />
      <DetailPanel />
      <LensPanel />
      <EffectsPanel />
    </>
  );
}

function developShortcuts(e: KeyboardEvent, openExport: () => void): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const history = currentHistory();
  if (mod && key === "z") {
    if (e.shiftKey) history?.redo();
    else history?.undo();
    return true;
  }
  if (mod && key === "y") {
    history?.redo();
    return true;
  }
  if (mod && e.shiftKey && key === "c") {
    copySettings();
    return true;
  }
  if (mod && e.shiftKey && key === "v") {
    pasteSettings();
    return true;
  }
  if (mod && e.shiftKey && key === "e") {
    openExport();
    return true;
  }
  if (mod) return false;
  const { view, tool } = develop.getState();
  switch (key) {
    case "1":
      develop.setState({ view: { ...view, fit: true } });
      return true;
    case "2":
      zoomTo(1);
      return true;
    case "3":
      zoomTo(2);
      return true;
    case "5":
    case "y":
      cycleCompare();
      return true;
    case "\\":
      develop.setState({ compare: develop.getState().compare === "off" ? "split" : "off" });
      return true;
    case "j":
      develop.setState({ clipping: !develop.getState().clipping });
      return true;
    case "r":
      setTool("crop");
      return true;
    case "w":
      startEyedropper();
      return true;
    case "enter":
      if (tool !== "adjust") {
        develop.setState({ tool: "adjust" });
        return true;
      }
      return false;
    case "escape":
      if (tool !== "adjust") {
        develop.setState({ tool: "adjust" });
        return true;
      }
      return false;
  }
  if (e.shiftKey && key === "u") {
    autoWhiteBalance();
    return true;
  }
  return false;
}

export default function Develop({ Shell }: { Shell: ComponentType<ShellProps> }) {
  const activeId = useStore(ui, (s) => s.activeId);
  const firstId = useStore(catalog, (s) => (s.assets.size ? s.assets.keys().next().value : null));
  const assetId = useStore(develop, (s) => s.assetId);
  const [exporting, setExporting] = useState(false);
  const target = activeId ?? firstId ?? null;

  useEffect(() => {
    if (!target) return;
    if (!ui.getState().activeId) ui.setState({ activeId: target, selection: new Set([target]) });
    if (develop.getState().assetId !== target || develop.getState().error) void showInDevelop(target);
  }, [target]);

  useEffect(() => registerShortcuts("develop", (e) => developShortcuts(e, () => setExporting(true))), []);
  useEffect(
    () => () => {
      flushDevelop();
      void developEngine().refreshThumbnails();
    },
    [],
  );

  if (!target)
    return (
      <Shell
        left={null}
        center={
          <div className="empty-state">
            <h2>Nothing to develop</h2>
            <p>Import photos in the Library first.</p>
          </div>
        }
        right={null}
      />
    );
  return (
    <>
      <Shell
        left={<DevelopLeftPanel />}
        center={
          <>
            <Toolbar onExport={() => setExporting(true)} />
            <DevelopView />
          </>
        }
        right={assetId ? <RightPanel /> : null}
      />
      {exporting && (
        <ExportDialog
          ids={ui.getState().selection.size > 1 ? [...ui.getState().selection] : [assetId ?? target]}
          onClose={() => setExporting(false)}
          onDone={(n) => toast(`Exported ${n} photo${n === 1 ? "" : "s"}.`)}
        />
      )}
    </>
  );
}
