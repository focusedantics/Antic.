import { useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { getDocument } from "@/core/catalog/db";
import { docAnimation, isAnimated, loopFrames } from "@/core/document/animation";
import { sanitizeDocument } from "@/core/document/operations";
import { composite } from "@/core/document/session";
import { type Destination, describeDestination, ExportSink } from "@/core/export/destination";
import { rememberedWatermark, rememberWatermark, type Watermark } from "@/core/export/watermark";
import { DestinationPicker, initialDestination, ProgressBar, WatermarkEditor } from "@/features/export/ExportParts";
import { ANIMATED_FORMATS, type DocExport, type DocFormat, exportDocument, exportSize } from "./actions";

let remembered: DocExport = { format: "png", scale: 1, quality: 0.92, background: "#ffffff", time: 0, dither: true, repeats: 3 };
const extension = (f: DocFormat) => (f === "jpeg" ? "jpg" : f);

/** Exports the open composition, or several saved ones, with destination and watermark. */
export function ExportDocumentDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const documents = useStore(composite, (s) => s.documents);
  const [o, setO] = useState<DocExport>(remembered);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(doc ? [doc.id] : []));
  const [destination, setDestination] = useState<Destination>(initialDestination);
  const [watermark, setWatermark] = useState<Watermark>(rememberedWatermark);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const cancelled = useRef<AbortController | null>(null);

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
  const animated = isAnimated(doc);
  const animation = docAnimation(doc);
  const moving = ANIMATED_FORMATS.has(o.format);
  const size = exportSize(doc, o);

  const run = async () => {
    remembered = o;
    rememberWatermark(watermark);
    const controller = new AbortController();
    cancelled.current = controller;
    const sink = new ExportSink(destination, `Focused compositions (${chosen.length}).zip`);
    let done = 0;
    try {
      for (const [i, id] of chosen.entries()) {
        if (controller.signal.aborted) break;
        const name = names.get(id) ?? "Composition";
        const prefix = chosen.length > 1 ? `${i + 1} of ${chosen.length} · ${name} · ` : "";
        setProgress({ done: i, total: chosen.length, label: `${prefix}Rendering…` });
        setCurrent(id);
        try {
          const target = id === doc.id ? doc : sanitizeDocument((await getDocument(id))?.data);
          const blob = await exportDocument(target, o, watermark, (fraction, stage) => setProgress({ done: i + fraction, total: chosen.length, label: `${prefix}${stage}` }), controller.signal);
          await sink.add(`${name}.${extension(o.format)}`, blob);
          done++;
        } catch (error) {
          if (controller.signal.aborted) break;
          toast(`${name}: ${error instanceof Error ? error.message : error}`, "error");
        }
      }
      setProgress({ done: chosen.length, total: chosen.length, label: destination.kind === "zip" ? "Packing the ZIP…" : "Finishing…" });
      await sink.finish();
      if (done) toast(`Exported ${done} composition${done === 1 ? "" : "s"} to ${describeDestination(destination)}.`);
      if (!controller.signal.aborted) onClose();
    } catch (error) {
      toast(`Export failed: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setProgress(null);
      cancelled.current = null;
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
            {chosen.length === 1 && chosen[0] === doc.id ? `${size.width} × ${size.height} px` : `${Math.round(o.scale * 100)}% of each canvas`}
            {moving && animated && chosen.length === 1 ? ` · ${loopFrames(animation).length * (o.format === "mp4" ? o.repeats : 1)} frames` : ""}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (busy) cancelled.current?.abort();
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
      {progress && (
        <ProgressBar
          {...progress}
          // The saved thumbnail is rendered at time 0: the first frame of a GIF or MP4.
          preview={current && thumbs[current] ? { key: thumbs[current], load: async () => thumbs[current] } : null}
        />
      )}
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
          <select className="input" value={o.format} onChange={(e) => setO({ ...o, format: e.target.value as DocFormat })}>
            <optgroup label="Still image">
              <option value="png">PNG (keeps transparency)</option>
              <option value="webp">WebP (keeps transparency)</option>
              <option value="jpeg">JPEG</option>
            </optgroup>
            <optgroup label={animated ? "Animated" : "Animated (add a moving effect first)"}>
              <option value="gif">GIF (animated loop)</option>
              <option value="mp4">MP4 video (animated loop)</option>
            </optgroup>
          </select>
        </label>
        <label className="field" style={{ width: 190 }}>
          <span>Size</span>
          <select className="input" value={o.scale} onChange={(e) => setO({ ...o, scale: Number(e.target.value) })}>
            {[0.25, 0.5, 1, 1.5, 2, 3, 4].map((s) => (
              <option key={s} value={s} disabled={Math.max(doc.width, doc.height) * s > 8192}>
                {s * 100}% · {exportSize(doc, { format: o.format, scale: s }).width} × {exportSize(doc, { format: o.format, scale: s }).height}
              </option>
            ))}
          </select>
        </label>
      </div>
      {moving && !animated && (
        <p className="faint">
          Nothing in this composition moves yet, so the {o.format === "gif" ? "GIF will be a single frame" : "video will be a still"}. Add an effect from the Motion or Animated
          category to animate it.
        </p>
      )}
      {moving && animated && (
        <p className="dim">
          One seamless {animation.duration} s loop at {animation.fps} fps (change it in the Loop settings of an animated effect or text layer).
          {o.format === "gif" && size.scale < o.scale ? " GIFs are limited to 1600 px on the long side." : ""}
        </p>
      )}
      {!moving && animated && (
        <label className="field">
          <span>
            Frame at {o.time.toFixed(1)} s of {animation.duration} s
          </span>
          <input type="range" min={0} max={Math.max(0, animation.duration - 1 / animation.fps)} step={1 / animation.fps} value={Math.min(o.time, animation.duration)} onChange={(e) => setO({ ...o, time: Number(e.target.value) })} />
        </label>
      )}
      {o.format === "gif" && (
        <label className="row">
          <input type="checkbox" checked={o.dither} onChange={(e) => setO({ ...o, dither: e.target.checked })} />
          Dither (smoother gradients, larger file)
        </label>
      )}
      {o.format === "mp4" && (
        <label className="field">
          <span>
            Play the loop {o.repeats} time{o.repeats === 1 ? "" : "s"} ({(animation.duration * o.repeats).toFixed(1)} s)
          </span>
          <input type="range" min={1} max={10} value={o.repeats} onChange={(e) => setO({ ...o, repeats: Number(e.target.value) })} />
        </label>
      )}
      {o.format !== "png" && o.format !== "gif" && (
        <label className="field">
          <span>Quality {Math.round(o.quality * 100)}</span>
          <input type="range" min={40} max={100} value={Math.round(o.quality * 100)} onChange={(e) => setO({ ...o, quality: Number(e.target.value) / 100 })} />
        </label>
      )}
      {(o.format === "jpeg" || moving) && (
        <label className="row">
          Background for transparent areas <input type="color" value={o.background} onChange={(e) => setO({ ...o, background: e.target.value })} />
        </label>
      )}
      <DestinationPicker count={chosen.length} value={destination} onChange={setDestination} />
      <WatermarkEditor value={watermark} onChange={setWatermark} previewUrl={thumbs[chosen[0] ?? doc.id] ?? null} />
    </Dialog>
  );
}
