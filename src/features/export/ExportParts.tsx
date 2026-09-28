import { useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Slider } from "@/components/Slider";
import { canChooseFolder, chooseFolder, type Destination, describeDestination } from "@/core/export/destination";
import { drawWatermark, type Watermark, WATERMARK_FONTS, WATERMARK_POSITIONS, type WatermarkPosition, watermarkFont } from "@/core/export/watermark";
import { ensureFont, fontLoads } from "@/core/text/fonts";

export function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = Math.min(100, Math.round((done / Math.max(1, total)) * 100));
  return (
    <div className="export-progress-block" role="status" aria-live="polite">
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
export function WatermarkEditor({ value, onChange, previewUrl }: { value: Watermark; onChange: (w: Watermark) => void; previewUrl?: string | null }) {
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
  useEffect(() => {
    const c = canvas.current;
    if (!c || !value.enabled) return;
    const w = image?.naturalWidth || 3;
    const h = image?.naturalHeight || 2;
    const scale = Math.min(460 / w, 200 / h);
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#444";
    ctx.fillRect(0, 0, c.width, c.height);
    if (image) ctx.drawImage(image, 0, 0, c.width, c.height);
    ensureFont(watermarkFont(value));
    drawWatermark(ctx, c.width, c.height, value);
  }, [image, value, fontGeneration]);
  return (
    <div className="watermark-editor">
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Add a watermark
      </label>
      {value.enabled && (
        <>
          <canvas ref={canvas} className="watermark-preview" aria-label="Watermark preview" />
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
    </div>
  );
}
