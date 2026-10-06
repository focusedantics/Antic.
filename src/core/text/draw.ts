import type { Gradient, TextStyle } from "@/core/document/model";

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Spaced = { letterSpacing?: string };

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Deterministic 0..1 hash of two integers (same frame → same flicker in the preview and the export). */
const hash = (a: number, b: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};
const easeOutBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

export const fontShorthand = (s: TextStyle) => `${s.italic ? "italic " : ""}${s.weight} ${s.size}px ${s.font}`;

/** The text as shown: with the style's letter case applied. */
export function shownText(s: Pick<TextStyle, "text" | "textCase">): string {
  if (s.textCase === "upper") return s.text.toUpperCase();
  if (s.textCase === "lower") return s.text.toLowerCase();
  if (s.textCase === "title") return s.text.toLowerCase().replace(/(^|[\s\-–—"“(])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase());
  return s.text;
}

/** A canvas gradient for a document gradient across a w × h box (same geometry as gradient layers). */
export function canvasGradient(ctx: Ctx, g: Gradient, w: number, h: number): CanvasGradient {
  const cx = w / 2 + (g.offsetX * w) / 2;
  const cy = h / 2 + (g.offsetY * h) / 2;
  let grad: CanvasGradient;
  if (g.type === "radial") {
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1e-3, (Math.max(w, h) / 2) * g.scale));
  } else {
    const rad = (g.angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const half = ((Math.abs(dx) * w + Math.abs(dy) * h) / 2) * g.scale;
    grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  }
  const stops = g.reverse ? [...g.stops].reverse().map((st) => ({ ...st, offset: 1 - st.offset })) : g.stops;
  for (const st of stops) {
    const n = parseInt(st.color.slice(1), 16);
    grad.addColorStop(clamp01(st.offset), `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${st.opacity})`);
  }
  return grad;
}

/** How far a curved line rises (or sinks) over its width, for sizing the box. */
export function curveSag(curve: number, lineWidth: number): number {
  if (!curve) return 0;
  const R = lineWidth / (Math.abs(curve) * Math.PI);
  return R * (1 - Math.cos(Math.min(Math.PI / 2, lineWidth / 2 / R)));
}

/**
 * Draws a text layer's style into a w × h box. With a `motion`, letters are
 * laid out one by one and moved for `phase` (0..1 through the loop of
 * `loop` seconds): repeating motions complete whole cycles per loop, so the
 * last frame leads back into the first; reveals (typewriter, pop in) play
 * once per loop and hold. A `curve` bends each line along an arc (letters laid
 * out one by one too). Underline and strike-through follow the letters; a
 * highlight box sits behind each (straight) line; a gradient replaces the colour.
 */
export function drawText(ctx: Ctx, s: TextStyle, w: number, h: number, phase = 0, loop = 3) {
  ctx.fillStyle = s.color;
  ctx.font = fontShorthand(s);
  ctx.textBaseline = "middle";
  const lines = shownText(s).split("\n");
  const lineHeight = s.size * s.lineHeight;
  const motion = s.motion && s.motion.kind !== "none" ? s.motion : null;
  const curve = s.curve ?? 0;
  const spacing = s.letterSpacing * s.size;
  const decoration = Math.max(1, s.size * 0.06);
  const lineExtents: { left: number; width: number; y: number }[] = [];
  // Curved lines rise (or sink): centre the arc's height in the box.
  (ctx as Ctx & Spaced).letterSpacing = "0px";
  const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width + spacing * Math.max(0, [...l].length - 1)));
  const sag = curveSag(curve, widest);
  // Bulging up, the ends sit `sag` below the middle letter: start half of that higher.
  const top = h / 2 - ((lines.length - 1) * lineHeight) / 2 + (curve > 0 ? -sag / 2 : sag / 2);
  const decorate = (x: number, y: number, width: number) => {
    if (s.underline) ctx.fillRect(x, y + s.size * 0.36, width, decoration);
    if (s.strike) ctx.fillRect(x, y + s.size * 0.04 - decoration / 2, width, decoration);
  };

  if (!motion && !curve) {
    ctx.textAlign = s.align;
    (ctx as Ctx & Spaced).letterSpacing = `${spacing}px`;
    const x = s.align === "left" ? 0 : s.align === "right" ? w : w / 2;
    lines.forEach((line, i) => {
      const y = top + i * lineHeight;
      ctx.fillText(line, x, y);
      // measureText includes the letter spacing after the last letter.
      const width = Math.max(0, ctx.measureText(line).width - (line ? spacing : 0));
      const left = s.align === "left" ? 0 : s.align === "right" ? w - width : (w - width) / 2;
      lineExtents.push({ left, width, y });
      decorate(left, y, width);
    });
    finish(ctx, s, w, h, lineExtents);
    return;
  }

  // Per-letter layout (kerning between letters is not applied in this mode).
  ctx.textAlign = "left";
  const glyphs: { ch: string; x: number; y: number; w: number; line: number }[] = [];
  lines.forEach((line, li) => {
    const chars = [...line];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
    let x = s.align === "left" ? 0 : s.align === "right" ? w - total : (w - total) / 2;
    lineExtents.push({ left: x, width: total, y: top + li * lineHeight });
    chars.forEach((ch, i) => {
      glyphs.push({ ch, x, y: top + li * lineHeight, w: widths[i], line: li });
      x += widths[i] + spacing;
    });
  });
  // Where a letter's centre sits and how it turns: straight, or on an arc of radius R.
  const R = curve ? widest / (Math.abs(curve) * Math.PI) : 0;
  const place = (g: { x: number; y: number; w: number }) => {
    const cx = g.x + g.w / 2;
    if (!curve) return { x: cx, y: g.y, angle: 0 };
    const t = (cx - w / 2) / R;
    return curve > 0 ? { x: w / 2 + R * Math.sin(t), y: g.y + R - R * Math.cos(t), angle: t } : { x: w / 2 + R * Math.sin(t), y: g.y - R + R * Math.cos(t), angle: -t };
  };
  const visible = glyphs.filter((g) => g.ch.trim());
  const n = Math.max(1, visible.length);
  const amount = motion?.amount ?? 0;
  const cycles = motion?.speed ?? 1;
  const kind = motion?.kind ?? "none";
  const frame = Math.floor(phase * loop * 12);

  if (kind === "pulse") {
    const k = 1 + 0.08 * amount * Math.sin(TAU * phase * cycles);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(k, k);
    ctx.translate(-w / 2, -h / 2);
  }
  if (kind === "flicker") {
    ctx.shadowColor = s.color;
    ctx.shadowBlur = s.size * (0.15 + 0.35 * amount);
  }
  // Typewriter: letters appear over the first 70 % of the loop, then hold with a blinking caret.
  const typed = kind === "typewriter" ? Math.floor(clamp01(phase / 0.7) * n + 1e-6) : n;
  const glitching = kind === "glitch" && hash(frame, 7) < 0.25 + 0.5 * amount;

  // Spaces carry underlines across words; they are drawn with the letter before them.
  const letterIndex = new Map(visible.map((g, i) => [g, i]));
  glyphs.forEach((g, gi) => {
    const k = letterIndex.get(g) ?? -1;
    const isSpace = k < 0;
    if (!isSpace && k >= typed) return;
    if (isSpace && (!s.underline && !s.strike)) return;
    let dx = 0;
    let dy = 0;
    let scale = 1;
    let alpha = 1;
    let fill = s.color;
    switch (kind) {
      case "wave":
        dy = Math.sin(TAU * phase * cycles - k * 0.55) * s.size * 0.2 * amount;
        break;
      case "bounce": {
        const t = (((phase * cycles - k / n / 2) % 1) + 1) % 1;
        dy = t < 0.25 ? -Math.sin((Math.PI * t) / 0.25) * s.size * 0.3 * amount : 0;
        break;
      }
      case "pop-in": {
        const t = clamp01((phase - (k / n) * 0.55) / 0.12);
        scale = t > 0 ? easeOutBack(t) : 0;
        alpha = t > 0 ? 1 : 0;
        break;
      }
      case "rainbow":
        fill = `hsl(${(((k * 28 + phase * cycles * 360) % 360) + 360) % 360} 90% ${55 + 10 * (1 - amount)}%)`;
        break;
      case "flicker": {
        const r = hash(frame, k);
        alpha = r < 0.05 + 0.2 * amount ? 0.15 : hash(frame, 999) < 0.06 * amount ? 0.4 : 1;
        break;
      }
      case "glitch":
        if (glitching && hash(frame, g.line + 31) < 0.6) dx = (hash(frame, g.line + 57) - 0.5) * s.size * 0.6 * amount;
        break;
    }
    if (isSpace) {
      // A word gap: only its stretch of underline or strike.
      if (kind === "typewriter" || kind === "pop-in") return;
      alpha = 1;
      scale = 1;
    }
    if (alpha <= 0 || scale <= 0) return;
    const at = place(g);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(at.x, at.y);
    if (at.angle) ctx.rotate(at.angle);
    ctx.translate(dx, dy);
    if (scale !== 1) ctx.scale(scale, scale);
    if (glitching && !isSpace) {
      // Colour-split copies either side of the letter.
      const o = s.size * 0.05 * (0.5 + amount);
      ctx.globalAlpha *= 0.75;
      ctx.fillStyle = "#ff2a55";
      ctx.fillText(g.ch, -g.w / 2 - o, 0);
      ctx.fillStyle = "#1ee6ff";
      ctx.fillText(g.ch, -g.w / 2 + o, 0);
      ctx.globalAlpha /= 0.75;
    }
    ctx.fillStyle = fill;
    if (!isSpace) ctx.fillText(g.ch, -g.w / 2, 0);
    // The decoration runs on to the next letter (through the letter spacing).
    const last = glyphs[gi + 1]?.line !== g.line;
    decorate(-g.w / 2, 0, g.w + (last ? 0 : spacing));
    ctx.restore();
  });

  if (kind === "typewriter" && Math.floor(phase * loop * 2.5) % 2 === 0) {
    // Caret after the last typed letter.
    const last = visible[Math.min(typed, n) - 1];
    const at = last ? place({ ...last, x: last.x + last.w + Math.max(2, spacing), w: 0 }) : { x: s.align === "left" ? 0 : s.align === "right" ? w : w / 2, y: top, angle: 0 };
    ctx.save();
    ctx.translate(at.x, at.y);
    if (at.angle) ctx.rotate(at.angle);
    ctx.fillRect(0, -s.size * 0.45, Math.max(2, s.size * 0.06), s.size * 0.9);
    ctx.restore();
  }
  if (kind === "pulse") ctx.restore();
  ctx.shadowBlur = 0;
  finish(ctx, s, w, h, curve ? [] : lineExtents);
}

/** The gradient over what was drawn, then the highlight boxes behind it. */
function finish(ctx: Ctx, s: TextStyle, w: number, h: number, lines: readonly { left: number; width: number; y: number }[]) {
  ctx.save();
  if (s.gradient) {
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = canvasGradient(ctx, s.gradient, w, h);
    ctx.fillRect(0, 0, w, h);
  }
  const hl = s.highlight;
  if (hl && hl.opacity > 0) {
    ctx.globalCompositeOperation = "destination-over";
    ctx.globalAlpha = hl.opacity;
    ctx.fillStyle = hl.color;
    const pad = hl.padding * s.size;
    const half = (s.size * 1.18) / 2 + pad;
    for (const l of lines) {
      if (l.width <= 0) continue;
      ctx.beginPath();
      ctx.roundRect(l.left - pad, l.y - half, l.width + pad * 2, half * 2, Math.min(hl.radius * s.size, half));
      ctx.fill();
    }
  }
  ctx.restore();
}
