import { useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { getDocument } from "@/core/catalog/db";
import { sanitizeDocument } from "@/core/document/operations";
import { composite } from "@/core/document/session";
import { type Destination, describeDestination, ExportSink } from "@/core/export/destination";
import { rememberedWatermark, rememberWatermark, type Watermark } from "@/core/export/watermark";
import { DestinationPicker, initialDestination, ProgressBar, WatermarkEditor } from "@/features/export/ExportParts";
import { type DocExport, exportDocument } from "./actions";

let remembered: DocExport = { format: "png", scale: 1, quality: 0.92, background: "#ffffff" };
const extension = (f: DocExport["format"]) => (f === "jpeg" ? "jpg" : f);

/** Exports the open composition, or several saved ones, with destination and watermark. */
export function ExportDocumentDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const documents = useStore(composite, (s) => s.documents);
  const [o, setO] = useState<DocExport>(remembered);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(doc ? [doc.id] : []));
  const [destination, setDestination] = useState<Destination>(initialDestination);
  const [watermark, setWatermark] = useState<Watermark>(rememberedWatermark);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const cancelled = useRef(false);

  // Saved thumbnails for the checklist and the watermark preview.
  useEffect(() => {
    const urls: string[] = [];
    let live = true;
    void (async () => {
      for (const d of documents) {
        const record = await getDocument(d.id);
        if (!live || !record?.thumb) continue;
        const url = URL.createObjectURL(record.thumb);
        urls.push(url);
        setThumbs((t) => ({ ...t, [d.id]: url }));
      }
    })();
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [documents]);

  if (!doc) return null;
  const ids = [doc.id, ...documents.map((d) => d.id).filter((id) => id !== doc.id)];
  const names = new Map(documents.map((d) => [d.id, d.name]));
  names.set(doc.id, doc.name);
  const chosen = ids.filter((id) => selected.has(id));
  const busy = !!progress;

  const run = async () => {
    remembered = o;
    rememberWatermark(watermark);
    cancelled.current = false;
    const sink = new ExportSink(destination, `Focused compositions (${chosen.length}).zip`);
    let done = 0;
    try {
      for (const [i, id] of chosen.entries()) {
        if (cancelled.current) break;
        const name = names.get(id) ?? "Composition";
        setProgress({ done: i, total: chosen.length, label: `Rendering ${i + 1} of ${chosen.length} · ${name}` });
        try {
          const target = id === doc.id ? doc : sanitizeDocument((await getDocument(id))?.data);
          const blob = await exportDocument(target, o, watermark);
          await sink.add(`${name}.${extension(o.format)}`, blob);
          done++;
        } catch (error) {
          toast(`${name}: ${error instanceof Error ? error.message : error}`, "error");
        }
      }
      setProgress({ done: chosen.length, total: chosen.length, label: destination.kind === "zip" ? "Packing the ZIP…" : "Finishing…" });
      await sink.finish();
      if (done) toast(`Exported ${done} composition${done === 1 ? "" : "s"} to ${describeDestination(destination)}.`);
      onClose();
    } catch (error) {
      toast(`Export failed: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setProgress(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      wide
      title={chosen.length === 1 ? `Export “${names.get(chosen[0])}”` : `Export ${chosen.length} compositions`}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="dim num" style={{ marginRight: "auto" }}>
            {chosen.length === 1 && chosen[0] === doc.id ? `${Math.round(doc.width * o.scale)} × ${Math.round(doc.height * o.scale)} px` : `${Math.round(o.scale * 100)}% of each canvas`}
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
          <button type="button" className="btn primary" disabled={busy || !chosen.length} onClick={() => void run()}>
            Export{chosen.length > 1 ? ` ${chosen.length}` : ""}
          </button>
        </>
      }
    >
      {progress && <ProgressBar {...progress} />}
      {ids.length > 1 && (
        <div className="field">
          <span>Compositions · {chosen.length} of {ids.length}</span>
          <div className="export-list">
            {ids.map((id) => (
              <label key={id}>
                <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
                {thumbs[id] ? <img src={thumbs[id]} alt="" /> : <span className="ph" />}
                <span className="name">
                  {names.get(id)}
                  {id === doc.id ? " (open)" : ""}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Format</span>
          <select className="input" value={o.format} onChange={(e) => setO({ ...o, format: e.target.value as DocExport["format"] })}>
            <option value="png">PNG (keeps transparency)</option>
            <option value="webp">WebP (keeps transparency)</option>
            <option value="jpeg">JPEG</option>
          </select>
        </label>
        <label className="field" style={{ width: 190 }}>
          <span>Size</span>
          <select className="input" value={o.scale} onChange={(e) => setO({ ...o, scale: Number(e.target.value) })}>
            {[0.25, 0.5, 1, 1.5, 2, 3, 4].map((s) => (
              <option key={s} value={s} disabled={Math.max(doc.width, doc.height) * s > 8192}>
                {s * 100}% · {Math.round(doc.width * s)} × {Math.round(doc.height * s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {o.format !== "png" && (
        <label className="field">
          <span>Quality {Math.round(o.quality * 100)}</span>
          <input type="range" min={40} max={100} value={Math.round(o.quality * 100)} onChange={(e) => setO({ ...o, quality: Number(e.target.value) / 100 })} />
        </label>
      )}
      {o.format === "jpeg" && (
        <label className="row">
          Background for transparent areas <input type="color" value={o.background} onChange={(e) => setO({ ...o, background: e.target.value })} />
        </label>
      )}
      <DestinationPicker count={chosen.length} value={destination} onChange={setDestination} />
      <WatermarkEditor value={watermark} onChange={setWatermark} previewUrl={thumbs[chosen[0] ?? doc.id] ?? null} />
    </Dialog>
  );
}
