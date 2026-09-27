import { useEffect, useRef } from "react";
import { useStore } from "@/app/hooks";
import { develop } from "@/core/develop/session";

/** Live histogram of the developed photo, with clipping indicators. */
export function HistogramView() {
  const histogram = useStore(develop, (s) => s.histogram);
  const clipping = useStore(develop, (s) => s.clipping);
  const source = useStore(develop, (s) => s.source);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = Math.round(canvas.clientWidth * dpr));
    const h = (canvas.height = Math.round(canvas.clientHeight * dpr));
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    if (!histogram) return;
    let peak = 1;
    // Ignore the extreme bins when scaling so a clipped spike doesn't flatten the rest.
    for (const ch of [histogram.r, histogram.g, histogram.b]) for (let i = 2; i < 254; i++) peak = Math.max(peak, ch[i]);
    const draw = (ch: Uint32Array, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, h - Math.min(1, Math.sqrt(ch[i] / peak)) * h * 0.95);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    };
    ctx.globalCompositeOperation = "lighter";
    draw(histogram.r, "rgba(210,60,60,0.75)");
    draw(histogram.g, "rgba(60,190,70,0.75)");
    draw(histogram.b, "rgba(60,100,230,0.75)");
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((i / 4) * w, 0);
      ctx.lineTo((i / 4) * w, h);
      ctx.stroke();
    }
  }, [histogram]);
  const pct = (v: number) => (v * 100 >= 0.1 ? `${(v * 100).toFixed(1)}%` : "0%");
  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
      <div style={{ position: "relative", height: 96, background: "#0d0d0d", borderRadius: 3 }}>
        <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} aria-label="Histogram" role="img" />
        <button
          type="button"
          className="btn ghost small"
          style={{ position: "absolute", top: 2, left: 2, color: (histogram?.clippedLow ?? 0) > 0.001 ? "#6aa0ff" : undefined }}
          aria-pressed={clipping}
          title={`Show clipping (J). Shadows clipped: ${pct(histogram?.clippedLow ?? 0)}`}
          onClick={() => develop.setState({ clipping: !clipping })}
        >
          ◣
        </button>
        <button
          type="button"
          className="btn ghost small"
          style={{ position: "absolute", top: 2, right: 2, color: (histogram?.clippedHigh ?? 0) > 0.001 ? "#ff6a5a" : undefined }}
          aria-pressed={clipping}
          title={`Show clipping (J). Highlights clipped: ${pct(histogram?.clippedHigh ?? 0)}`}
          onClick={() => develop.setState({ clipping: !clipping })}
        >
          ◢
        </button>
      </div>
      <div className="row faint" style={{ fontSize: 10, marginTop: 4 }}>
        <span>{source === "preview" ? "Camera preview (decoding original…)" : source === "raw" ? "RAW · linear Rec.2020" : source === "rendered" ? "Rendered file" : ""}</span>
      </div>
    </div>
  );
}
