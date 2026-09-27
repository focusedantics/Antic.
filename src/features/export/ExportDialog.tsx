import { useEffect, useState } from "react";
import { toast } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { getAsset } from "@/core/catalog/store";
import { outputSize } from "@/core/develop/geometry";
import { recipeFor } from "@/core/develop/session";
import { canChooseFolder, chooseFolder, defaultExportSettings, exportAsset, type ExportSettings, exportSize, save } from "@/core/export/export";
import { developEngine } from "@/core/gpu/develop-engine";
import { formatBytes } from "@/features/library/format";

let remembered: ExportSettings = defaultExportSettings;

export function ExportDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (count: number) => void }) {
  const [s, setS] = useState<ExportSettings>(remembered);
  const [busy, setBusy] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ width: number; height: number; bytes?: number } | null>(null);
  const set = (patch: Partial<ExportSettings>) => setS((prev) => ({ ...prev, ...patch }));

  // Dimensions of the first photo, and its encoded size when it is already decoded.
  useEffect(() => {
    const id = ids[0];
    const asset = getAsset(id);
    const recipe = recipeFor(id);
    const src = developEngine().sourceFor(id);
    const base = src ?? (asset?.width && asset.height ? { size: { width: asset.width, height: asset.height } } : null);
    if (!recipe || !base) return;
    const size = exportSize(outputSize(base.size, recipe.geometry), s);
    setEstimate({ width: size.width, height: size.height });
    if (!src || developEngine().hasSource(id, "preview")) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const result = await exportAsset(id, s);
        if (live) setEstimate({ width: result.width, height: result.height, bytes: result.blob.size });
      } catch {
        // The estimate is optional.
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ids, s]);

  const run = async () => {
    remembered = s;
    let folder;
    try {
      if (canChooseFolder() && ids.length > 1) folder = await chooseFolder();
    } catch {
      return;
    }
    let done = 0;
    for (const [i, id] of ids.entries()) {
      setBusy(`Exporting ${i + 1} of ${ids.length}…`);
      try {
        await save(await exportAsset(id, s), folder);
        done++;
      } catch (error) {
        toast(`${getAsset(id)?.fileName}: ${error instanceof Error ? error.message : error}`, "error");
      }
    }
    setBusy(null);
    onDone(done);
    onClose();
  };

  return (
    <Dialog
      title={`Export ${ids.length === 1 ? (getAsset(ids[0])?.fileName ?? "photo") : `${ids.length} photos`}`}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="dim num" style={{ marginRight: "auto" }}>
            {busy ??
              (estimate
                ? `${estimate.width} × ${estimate.height} px${estimate.bytes ? ` · ${formatBytes(estimate.bytes)}` : ""}${ids.length > 1 ? " (first photo)" : ""}`
                : "")}
          </span>
          <button type="button" className="btn" disabled={!!busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!!busy} onClick={run}>
            Export
          </button>
        </>
      }
    >
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Format</span>
          <select className="input" value={s.format} onChange={(e) => set({ format: e.target.value as ExportSettings["format"] })}>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG (keeps transparency)</option>
            <option value="webp">WebP (keeps transparency)</option>
          </select>
        </label>
        {s.format !== "png" && (
          <label className="field" style={{ flex: 1 }}>
            <span>Quality {Math.round(s.quality * 100)}</span>
            <input type="range" min={40} max={100} value={Math.round(s.quality * 100)} onChange={(e) => set({ quality: Number(e.target.value) / 100 })} />
          </label>
        )}
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Size</span>
          <select className="input" value={s.resize} onChange={(e) => set({ resize: e.target.value as ExportSettings["resize"] })}>
            <option value="full">Full resolution</option>
            <option value="long">Long edge</option>
            <option value="short">Short edge</option>
            <option value="width">Width</option>
            <option value="height">Height</option>
          </select>
        </label>
        {s.resize !== "full" && (
          <label className="field" style={{ width: 110 }}>
            <span>Pixels</span>
            <input className="input" type="number" min={16} max={30000} value={s.size} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set({ size: Math.max(16, Number(e.target.value) || 0) })} />
          </label>
        )}
      </div>
      {s.resize !== "full" && (
        <label className="check">
          <input type="checkbox" checked={s.enlarge} onChange={(e) => set({ enlarge: e.target.checked })} /> Allow enlarging
        </label>
      )}
      {s.format === "jpeg" && (
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            <span>Metadata</span>
            <select className="input" value={s.metadata} onChange={(e) => set({ metadata: e.target.value as ExportSettings["metadata"] })}>
              <option value="all">Camera, lens, exposure, date, copyright</option>
              <option value="copyright">Copyright only</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className="field">
            <span>Background</span>
            <input type="color" value={s.background} onChange={(e) => set({ background: e.target.value })} aria-label="Background for transparent areas" />
          </label>
        </div>
      )}
      <label className="field">
        <span>File name suffix</span>
        <input className="input" placeholder="e.g. -web" value={s.suffix} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set({ suffix: e.target.value.replace(/[\\/:*?"<>|]/g, "") })} />
      </label>
      <p className="faint" style={{ fontSize: 11, margin: 0 }}>
        Colors are exported in sRGB. {ids.length > 1 && canChooseFolder() ? "You will choose a destination folder." : "Files are saved through your browser's downloads."}
      </p>
    </Dialog>
  );
}
