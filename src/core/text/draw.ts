import type { TextStyle } from "@/core/document/model";

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

/**
 * Draws a text layer's style into a w × h box. With a `motion`, letters are
 * laid out one by one and moved for `phase` (0..1 through the loop of
 * `loop` seconds): repeating motions complete whole cycles per loop, so the
 * last frame leads back into the first; reveals (typewriter, pop in) play
 * once per loop and hold.
 */
export function drawText(ctx: Ctx, s: TextStyle, w: number, h: number, phase = 0, loop = 3) {
  ctx.fillStyle = s.color;
  ctx.font = fontShorthand(s);
  ctx.textBaseline = "middle";
  const lines = s.text.split("\n");
  const lineHeight = s.size * s.lineHeight;
  const top = h / 2 - ((lines.length - 1) * lineHeight) / 2;
  const motion = s.motion && s.motion.kind !== "none" ? s.motion : null;
  if (!motion) {
    ctx.textAlign = s.align;
    (ctx as Ctx & Spaced).letterSpacing = `${s.letterSpacing * s.size}px`;
    const x = s.align === "left" ? 0 : s.align === "right" ? w : w / 2;
    lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineHeight));
    return;
  }

  // Per-letter layout (kerning between letters is not applied in this mode).
  ctx.textAlign = "left";
  (ctx as Ctx & Spaced).letterSpacing = "0px";
  const spacing = s.letterSpacing * s.size;
  const glyphs: { ch: string; x: number; y: number; w: number; line: number }[] = [];
  lines.forEach((line, li) => {
    const chars = [...line];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
    let x = s.align === "left" ? 0 : s.align === "right" ? w - total : (w - total) / 2;
    chars.forEach((ch, i) => {
      glyphs.push({ ch, x, y: top + li * lineHeight, w: widths[i], line: li });
      x += widths[i] + spacing;
    });
  });
  const visible = glyphs.filter((g) => g.ch.trim());
  const n = Math.max(1, visible.length);
  const amount = motion.amount;
  const cycles = motion.speed;
  const frame = Math.floor(phase * loop * 12);

  if (motion.kind === "pulse") {
    const k = 1 + 0.08 * amount * Math.sin(TAU * phase * cycles);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(k, k);
    ctx.translate(-w / 2, -h / 2);
  }
  if (motion.kind === "flicker") {
    ctx.shadowColor = s.color;
    ctx.shadowBlur = s.size * (0.15 + 0.35 * amount);
  }
  // Typewriter: letters appear over the first 70 % of the loop, then hold with a blinking caret.
  const typed = motion.kind === "typewriter" ? Math.floor(clamp01(phase / 0.7) * n + 1e-6) : n;
  const glitching = motion.kind === "glitch" && hash(frame, 7) < 0.25 + 0.5 * amount;

  visible.forEach((g, k) => {
    if (k >= typed) return;
    let dx = 0;
    let dy = 0;
    let scale = 1;
    let alpha = 1;
    let fill = s.color;
    switch (motion.kind) {
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
    if (alpha <= 0 || scale <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(g.x + g.w / 2 + dx, g.y + dy);
    if (scale !== 1) ctx.scale(scale, scale);
    if (glitching) {
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
    ctx.fillText(g.ch, -g.w / 2, 0);
    ctx.restore();
  });

  if (motion.kind === "typewriter" && Math.floor(phase * loop * 2.5) % 2 === 0) {
    // Caret after the last typed letter.
    const last = visible[Math.min(typed, n) - 1];
    const x = last ? last.x + last.w + Math.max(2, spacing) : s.align === "left" ? 0 : s.align === "right" ? w : w / 2;
    const y = last ? last.y : top;
    ctx.fillRect(x, y - s.size * 0.45, Math.max(2, s.size * 0.06), s.size * 0.9);
  }
  if (motion.kind === "pulse") ctx.restore();
  ctx.shadowBlur = 0;
}
