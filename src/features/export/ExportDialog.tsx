import { device } from "@/lib/device";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast, ui } from "@/app/state";
import { loadImageUrl, useImageUrl } from "@/app/thumbs";
import { Dialog } from "@/components/Menu";
import { catalog, getAsset } from "@/core/catalog/store";
import { outputSize } from "@/core/develop/geometry";
import { recipeFor } from "@/core/develop/session";
import { type Destination, describeDestination, ExportSink } from "@/core/export/destination";
import { defaultExportSettings, exportAsset, type ExportSettings, exportSize } from "@/core/export/export";
import { type ExportFrame, frameLayout, rememberedFrame, rememberFrame } from "@/core/export/frame";
import { rememberedWatermark, rememberWatermark, type Watermark } from "@/core/export/watermark";
import { developEngine } from "@/core/gpu/develop-engine";
import { formatBytes } from "@/features/library/format";
import { holdAtLeast, nextPaint, PACE, sleep } from "@/lib/pacing";
import { DestinationPicker, ExportHero, type ExportPreview, initialDestination, WatermarkEditor } from "./ExportParts";
import { reportExport } from "./save";
import type { MarbleMood } from "./marble";

function ExportItem({ id, checked, onToggle }: { id: string; checked: boolean; onToggle: () => void }) {
  const asset = useStore(catalog, (s) => s.assets.get(id));
  const url = useImageUrl(asset, "thumb");
  return (
    <label>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      {url ? <img src={url} alt="" /> : <span className="ph" />}
      <span className="name">{asset?.fileName ?? id}</span>
    </label>
  );
}

let remembered: ExportSettings = defaultExportSettings;

export function ExportDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (count: number) => void }) {
  const [s, setS] = useState<ExportSettings>(remembered);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(ids));
  const [destination, setDestination] = useState<Destination>(initialDestination);
  const [watermark, setWatermark] = useState<Watermark>(rememberedWatermark);
  const [frame, setFrame] = useState<ExportFrame>(rememberedFrame);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string; item?: number } | null>(null);
  const [mood, setMood] = useState<MarbleMood>("idle");
  const cancelled = useRef(false);
  const chosen = ids.filter((id) => selected.has(id));
  const previewUrl = useImageUrl(getAsset(chosen[0] ?? ids[0]), "preview");
  const [estimate, setEstimate] = useState<{ width: number; height: number; bytes?: number } | null>(null);
  const set = (patch: Partial<ExportSettings>) => setS((prev) => ({ ...prev, ...patch }));

  // Dimensions of the first photo, and its encoded size when it is already decoded.
  useEffect(() => {
    const id = chosen[0];
    if (!id) return;
    const asset = getAsset(id);
    const recipe = recipeFor(id);
    const src = developEngine().sourceFor(id);
    const base = src ?? (asset?.width && asset.height ? { size: { width: asset.width, height: asset.height } } : null);
    if (!recipe || !base) return;
    const size = exportSize(outputSize(base.size, recipe.geometry), s);
    setEstimate({ width: size.width, height: size.height });
    // The byte estimate is a real export: only for sizes that render in a blink, and never during an export.
    if (!src || developEngine().hasSource(id, "preview") || busy || size.width * size.height > 12e6) return;
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
  }, [chosen[0], s]);

  // The finished file's size: the frame can make it bigger than the photo.
  const framed = estimate && frameLayout(estimate.width, estimate.height, frame);

  const run = async () => {
    remembered = s;
    rememberWatermark(watermark);
    rememberFrame(frame);
    cancelled.current = false;
    const sink = new ExportSink(destination, `Focused export (${chosen.length} photos).zip`);
    let done = 0;
    const started = performance.now();
    setBusy("Exporting…");
    setMood("working");
    setProgress({ done: 0, total: chosen.length, label: "Starting…", item: 1 });
    // Show the working state before any heavy work starts.
    await nextPaint();
    try {
      for (const [i, id] of chosen.entries()) {
        if (cancelled.current) break;
        const prefix = chosen.length > 1 ? `${i + 1} of ${chosen.length} · ` : "";
        const name = getAsset(id)?.fileName ?? "";
        setProgress({ done: i, total: chosen.length, label: `${prefix}${name}`, item: i + 1 });
        try {
          const result = await exportAsset(id, s, watermark, (stage, fraction) =>
            setProgress({ done: i + fraction, total: chosen.length, label: `${prefix}${name} · ${stage}`, item: i + 1 }),
            frame,
          );
          await sink.add(result.name, result.blob);
          done++;
        } catch (error) {
          toast(`${getAsset(id)?.fileName}: ${error instanceof Error ? error.message : error}`, "error");
        }
      }
      setProgress((p) => ({ done: chosen.length, total: chosen.length, label: destination.kind === "zip" ? "Packing the ZIP…" : "Finishing…", item: p?.item }));
      await sink.finish();
      // A quick export still shows its working state, then a short "done" beat.
      await holdAtLeast(started);
      if (done) {
        setMood("done");
        setProgress((p) => ({ done: chosen.length, total: chosen.length, label: `Saved ${done} photo${done === 1 ? "" : "s"} ✓`, item: p?.item }));
        await sleep(PACE.doneBeat);
        reportExport(sink, `Exported ${done} photo${done === 1 ? "" : "s"} to ${describeDestination(destination)}.`);
      }
    } catch (error) {
      toast(`Export failed: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setBusy(null);
      setProgress(null);
      setMood("idle");
    }
    onDone(done);
    onClose();
  };

  return (
    <Dialog
      wide
      title={`Export ${chosen.length === 1 ? (getAsset(chosen[0])?.fileName ?? "photo") : `${chosen.length} photos`}`}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="dim num" style={{ marginRight: "auto" }}>
            {busy ??
              (estimate
                ? `${framed!.width} × ${framed!.height} px${estimate.bytes ? ` · ${formatBytes(estimate.bytes)}` : ""}${ids.length > 1 ? " (first photo)" : ""}`
                : "")}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (busy) cancelled.current = true;
              else onClose();
            }}
          >
            {busy ? "Stop" : "Cancel"}
          </button>
          <button type="button" className="btn primary" disabled={!!busy || !chosen.length} onClick={run}>
            Export{chosen.length > 1 ? ` ${chosen.length}` : ""}
          </button>
        </>
      }
    >
      <ExportHero
        previews={photoPreviews(chosen)}
        count={chosen.length}
        mood={mood}
        progress={progress}
        current={progress?.item}
        title={chosen.length === 1 ? (getAsset(chosen[0])?.fileName ?? "Photo") : `${chosen.length} photos`}
        details={`${s.format.toUpperCase()}${framed ? ` · ${framed.width} × ${framed.height} px${ids.length > 1 ? " (first)" : ""}` : ""}${estimate?.bytes ? ` · about ${formatBytes(estimate.bytes)}` : ""}`}
      />
      {ids.length > 1 && (
        <div className="field">
          <span>
            Photos · {chosen.length} of {ids.length}{" "}
            <button type="button" className="btn ghost small" onClick={() => setSelected(new Set(chosen.length === ids.length ? [] : ids))}>
              {chosen.length === ids.length ? "Select none" : "Select all"}
            </button>
          </span>
          <div className="export-list">
            {ids.map((id) => (
              <ExportItem
                key={id}
                id={id}
                checked={selected.has(id)}
                onToggle={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </div>
      )}
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
      {device.lite && (
        <p className="dim" data-testid="device-cap">
          On this device photos export at up to {device.maxSide} px on the long side, so the browser has the memory to finish.
        </p>
      )}
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
      <DestinationPicker count={chosen.length} value={destination} onChange={setDestination} />
      <WatermarkEditor value={watermark} onChange={setWatermark} previewUrl={previewUrl} frame={frame} onFrame={setFrame} />
      <p className="faint" style={{ fontSize: 11, margin: 0 }}>
        Colors are exported in sRGB. Existing files are never overwritten.
      </p>
    </Dialog>
  );
}

/**
 * The selection for the marble, most recently selected first (the active photo
 * leads; the selection keeps the order photos were added in).
 */
function photoPreviews(chosen: readonly string[]): ExportPreview[] {
  const active = ui.getState().activeId;
  const order = [...chosen].reverse();
  if (active && order.includes(active)) {
    order.splice(order.indexOf(active), 1);
    order.unshift(active);
  }
  return order.slice(0, 5).flatMap((id) => {
    const asset = getAsset(id);
    if (!asset) return [];
    return [{ key: `${asset.id}:${asset.thumbRevision ?? 0}`, load: () => loadImageUrl(asset.id, "thumb", asset.thumbRevision ?? -1) }];
  });
}
