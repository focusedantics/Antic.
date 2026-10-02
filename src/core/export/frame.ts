import { drawWatermark, type Watermark } from "./watermark";

/**
 * A frame drawn around (or over the edges of) an exported image, applied with
 * Canvas 2D at export time, like the watermark. Sizes are relative to the image's
 * short side, so a thumbnail preview and a 6000 px print look alike.
 *
 * - glass: a pane of frosted glass — the photo seen blurred and slightly magnified
 *   through it, tinted, with rim lights and a soft shadow on the photo.
 * - solid: a mat in one colour.
 * - polaroid: a solid mat around the photo with a deeper bottom edge.
 */
export type FrameStyle = "glass" | "solid" | "polaroid";
export type FramePlacement = "inside" | "around";

export type ExportFrame = {
  readonly enabled: boolean;
  readonly style: FrameStyle;
  /** inside: over the image's edges (same size); around: the image grows by the frame. */
  readonly placement: FramePlacement;
  /** Thickness, percent of the short side. */
  readonly width: number;
  /** Roundness of the inner corners, 0..1. */
  readonly roundness: number;
  /** Mat colour, or the glass tint. */
  readonly color: string;
  /** Glass: how much of the tint colour shows, 0..1. */
  readonly tint: number;
  /** Glass: blur of the photo seen through it, 0..1. */
  readonly frost: number;
  /** Glass: brightness of the edge highlights, 0..1. */
  readonly rim: number;
  /** Shadow the frame casts on the photo, 0..1. */
  readonly shadow: number;
};

export const FRAME_STYLES: { id: FrameStyle; label: string }[] = [
  { id: "glass", label: "Glass" },
  { id: "solid", label: "Solid" },
  { id: "polaroid", label: "Polaroid" },
];

export const defaultFrame: ExportFrame = {
  enabled: false,
  style: "glass",
  placement: "inside",
  width: 4,
  roundness: 0.6,
  color: "#ffffff",
  tint: 0.3,
  frost: 0.5,
  rim: 0.7,
  shadow: 0.35,
};

const num = (v: unknown, f: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : f);

export function sanitizeFrame(v: unknown): ExportFrame {
  const f = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    enabled: f.enabled === true,
    style: FRAME_STYLES.some((s) => s.id === f.style) ? (f.style as FrameStyle) : defaultFrame.style,
    placement: f.placement === "around" ? "around" : "inside",
    width: num(f.width, defaultFrame.width, 0.5, 20),
    roundness: num(f.roundness, defaultFrame.roundness, 0, 1),
    color: typeof f.color === "string" && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : defaultFrame.color,
    tint: num(f.tint, defaultFrame.tint, 0, 1),
    frost: num(f.frost, defaultFrame.frost, 0, 1),
    rim: num(f.rim, defaultFrame.rim, 0, 1),
    shadow: num(f.shadow, defaultFrame.shadow, 0, 1),
  };
}

export type FrameLayout = {
  /** Size of the finished image. */
  readonly width: number;
  readonly height: number;
  /** Where the photo sits, and the part of it the frame leaves visible. */
  readonly photo: { x: number; y: number; w: number; h: number };
  readonly inner: { x: number; y: number; w: number; h: number };
  /** Radius of the inner corners. */
  readonly radius: number;
  /** Frame thickness in pixels. */
  readonly band: number;
};

/** Geometry of a frame on a `w` × `h` image (no frame: the image itself). */
export function frameLayout(w: number, h: number, f?: ExportFrame | null): FrameLayout {
  if (!f?.enabled) return { width: w, height: h, photo: { x: 0, y: 0, w, h }, inner: { x: 0, y: 0, w, h }, radius: 0, band: 0 };
  const t = Math.max(1, Math.round((f.width / 100) * Math.min(w, h)));
  const around = f.style === "polaroid" || f.placement === "around";
  const bottom = f.style === "polaroid" ? Math.round(t * 3.2) : t;
  const inner = around ? { x: t, y: t, w, h } : { x: t, y: t, w: Math.max(1, w - 2 * t), h: Math.max(1, h - 2 * t) };
  const radius = Math.min(f.roundness * t * 1.5, Math.min(inner.w, inner.h) / 2);
  return around
    ? { width: w + 2 * t, height: h + t + bottom, photo: { x: t, y: t, w, h }, inner, radius, band: t }
    : { width: w, height: h, photo: { x: 0, y: 0, w, h }, inner, radius, band: t };
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Box = { x: number; y: number; w: number; h: number };

function roundRect(path: Path2D, b: Box, r: number) {
  if (r <= 0) path.rect(b.x, b.y, b.w, b.h);
  else path.roundRect(b.x, b.y, b.w, b.h, r);
}

/** The frame's area: the whole image minus the rounded opening. */
function bandPath(L: FrameLayout, grow = 0): Path2D {
  const p = new Path2D();
  p.rect(-grow, -grow, L.width + 2 * grow, L.height + 2 * grow);
  roundRect(p, L.inner, L.radius);
  return p;
}

function innerPath(L: FrameLayout): Path2D {
  const p = new Path2D();
  roundRect(p, L.inner, L.radius);
  return p;
}

/** A soft shadow the frame casts onto the photo, inside the opening. */
function innerShadow(ctx: Ctx, L: FrameLayout, amount: number) {
  if (amount <= 0) return;
  ctx.save();
  ctx.clip(innerPath(L));
  ctx.shadowColor = `rgba(0, 0, 0, ${0.65 * amount})`;
  ctx.shadowBlur = L.band * (0.4 + 0.8 * amount);
  ctx.shadowOffsetY = L.band * 0.08;
  ctx.fillStyle = "#000";
  ctx.fill(bandPath(L, L.band * 4), "evenodd");
  ctx.restore();
}

/** Glass: the photo blurred and magnified through the band, tinted, with rim lights. */
function glassBand(ctx: Ctx, photo: CanvasImageSource, L: FrameLayout, f: ExportFrame) {
  const t = L.band;
  ctx.save();
  ctx.clip(bandPath(L), "evenodd");
  // Refraction: what is behind the glass looks a little bigger and blurred.
  const zoom = 1.06;
  const pw = L.width * zoom;
  const ph = L.height * zoom;
  ctx.filter = `blur(${Math.max(0.5, f.frost * t * 0.7).toFixed(2)}px) saturate(1.15)`;
  ctx.drawImage(photo, (L.width - pw) / 2, (L.height - ph) / 2, pw, ph);
  ctx.filter = "none";
  ctx.globalAlpha = f.tint * 0.85;
  ctx.fillStyle = f.color;
  ctx.fillRect(0, 0, L.width, L.height);
  ctx.globalAlpha = 1;
  // A soft bright bevel along the opening, like thick glass catching the light.
  const bevel = ctx.createLinearGradient(0, 0, L.width, L.height);
  bevel.addColorStop(0, `rgba(255, 255, 255, ${0.22 * f.rim})`);
  bevel.addColorStop(1, `rgba(255, 255, 255, ${0.06 * f.rim})`);
  ctx.strokeStyle = bevel;
  ctx.lineWidth = t * 0.5;
  ctx.stroke(innerPath(L));
  ctx.restore();
  innerShadow(ctx, L, f.shadow);
  // Rim lights: the inner edge lit from the top left, the outer edge faintly.
  ctx.save();
  const rim = ctx.createLinearGradient(L.inner.x, L.inner.y, L.inner.x + L.inner.w, L.inner.y + L.inner.h);
  rim.addColorStop(0, `rgba(255, 255, 255, ${0.95 * f.rim})`);
  rim.addColorStop(0.5, `rgba(255, 255, 255, ${0.25 * f.rim})`);
  rim.addColorStop(1, `rgba(255, 255, 255, ${0.6 * f.rim})`);
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1, t * 0.06);
  ctx.stroke(innerPath(L));
  const outer = ctx.createLinearGradient(0, 0, L.width, L.height);
  outer.addColorStop(0, `rgba(255, 255, 255, ${0.5 * f.rim})`);
  outer.addColorStop(1, `rgba(255, 255, 255, ${0.12 * f.rim})`);
  ctx.strokeStyle = outer;
  ctx.lineWidth = Math.max(1, t * 0.04);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, L.width - ctx.lineWidth, L.height - ctx.lineWidth);
  ctx.restore();
}

function solidBand(ctx: Ctx, L: FrameLayout, f: ExportFrame) {
  ctx.save();
  ctx.fillStyle = f.color;
  ctx.fill(bandPath(L), "evenodd");
  ctx.restore();
  innerShadow(ctx, L, f.shadow);
}

/**
 * The finished image: `photo` (w × h, already flattened if the format needs it)
 * with its frame, and the watermark placed inside the framed opening.
 */
export function composeExport(photo: CanvasImageSource & { width: number; height: number }, frame?: ExportFrame | null, watermark?: Watermark | null): OffscreenCanvas {
  const L = frameLayout(photo.width, photo.height, frame);
  const out = new OffscreenCanvas(L.width, L.height);
  const ctx = out.getContext("2d")!;
  if (frame?.enabled) {
    if (L.photo.x === 0 && L.photo.y === 0) ctx.drawImage(photo, 0, 0);
    else {
      ctx.save();
      ctx.clip(innerPath(L));
      ctx.drawImage(photo, L.photo.x, L.photo.y, L.photo.w, L.photo.h);
      ctx.restore();
    }
    if (frame.style === "glass") glassBand(ctx, photo, L, frame);
    else solidBand(ctx, L, frame);
  } else ctx.drawImage(photo, 0, 0);
  if (watermark?.enabled) {
    ctx.save();
    ctx.translate(L.inner.x, L.inner.y);
    drawWatermark(ctx, L.inner.w, L.inner.h, watermark);
    ctx.restore();
  }
  return out;
}

/**
 * A transparent overlay with just the frame band (solid styles, inside the image),
 * for video, where the frame is stamped onto every frame like the watermark.
 */
export function drawFrameOverlay(ctx: Ctx, width: number, height: number, frame: ExportFrame) {
  if (!frame.enabled || frame.style === "glass") return;
  const L = frameLayout(width, height, { ...frame, style: "solid", placement: "inside" });
  solidBand(ctx, L, frame);
}

const KEY = "export-frame";
/** The last used frame (a per-browser convenience). */
export function rememberedFrame(): ExportFrame {
  try {
    return sanitizeFrame(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return defaultFrame;
  }
}
export function rememberFrame(f: ExportFrame) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    // Storage unavailable: the setting just isn't remembered.
  }
}
