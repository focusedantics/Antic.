/**
 * Text watermark stamped onto exports. Sizes are relative to the image's short
 * side, so the same settings look the same on a 1080 px post and a 6000 px print.
 */
export type WatermarkPosition = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right" | "tile";

export type Watermark = {
  readonly enabled: boolean;
  readonly text: string;
  readonly font: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Text height as a percentage of the image's short side. */
  readonly size: number;
  /** 0..1 */
  readonly opacity: number;
  readonly color: string;
  readonly shadow: boolean;
  readonly position: WatermarkPosition;
  /** Distance from the edges, percentage of the short side. */
  readonly margin: number;
};

export const WATERMARK_FONTS: { id: string; label: string; css: string }[] = [
  { id: "sans", label: "Sans (system)", css: 'Inter, "Helvetica Neue", Arial, system-ui, sans-serif' },
  { id: "serif", label: "Serif", css: 'Georgia, "Times New Roman", serif' },
  { id: "mono", label: "Monospace", css: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
  { id: "condensed", label: "Condensed", css: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif' },
  { id: "display", label: "Display", css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  { id: "script", label: "Script", css: '"Brush Script MT", "Segoe Script", "Snell Roundhand", cursive' },
  { id: "rounded", label: "Rounded", css: '"Arial Rounded MT Bold", "Nunito", "Varela Round", system-ui, sans-serif' },
  { id: "montserrat", label: "Montserrat", css: "Montserrat, sans-serif" },
  { id: "playfair", label: "Playfair Display", css: "'Playfair Display', Georgia, serif" },
  { id: "bebas", label: "Bebas Neue", css: "'Bebas Neue', Impact, sans-serif" },
  { id: "caveat", label: "Caveat (handwritten)", css: "Caveat, cursive" },
  { id: "pacifico", label: "Pacifico", css: "Pacifico, cursive" },
  { id: "space-mono", label: "Space Mono", css: "'Space Mono', monospace" },
];

/** The CSS font shorthand a watermark draws with at `px` size (also used to preload it). */
export function watermarkFont(w: Pick<Watermark, "font" | "bold" | "italic">, px = 32) {
  const css = WATERMARK_FONTS.find((f) => f.id === w.font)?.css ?? WATERMARK_FONTS[0].css;
  return `${w.italic ? "italic " : ""}${w.bold ? "700" : "400"} ${px}px ${css}`;
}

export const WATERMARK_POSITIONS: WatermarkPosition[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];

export const defaultWatermark: Watermark = {
  enabled: false,
  text: "© Your Name",
  font: "sans",
  bold: true,
  italic: false,
  size: 4,
  opacity: 0.6,
  color: "#ffffff",
  shadow: true,
  position: "bottom-right",
  margin: 3,
};

const num = (v: unknown, f: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : f);

export function sanitizeWatermark(v: unknown): Watermark {
  const w = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    enabled: w.enabled === true,
    text: typeof w.text === "string" ? w.text.slice(0, 120) : defaultWatermark.text,
    font: WATERMARK_FONTS.some((f) => f.id === w.font) ? (w.font as string) : defaultWatermark.font,
    bold: typeof w.bold === "boolean" ? w.bold : defaultWatermark.bold,
    italic: w.italic === true,
    size: num(w.size, defaultWatermark.size, 0.5, 30),
    opacity: num(w.opacity, defaultWatermark.opacity, 0, 1),
    color: typeof w.color === "string" && /^#[0-9a-f]{6}$/i.test(w.color) ? w.color : defaultWatermark.color,
    shadow: typeof w.shadow === "boolean" ? w.shadow : defaultWatermark.shadow,
    position: [...WATERMARK_POSITIONS, "tile"].includes(w.position as WatermarkPosition) ? (w.position as WatermarkPosition) : defaultWatermark.position,
    margin: num(w.margin, defaultWatermark.margin, 0, 25),
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws the watermark onto a 2D context covering a width × height image. */
export function drawWatermark(ctx: Ctx, width: number, height: number, w: Watermark) {
  if (!w.enabled || !w.text.trim() || w.opacity <= 0) return;
  const short = Math.min(width, height);
  const px = Math.max(6, (w.size / 100) * short);
  const margin = (w.margin / 100) * short;
  ctx.save();
  ctx.globalAlpha = w.opacity;
  ctx.fillStyle = w.color;
  ctx.font = watermarkFont(w, px);
  if (w.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = px * 0.25;
    ctx.shadowOffsetY = px * 0.05;
  }
  if (w.position === "tile") {
    // Diagonal rows repeated across the frame.
    const textWidth = ctx.measureText(w.text).width;
    const stepX = textWidth + px * 3;
    const stepY = px * 4;
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-Math.PI / 6);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const reach = Math.hypot(width, height) / 2 + stepX;
    for (let y = -reach, row = 0; y <= reach; y += stepY, row++)
      for (let x = -reach + (row % 2) * (stepX / 2); x <= reach; x += stepX) ctx.fillText(w.text, x, y);
    ctx.restore();
    return;
  }
  const [v, h] = w.position === "center" ? ["middle", "center"] : w.position === "left" || w.position === "right" ? ["middle", w.position] : w.position.split("-").length === 2 ? w.position.split("-") : [w.position, "center"];
  const x = h === "left" ? margin : h === "right" ? width - margin : width / 2;
  const y = v === "top" ? margin : v === "bottom" ? height - margin : height / 2;
  ctx.textAlign = h === "left" ? "left" : h === "right" ? "right" : "center";
  ctx.textBaseline = v === "top" ? "top" : v === "bottom" ? "bottom" : "middle";
  ctx.fillText(w.text, x, y);
  ctx.restore();
}

const KEY = "export-watermark";
/** The last used watermark (a per-browser convenience). */
export function rememberedWatermark(): Watermark {
  try {
    return sanitizeWatermark(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return defaultWatermark;
  }
}
export function rememberWatermark(w: Watermark) {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    // Storage unavailable: the setting just isn't remembered.
  }
}
