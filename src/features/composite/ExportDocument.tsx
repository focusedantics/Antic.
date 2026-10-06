import { device } from "@/lib/device";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { getDocument } from "@/core/catalog/db";
import { docAnimation, isAnimated, loopFrames } from "@/core/document/animation";
import { sanitizeDocument } from "@/core/document/operations";
import { sliceDocument, slideCount } from "@/core/document/carousel";
import type { CompositeDocument } from "@/core/document/model";
import { composite } from "@/core/document/session";
import { type Destination, describeDestination, ExportSink } from "@/core/export/destination";
import { type ExportFrame, frameLayout, rememberedFrame, rememberFrame } from "@/core/export/frame";
import { rememberedWatermark, rememberWatermark, type Watermark } from "@/core/export/watermark";
import { DestinationPicker, ExportHero, type ExportPreview, initialDestination, WatermarkEditor } from "@/features/export/ExportParts";
import type { MarbleMood } from "@/features/export/marble";
import { holdAtLeast, nextPaint, PACE, sleep } from "@/lib/pacing";
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
  const [frame, setFrame] = useState<ExportFrame>(rememberedFrame);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [item, setItem] = useState(0);
  const [mood, setMood] = useState<MarbleMood>("idle");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const cancelled = useRef<AbortController | null>(null);
  // Carousels: every slide as its own image, chosen slides, or the whole strip as one.
  const [part, setPart] = useState<"each" | "pick" | "whole">("each");
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(Array.from({ length: doc ? slideCount(doc) : 1 }, (_, i) => i)));

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
  const slides = slideCount(doc);
  const pickedSlides = [...picked].filter((i) => i < slides).sort((a, b) => a - b);
  /** The images one document makes: a carousel's slides (as chosen) or the whole canvas. */
  const partsOf = (d: CompositeDocument, name: string): { name: string; doc: CompositeDocument }[] => {
    const n = slideCount(d);
    if (n < 2 || part === "whole") return [{ name, doc: d }];
    const which = part === "pick" && d.id === doc.id ? pickedSlides : Array.from({ length: n }, (_, i) => i);
    const pad = (i: number) => String(i + 1).padStart(String(n).length, "0");
    return which.map((i) => ({ name: `${name} ${pad(i)} of ${n}`, doc: sliceDocument(d, i) }));
  };
  const openParts = partsOf(doc, doc.name).length;
  const imageCount = chosen.reduce((sum, id) => sum + (id === doc.id ? openParts : 1), 0);
  const busy = !!progress;
  const animated = isAnimated(doc);
  const animation = docAnimation(doc);
  const moving = ANIMATED_FORMATS.has(o.format);
  // The frame can make the file bigger than the canvas.
  // What one image is: a slide, or the whole canvas.
  const sizing = slides > 1 && part !== "whole" ? sliceDocument(doc, 0) : doc;
  const canvasSize = exportSize(sizing, o);
  const size = frameLayout(canvasSize.width, canvasSize.height, frame);

  const run = async () => {
    remembered = o;
    rememberWatermark(watermark);
    rememberFrame(frame);
    const controller = new AbortController();
    cancelled.current = controller;
    const sink = new ExportSink(destination, chosen.length === 1 ? `${names.get(chosen[0]) ?? "Focused"}.zip` : `Focused compositions (${chosen.length}).zip`);
    let done = 0;
    let total = imageCount;
    const started = performance.now();
    setMood("working");
    setItem(1);
    setProgress({ done: 0, total: imageCount, label: "Starting…" });
    await nextPaint();
    try {
      // Every image to make: documents, or a carousel's slides.
      const jobs: { name: string; doc: () => Promise<CompositeDocument> }[] = [];
      for (const id of chosen) {
        const name = names.get(id) ?? "Composition";
        if (id === doc.id) for (const p of partsOf(doc, name)) jobs.push({ name: p.name, doc: async () => p.doc });
        else {
          const d = sanitizeDocument((await getDocument(id))?.data);
          for (const p of partsOf(d, name)) jobs.push({ name: p.name, doc: async () => p.doc });
        }
      }
      total = jobs.length;
      for (const [i, job] of jobs.entries()) {
        if (controller.signal.aborted) break;
        const prefix = jobs.length > 1 ? `${i + 1} of ${jobs.length} · ${job.name} · ` : "";
        setProgress({ done: i, total: jobs.length, label: `${prefix}Rendering…` });
        setItem(i + 1);
        try {
          const blob = await exportDocument(await job.doc(), o, watermark, (fraction, stage) => setProgress({ done: i + fraction, total: jobs.length, label: `${prefix}${stage}` }), controller.signal, frame);
          await sink.add(`${job.name}.${extension(o.format)}`, blob);
          done++;
        } catch (error) {
          if (controller.signal.aborted) break;
          toast(`${job.name}: ${error instanceof Error ? error.message : error}`, "error");
        }
      }
      setProgress({ done: total, total, label: destination.kind === "zip" ? "Packing the ZIP…" : "Finishing…" });
      await sink.finish();
      await holdAtLeast(started);
      if (done) {
        setMood("done");
        setProgress({ done: total, total, label: `Saved ${done} image${done === 1 ? "" : "s"} ✓` });
        await sleep(PACE.doneBeat);
        toast(`Exported ${done} image${done === 1 ? "" : "s"} to ${describeDestination(destination)}.`);
      }
      if (!controller.signal.aborted) onClose();
    } catch (error) {
      toast(`Export failed: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setProgress(null);
      setMood("idle");
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
          <button type="button" className="btn primary" disabled={busy || !chosen.length || !imageCount} onClick={() => void run()}>
            Export{imageCount > 1 ? ` ${imageCount}` : ""}
          </button>
        </>
      }
    >
      <ExportHero
        previews={compositionPreviews(chosen, doc.id, thumbs)}
        count={chosen.length}
        mood={mood}
        progress={progress}
        current={item}
        title={chosen.length === 1 ? (names.get(chosen[0]) ?? "Composition") : `${chosen.length} compositions`}
        details={`${o.format.toUpperCase()}${chosen.length === 1 && chosen[0] === doc.id ? ` · ${size.width} × ${size.height} px` : ""}`}
      />
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
      {slides > 1 && selected.has(doc.id) && (
        <div className="field" role="radiogroup" aria-label="Carousel">
          <span>Carousel · {slides} slides</span>
          <label className="check">
            <input type="radio" name="carousel-part" checked={part === "each"} onChange={() => setPart("each")} /> Every slide, as {slides} images (in order, for posting)
          </label>
          <label className="check">
            <input type="radio" name="carousel-part" checked={part === "pick"} onChange={() => setPart("pick")} /> Chosen slides
          </label>
          {part === "pick" && (
            <div className="row wrap" role="group" aria-label="Slides to export" style={{ paddingLeft: 22 }}>
              {Array.from({ length: slides }, (_, i) => (
                <label key={i} className="check">
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  />
                  {i + 1}
                </label>
              ))}
            </div>
          )}
          <label className="check">
            <input type="radio" name="carousel-part" checked={part === "whole"} onChange={() => setPart("whole")} /> The whole carousel as one wide image
          </label>
        </div>
      )}
      <div className="row">
        <label className="field" style={{ flex: "1 1 0", minWidth: 0 }}>
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
        <label className="field" style={{ flex: "0 1 190px", minWidth: 0 }}>
          <span>Size</span>
          <select className="input" value={o.scale} onChange={(e) => setO({ ...o, scale: Number(e.target.value) })}>
            {[0.25, 0.5, 1, 1.5, 2, 3, 4].map((s) => (
              <option key={s} value={s} disabled={Math.max(sizing.width, sizing.height) * s > 8192}>
                {s * 100}% · {exportSize(sizing, { format: o.format, scale: s }).width} × {exportSize(sizing, { format: o.format, scale: s }).height}
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
      {device.lite && o.format !== "gif" && (
        <p className="dim" data-testid="device-cap">
          On this device compositions export at up to {o.format === "mp4" ? Math.min(3840, device.maxSide) : device.maxSide} px on the long side, so the browser has the memory to finish.
        </p>
      )}
      {moving && animated && (
        <p className="dim">
          One seamless {animation.duration} s loop at {animation.fps} fps (change it in the Loop settings of an animated effect or text layer).
          {o.format === "gif" && canvasSize.scale < o.scale ? " GIFs are limited to 1600 px on the long side." : ""}
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
      <DestinationPicker count={imageCount} value={destination} onChange={setDestination} />
      <WatermarkEditor value={watermark} onChange={setWatermark} previewUrl={thumbs[chosen[0] ?? doc.id] ?? null} frame={frame} onFrame={setFrame} />
    </Dialog>
  );
}

/**
 * Saved thumbnails for the marble, the open composition first. They are rendered
 * at time 0, so an animated composition shows the first frame of its GIF or MP4.
 */
function compositionPreviews(chosen: readonly string[], openId: string, thumbs: Record<string, string>): ExportPreview[] {
  const order = [...chosen].reverse();
  if (order.includes(openId)) {
    order.splice(order.indexOf(openId), 1);
    order.unshift(openId);
  }
  return order
    .filter((id) => thumbs[id])
    .slice(0, 5)
    .map((id) => ({ key: thumbs[id], load: async () => thumbs[id] }));
}
