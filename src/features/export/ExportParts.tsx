import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Slider } from "@/components/Slider";
import { canChooseFolder, chooseFolder, type Destination, describeDestination } from "@/core/export/destination";
import { composeExport, type ExportFrame, FRAME_STYLES, type FramePlacement, type FrameStyle } from "@/core/export/frame";
import { type Watermark, WATERMARK_FONTS, WATERMARK_POSITIONS, type WatermarkPosition, watermarkFont } from "@/core/export/watermark";
import { ensureFont, fontLoads } from "@/core/text/fonts";
import { Marble, type MarbleMood, previewBitmap } from "./marble";

/** A picture for the marble: `load` runs again whenever `key` changes. */
export type ExportPreview = { readonly key: string; readonly load: () => Promise<Blob | ImageBitmap | string | null> };

/** The marble cycles through at most this many pictures (the most recently selected), for speed. */
export const MARBLE_PREVIEWS = 5;
/** Time each picture stays up while the marble cycles during an export. */
const CYCLE_MS = 1600;
const REDUCE = "(prefers-reduced-motion: reduce)";

/**
 * A glass marble with a small preview floating inside. `previews` are most recent
 * first: the first one shows while you choose settings; while `cycle` is on (an
 * export is running) it crossfades through up to five of them. `badge` is the
 * counter on the marble (how many items, or which one is rendering).
 * Drag to spin it, click to change its colour. Decorative: text nearby carries the information.
 */
export function ExportMarble({
  previews,
  mood = "working",
  cycle = false,
  badge,
  className,
}: {
  previews: readonly ExportPreview[];
  mood?: MarbleMood;
  cycle?: boolean;
  badge?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const marble = useRef<Marble | null>(null);
  const bitmaps = useRef(new Map<string, ImageBitmap>());
  const shown = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);
  const list = previews.slice(0, MARBLE_PREVIEWS);
  const keys = list.map((p) => p.key).join("|");

  useEffect(() => {
    const m = new Marble(host.current!, { reducedMotion: window.matchMedia(REDUCE).matches });
    if (!m.ready) setFailed(true);
    marble.current = m;
    const cache = bitmaps.current;
    return () => {
      m.dispose();
      marble.current = null;
      for (const b of cache.values()) b.close();
      cache.clear();
    };
  }, []);
  useEffect(() => marble.current?.setMood(mood), [mood]);

  // Load the small bitmaps (kept for cycling; at most five of 192 px each).
  useEffect(() => {
    let live = true;
    const wanted = new Set(list.map((p) => p.key));
    for (const [k, b] of bitmaps.current)
      if (!wanted.has(k)) {
        b.close();
        bitmaps.current.delete(k);
      }
    for (const p of list) {
      if (bitmaps.current.has(p.key)) continue;
      void p
        .load()
        .then((source) => (source ? previewBitmap(source) : null))
        .then((bitmap) => {
          if (!bitmap) return;
          if (!live || bitmaps.current.has(p.key)) return bitmap.close();
          bitmaps.current.set(p.key, bitmap);
          setLoaded((n) => n + 1);
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // `load` closures are new each render; the keys say when the pictures changed.
  }, [keys]);

  // Show the most recent picture, or cycle through them while exporting.
  useEffect(() => {
    const ready = list.map((p) => p.key).filter((k) => bitmaps.current.has(k));
    const show = (k: string | undefined) => {
      if (!k || k === shown.current) return;
      shown.current = k;
      marble.current?.setPreview(bitmaps.current.get(k) ?? null);
    };
    if (!ready.length) {
      if (!list.length) {
        shown.current = null;
        marble.current?.setPreview(null);
      }
      return;
    }
    if (!cycle || ready.length < 2) {
      show(ready[0]);
      return;
    }
    let i = Math.max(0, ready.indexOf(shown.current ?? ""));
    show(ready[i]);
    const timer = setInterval(() => {
      i = (i + 1) % ready.length;
      show(ready[i]);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [keys, cycle, loaded]);

  if (failed) return null;
  return (
    <div
      ref={host}
      className={`export-marble${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      data-testid="export-marble"
      data-mood={mood}
      data-preview={list[0]?.key}
      data-count={badge}
      title="Drag to spin · click to change color"
    >
      {badge && <span className="marble-count num">{badge}</span>}
    </div>
  );
}

/**
 * The top of every export dialog: the marble holding the selection (counter when
 * there are several) and, beside it, either what will be exported or the progress.
 */
export function ExportHero({
  previews,
  count,
  mood,
  progress,
  current,
  title,
  details,
}: {
  previews: readonly ExportPreview[];
  count: number;
  mood: MarbleMood;
  progress: { done: number; total: number; label: string } | null;
  /** 1-based item being exported, for the counter. */
  current?: number;
  title: ReactNode;
  details?: ReactNode;
}) {
  const badge = count > 1 ? (mood === "working" && current ? `${Math.min(current, count)}/${count}` : String(count)) : undefined;
  return (
    <div className="export-hero">
      <ExportMarble previews={previews} mood={mood} cycle={mood === "working"} badge={badge} />
      <div className="export-hero-text">
        {progress ? (
          <ProgressBar {...progress} />
        ) : (
          <>
            <strong>{title}</strong>
            {details && <span className="dim num">{details}</span>}
            <span className="faint">Drag the marble to spin it.</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The export progress line. With `preview` (even null) it shows the marble above
 * the bar; dialogs that keep their own marble on screen leave it out.
 */
export function ProgressBar({ done, total, label, preview, mood }: { done: number; total: number; label: string; preview?: ExportPreview | null; mood?: MarbleMood }) {
  const pct = Math.min(100, Math.round((done / Math.max(1, total)) * 100));
  return (
    <div className="export-progress-block" role="status" aria-live="polite">
      {preview !== undefined && <ExportMarble previews={preview ? [preview] : []} mood={mood} />}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="dim">{label}</span>
        <span className="num dim">{pct}%</span>
      </div>
      <div className="export-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

let lastDestination: Destination = { kind: "download" };

/** Downloads, one ZIP, or a folder on this computer. */
export function DestinationPicker({ count, value, onChange }: { count: number; value: Destination; onChange: (d: Destination) => void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (kind: Destination["kind"]) => {
    try {
      setBusy(true);
      let next: Destination;
      if (kind === "folder") next = await chooseFolder();
      else next = { kind };
      lastDestination = next;
      onChange(next);
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="field">
      <span>Save to</span>
      <select className="input" value={value.kind} disabled={busy} onChange={(e) => void pick(e.target.value as Destination["kind"])} aria-label="Export destination">
        <option value="download">Downloads{count > 1 ? " (one file each)" : ""}</option>
        <option value="zip">Downloads, as one ZIP file</option>
        <option value="folder" disabled={!canChooseFolder()}>
          {value.kind === "folder" ? `Folder: ${value.name}` : "A folder on this computer…"}
          {!canChooseFolder() ? " (Chrome or Edge)" : ""}
        </option>
      </select>
      {busy && <span className="faint">Waiting for you to choose…</span>}
      {!busy && value.kind !== "download" && <span className="faint">Saving to {describeDestination(value)}.</span>}
    </label>
  );
}

export const initialDestination = (): Destination => (lastDestination.kind === "folder" ? lastDestination : { kind: "download" });

const positionLabels: Record<WatermarkPosition, string> = {
  "top-left": "↖",
  top: "↑",
  "top-right": "↗",
  left: "←",
  center: "•",
  right: "→",
  "bottom-left": "↙",
  bottom: "↓",
  "bottom-right": "↘",
  tile: "Tiled",
};

/** Watermark controls with a live preview on `previewUrl`. */
/** What a destination can frame with: video only takes solid frames over the picture's edges. */
export type FrameOptions = { readonly styles: readonly FrameStyle[]; readonly placements: readonly FramePlacement[]; readonly note?: string };
const ALL_FRAMES: FrameOptions = { styles: ["glass", "solid", "polaroid"], placements: ["inside", "around"] };

/**
 * The watermark and the frame, with one live preview of both on the first
 * picture (drawn by the same `composeExport` the export uses).
 */
export function WatermarkEditor({
  value,
  onChange,
  previewUrl,
  frame,
  onFrame,
  frameOptions = ALL_FRAMES,
}: {
  value: Watermark;
  onChange: (w: Watermark) => void;
  previewUrl?: string | null;
  frame?: ExportFrame;
  onFrame?: (f: ExportFrame) => void;
  frameOptions?: FrameOptions;
}) {
  const set = (patch: Partial<Watermark>) => onChange({ ...value, ...patch });
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!previewUrl) return setImage(null);
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = previewUrl;
  }, [previewUrl]);
  const fontGeneration = useStore(fontLoads, (f) => f.generation);
  const framing = !!frame?.enabled;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !(value.enabled || framing)) return;
    const w = image?.naturalWidth || 3;
    const h = image?.naturalHeight || 2;
    // The picture at preview size, then exactly what the export does to it.
    const scale = Math.min(420 / w, 190 / h);
    const base = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
    const bctx = base.getContext("2d")!;
    bctx.fillStyle = "#444";
    bctx.fillRect(0, 0, base.width, base.height);
    if (image) bctx.drawImage(image, 0, 0, base.width, base.height);
    if (value.enabled) ensureFont(watermarkFont(value));
    const done = composeExport(base, frame, value);
    c.width = done.width;
    c.height = done.height;
    c.getContext("2d")!.drawImage(done, 0, 0);
  }, [image, value, frame, framing, fontGeneration]);
  return (
    <div className="watermark-editor">
      {(value.enabled || framing) && <canvas ref={canvas} className="watermark-preview" aria-label="Watermark and frame preview" />}
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Add a watermark
      </label>
      {value.enabled && (
        <>
          <label className="field">
            <span>Text</span>
            <input className="input" value={value.text} maxLength={120} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              <span>Font</span>
              <select className="input" value={value.font} onChange={(e) => set({ font: e.target.value })} aria-label="Watermark font">
                {WATERMARK_FONTS.map((f) => (
                  <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="segmented" role="group" aria-label="Style" style={{ alignSelf: "flex-end" }}>
              <button type="button" aria-pressed={value.bold} onClick={() => set({ bold: !value.bold })} style={{ fontWeight: 700 }}>
                B
              </button>
              <button type="button" aria-pressed={value.italic} onClick={() => set({ italic: !value.italic })} style={{ fontStyle: "italic" }}>
                I
              </button>
            </div>
            <label className="field" style={{ alignSelf: "flex-end" }}>
              <input type="color" value={value.color} onChange={(e) => set({ color: e.target.value })} aria-label="Watermark color" />
            </label>
          </div>
          <Slider label="Size" value={value.size} min={0.5} max={20} step={0.1} defaultValue={4} origin={0.5} format={(v) => `${v.toFixed(1)}%`} onChange={(v) => set({ size: v })} />
          <Slider label="Opacity" value={Math.round(value.opacity * 100)} min={0} max={100} defaultValue={60} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ opacity: v / 100 })} />
          {value.position !== "tile" && <Slider label="Margin" value={value.margin} min={0} max={20} step={0.5} defaultValue={3} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ margin: v })} />}
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="field">
              <span>Position</span>
              <div className="position-grid" role="group" aria-label="Watermark position">
                {WATERMARK_POSITIONS.map((p) => (
                  <button key={p} type="button" aria-pressed={value.position === p} aria-label={p.replace("-", " ")} onClick={() => set({ position: p })}>
                    {positionLabels[p]}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ gap: 6 }}>
              <span>&nbsp;</span>
              <button type="button" className="btn small" aria-pressed={value.position === "tile"} onClick={() => set({ position: "tile" })}>
                Tiled
              </button>
              <label className="check">
                <input type="checkbox" checked={value.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Shadow
              </label>
            </div>
          </div>
        </>
      )}
      {frame && onFrame && <FrameControls value={frame} onChange={onFrame} options={frameOptions} />}
    </div>
  );
}

/** The frame part of the watermark section. */
function FrameControls({ value, onChange, options }: { value: ExportFrame; onChange: (f: ExportFrame) => void; options: FrameOptions }) {
  const set = (patch: Partial<ExportFrame>) => onChange({ ...value, ...patch });
  const glass = value.style === "glass";
  const styles = FRAME_STYLES.filter((f) => options.styles.includes(f.id));
  const placements = value.style === "polaroid" ? [] : options.placements;
  return (
    <>
      <label className="check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Frame the image
      </label>
      {value.enabled && (
        <>
          <div className="row wrap">
            {styles.length > 1 && (
              <div className="segmented" role="group" aria-label="Frame style">
                {styles.map((f) => (
                  <button key={f.id} type="button" aria-pressed={value.style === f.id} onClick={() => set({ style: f.id })}>
                    {f.label}
                  </button>
                ))}
              </div>
            )}
            {placements.length > 1 && (
              <div className="segmented" role="group" aria-label="Frame placement">
                <button type="button" aria-pressed={value.placement === "inside"} title="Over the image's edges; the size stays the same" onClick={() => set({ placement: "inside" })}>
                  Inside
                </button>
                <button type="button" aria-pressed={value.placement === "around"} title="Around the image; the file grows by the frame" onClick={() => set({ placement: "around" })}>
                  Around
                </button>
              </div>
            )}
            <label className="field" style={{ alignSelf: "flex-end" }}>
              <input type="color" value={value.color} onChange={(e) => set({ color: e.target.value })} aria-label={glass ? "Glass tint" : "Frame color"} title={glass ? "Glass tint" : "Frame color"} />
            </label>
          </div>
          <Slider label="Frame width" value={value.width} min={0.5} max={20} step={0.1} defaultValue={4} origin={0.5} format={(v) => `${v.toFixed(1)}%`} onChange={(v) => set({ width: v })} />
          <Slider label="Corners" value={Math.round(value.roundness * 100)} min={0} max={100} defaultValue={60} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ roundness: v / 100 })} />
          {glass && (
            <>
              <Slider label="Tint" value={Math.round(value.tint * 100)} min={0} max={100} defaultValue={30} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ tint: v / 100 })} />
              <Slider label="Frost" value={Math.round(value.frost * 100)} min={0} max={100} defaultValue={50} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ frost: v / 100 })} />
              <Slider label="Rim light" value={Math.round(value.rim * 100)} min={0} max={100} defaultValue={70} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ rim: v / 100 })} />
            </>
          )}
          <Slider label="Frame shadow" value={Math.round(value.shadow * 100)} min={0} max={100} defaultValue={35} origin={0} format={(v) => `${v}%`} onChange={(v) => set({ shadow: v / 100 })} />
          {options.note && <p className="faint" style={{ fontSize: 10, margin: 0 }}>{options.note}</p>}
        </>
      )}
    </>
  );
}
