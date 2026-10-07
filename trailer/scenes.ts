import { cubicBezier, easeInOut, easeOut, spring, stagger } from "motion";

/**
 * The 60-second trailer as a pure function of time: `render(frame)` draws the picture at
 * `frame.t` seconds, so the same code plays live (driven by Motion's `animate`) and
 * renders frame-exact to video (stepped 1/30 s at a time). Built from Motion's timing
 * primitives (cubic-bezier easing, physical springs, stagger).
 *
 * Motion system, used the same way everywhere so the film has one set of physics:
 * - Arrivals decelerate (expo-out, 0.55 s); departures accelerate and are quicker (expo-in,
 *   0.3 s). Camera moves and wipes ease in and out.
 * - Things that land (cards, tiles, the logo) use one spring with a single small overshoot;
 *   the swipe uses a firmer spring that settles without bouncing; the stutter "punches"
 *   with a fast, under-damped spring on both the words and the picture.
 * - Only position, scale, rotation and opacity animate (and the clip of a wipe).
 * - Cuts land on the beat: every second (two beats at 120 BPM). One thing moves at a time:
 *   the picture leads, the words follow it, small labels come last.
 * - Reduced motion: every move becomes a cross-fade at the same moment; nothing slides,
 *   zooms or bounces, and the story (what changes, when) is unchanged.
 */

export const DURATION = 60;
export const FPS = 30;
export const SNOW_FRAMES = 120;

export type Rect = { x: number; y: number; w: number; h: number };
export type Image = ImageBitmap;
export type ClipPlan = { fps: number; frames: number; cut: number; repeat: number; repeats: number };
export type Assets = {
  still: Record<string, Image>;
  /** Frame k of the snow effect (SNOW_FRAMES of them) and of the edited clip (decoded on demand; see framesAt). */
  snow: (k: number) => Image;
  clip: (k: number) => Image;
  plan: ClipPlan;
  /** Where the balloon is in the cutout render (the rest is transparent). */
  balloonBox: Rect;
};
export type Frame = { g: CanvasRenderingContext2D; W: number; H: number; vertical: boolean; reduced: boolean; t: number; a: Assets };

/** The stills the trailer uses (trailer/shots/<name>.png). */
export const STILLS = [
  "photo-before", "photo-after", "photo-sky", "photo-dunes", "develop-mask",
  "composite-before", "cut-before", "cut-after", "balloon",
  "design", "carousel", "effects-browser", "fx-0", "fx-1", "fx-2", "fx-3", "fx-4", "fx-5", "fx-6", "fx-7", "fx-8", "fx-halftone",
  "video",
] as const;

// ─── Palette and type (the app's own) ───────────────────────────────────────

const BG = "#0b0b0c";
const INK = "#f4efe6";
const ACCENT = "#d9a441";
const DISPLAY = "'Bebas Neue', Impact, sans-serif";
const TEXT = "Inter, system-ui, sans-serif";

// ─── Timing ─────────────────────────────────────────────────────────────────

const arrive = cubicBezier(0.16, 1, 0.3, 1);
const leave = cubicBezier(0.7, 0, 0.84, 0);
const glide = cubicBezier(0.65, 0, 0.35, 1);
const linear = (x: number) => x;
const ARRIVE = 0.55;
const LEAVE = 0.3;

type Spring = { stiffness: number; damping: number; mass?: number };
/** Lands with one small overshoot. */
const LAND: Spring = { stiffness: 320, damping: 24 };
/** A finger's swipe: firm, no bounce. */
const SWIPE: Spring = { stiffness: 230, damping: 30 };
/** A tile turning over. */
const FLIP: Spring = { stiffness: 260, damping: 20 };
/** The stutter's punch: fast and springy. */
const PUNCH: Spring = { stiffness: 700, damping: 18 };
/** A big, heavy thing growing to fill the frame. */
const GROW: Spring = { stiffness: 170, damping: 26 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
/** Eased progress of a move starting at `start` that lasts `duration`. */
const at = (t: number, start: number, duration: number, ease: (x: number) => number = arrive) => ease(clamp01((t - start) / duration));

const springs = new Map<string, (ms: number) => number>();
/** A spring from 0 to 1 released at `start` (Motion's spring solver; may overshoot). */
function sprung(t: number, start: number, s: Spring): number {
  if (t <= start) return 0;
  const key = `${s.stiffness}/${s.damping}/${s.mass ?? 1}`;
  let at = springs.get(key);
  if (!at) {
    const gen = spring({ keyframes: [0, 1], stiffness: s.stiffness, damping: s.damping, mass: s.mass ?? 1 });
    at = (ms) => gen.next(ms).value as number;
    springs.set(key, at);
  }
  return at((t - start) * 1000);
}

/** A move under reduced motion: at rest at once (the fade carries the change). */
const move = (f: Frame, p: number) => (f.reduced ? (p > 0 ? 1 : 0) : p);

// ─── Drawing helpers ────────────────────────────────────────────────────────

const full = (img: Image): Rect => ({ x: 0, y: 0, w: img.width, h: img.height });
const lerpRect = (a: Rect, b: Rect, p: number): Rect => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) });

/** The part of `src` that covers a frame of `aspect`, around a focus point, zoomed in by `zoom`. */
function cover(src: Rect, aspect: number, fx = 0.5, fy = 0.5, zoom = 1): Rect {
  let w = src.w;
  let h = w / aspect;
  if (h > src.h) {
    h = src.h;
    w = h * aspect;
  }
  w /= zoom;
  h /= zoom;
  return { x: clamp(src.x + fx * src.w - w / 2, src.x, src.x + src.w - w), y: clamp(src.y + fy * src.h - h / 2, src.y, src.y + src.h - h), w, h };
}

/** `r` shrunk to `aspect` around its centre. */
function fitAspect(r: Rect, aspect: number): Rect {
  const w = Math.min(r.w, r.h * aspect);
  const h = w / aspect;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

function blit(g: CanvasRenderingContext2D, img: CanvasImageSource, s: Rect, d: Rect) {
  g.drawImage(img, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
}

/** A picture filling the frame (or `d`), cropped around a focus point. */
function picture(f: Frame, img: Image, o: { alpha?: number; zoom?: number; fx?: number; fy?: number; d?: Rect; region?: Rect } = {}) {
  const d = o.d ?? { x: 0, y: 0, w: f.W, h: f.H };
  const alpha = o.alpha ?? 1;
  if (alpha <= 0) return;
  f.g.globalAlpha = alpha;
  blit(f.g, img, cover(o.region ?? full(img), d.w / d.h, o.fx, o.fy, o.zoom), d);
  f.g.globalAlpha = 1;
}

function roundRect(g: CanvasRenderingContext2D, r: Rect, radius: number) {
  g.beginPath();
  g.roundRect(r.x, r.y, r.w, r.h, radius);
}

/** A soft glow on the dark background, so empty space has depth. */
function backdrop(f: Frame, alpha = 1) {
  const { g, W, H } = f;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7);
  glow.addColorStop(0, `rgba(217,164,65,${0.1 * alpha})`);
  glow.addColorStop(1, "rgba(217,164,65,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
}

/**
 * A screenshot of the app: first the whole window (on a phone-shaped frame, a card in the
 * middle), then, as `push` goes 0 → 1, the camera moves in until `region` fills the frame.
 */
function screen(f: Frame, img: Image, region: Rect, push: number, o: { fx?: number; fy?: number; zoom?: number; alpha?: number } = {}) {
  const { g, W, H, vertical } = f;
  const alpha = o.alpha ?? 1;
  const whole: Rect = { x: 0, y: 0, w: W, h: H };
  const card: Rect = vertical ? { x: W * 0.05, y: H * 0.56 - (W * 0.9 * 9) / 16 / 2, w: W * 0.9, h: (W * 0.9 * 9) / 16 } : whole;
  const inSrc = cover(region, W / H, o.fx, o.fy, o.zoom);
  const draw = (p: number, a: number) => {
    if (a <= 0) return;
    const d = lerpRect(card, whole, p);
    const s = fitAspect(lerpRect(full(img), inSrc, p), d.w / d.h);
    const radius = lerp(vertical ? 22 : 0, 0, p);
    g.save();
    g.globalAlpha = a;
    if (radius > 0.5) {
      g.shadowColor = "rgba(0,0,0,0.6)";
      g.shadowBlur = 60;
      g.shadowOffsetY = 20;
      roundRect(g, d, radius);
      g.fillStyle = "#000";
      g.fill();
      g.shadowColor = "transparent";
      g.clip();
    }
    blit(g, img, s, d);
    g.restore();
  };
  if (f.reduced) {
    // No camera move: the whole window cross-fades to the close-up.
    draw(0, alpha * (1 - push));
    draw(1, alpha * push);
  } else draw(push, alpha);
}

/** A thin scrim behind words so they read on any picture. */
function scrim(f: Frame, alpha: number, top: boolean) {
  if (alpha <= 0) return;
  const { g, W, H } = f;
  const y0 = top ? 0 : H * 0.5;
  const y1 = top ? H * 0.42 : H;
  const grad = g.createLinearGradient(0, top ? y0 : y1, 0, top ? y1 : y0);
  grad.addColorStop(0, `rgba(0,0,0,${0.55 * alpha})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, y0, W, y1 - y0);
}

type Placed = { word: string; x: number; y: number; line: number };

/** Word positions: big display type, wrapped, bottom-left (16:9) or high up (9:16, clear of the bottom fifth and the right edge). */
function layoutWords(f: Frame, text: string, size: number): { words: Placed[]; lineHeight: number; top: number; bottom: number } {
  const { g, W, H, vertical } = f;
  g.font = `${size}px ${DISPLAY}`;
  g.letterSpacing = "0.01em";
  const maxWidth = vertical ? W * 0.82 : W * 0.6;
  const space = g.measureText(" ").width;
  const lines: { word: string; width: number }[][] = [[]];
  let width = 0;
  for (const word of text.split(" ")) {
    const w = g.measureText(word).width;
    if (width > 0 && width + space + w > maxWidth) {
      lines.push([]);
      width = 0;
    }
    lines[lines.length - 1].push({ word, width: w });
    width += (width > 0 ? space : 0) + w;
  }
  const lineHeight = size * 0.94;
  const x0 = vertical ? W * 0.08 : W * 0.065;
  const firstBaseline = vertical ? H * 0.1 + size * 0.8 : H * 0.88 - (lines.length - 1) * lineHeight;
  const words: Placed[] = [];
  lines.forEach((line, i) => {
    let x = x0;
    for (const { word, width: w } of line) {
      words.push({ word, x, y: firstBaseline + i * lineHeight, line: i });
      x += w + space;
    }
  });
  return { words, lineHeight, top: firstBaseline - size * 0.8, bottom: firstBaseline + (lines.length - 1) * lineHeight };
}

/**
 * Words on screen from `start` to `end`: each rises out from behind its line (a mask
 * reveal), staggered word by word, and all leave together, faster than they came.
 * `times` sets each word's own entrance (to land words on cuts); `kicker` is a small label
 * above them naming the workspace.
 */
function caption(f: Frame, text: string, start: number, end: number, o: { kicker?: string; times?: number[]; size?: number } = {}) {
  const { g, t, W, H, vertical } = f;
  if (t < start - 0.05 || t > end) return;
  const size = (o.size ?? 1) * (vertical ? W * 0.15 : H * 0.12);
  const { words, lineHeight, top } = layoutWords(f, text, size);
  const delay = stagger(0.06);
  const out = at(t, end - LEAVE, LEAVE, leave);
  scrim(f, at(t, start, ARRIVE) * (1 - out), vertical);
  g.save();
  g.shadowColor = "rgba(0,0,0,0.35)";
  g.shadowBlur = size * 0.25;
  g.fillStyle = INK;
  g.font = `${size}px ${DISPLAY}`;
  g.letterSpacing = "0.01em";
  words.forEach((w, i) => {
    const begin = o.times?.[i] ?? start + (delay(i, words.length) as number);
    const p = at(t, begin, ARRIVE);
    if (p <= 0) return;
    const rise = move(f, p);
    g.save();
    // The line's own box: the word slides up from below its baseline.
    g.beginPath();
    g.rect(0, w.y - size * 0.86, W, lineHeight + size * 0.1);
    g.clip();
    g.globalAlpha = p * (1 - out);
    g.fillText(w.word, w.x, w.y + (1 - rise) * size * 0.9 - move(f, out) * size * 0.15);
    g.restore();
  });
  g.restore();
  if (o.kicker) kicker(f, o.kicker, start, end, words[0].x, top - size * 0.12, size * 0.16);
}

/** A small label in the accent colour, letter-spaced, that slides in from the left. */
function kicker(f: Frame, text: string, start: number, end: number, x: number, y: number, size: number) {
  const { g, t } = f;
  const p = at(t, start + 0.15, ARRIVE);
  const out = at(t, end - LEAVE, LEAVE, leave);
  if (p <= 0 || out >= 1) return;
  g.save();
  g.globalAlpha = p * (1 - out);
  g.font = `600 ${size}px ${TEXT}`;
  g.letterSpacing = "0.32em";
  g.fillStyle = ACCENT;
  g.shadowColor = "rgba(0,0,0,0.4)";
  g.shadowBlur = size;
  g.fillText(text.toUpperCase(), x - (1 - move(f, p)) * size * 1.2, y);
  g.restore();
}

/** Off-screen buffer for soft reveals. */
let buffer: OffscreenCanvas | null = null;
function bufferFor(W: number, H: number) {
  if (!buffer || buffer.width !== W || buffer.height !== H) buffer = new OffscreenCanvas(W, H);
  const b = buffer.getContext("2d")!;
  b.globalCompositeOperation = "source-over";
  b.clearRect(0, 0, W, H);
  return { canvas: buffer, b };
}

// ─── Scenes ─────────────────────────────────────────────────────────────────

/** 0–3 s · "One photo.": the flat photo, wiped to the finished one. */
function opening(f: Frame) {
  const { g, t, W, H } = f;
  const s = f.a.still;
  const zoom = f.reduced ? 1.03 : lerp(1, 1.06, at(t, 0, 3, easeOut));
  picture(f, s["photo-before"], { alpha: at(t, 0, 0.6, easeOut), zoom });
  const wipe = at(t, 0.8, 1.5, glide);
  if (f.reduced) picture(f, s["photo-after"], { alpha: wipe, zoom });
  else if (wipe > 0) {
    const x = W * wipe;
    g.save();
    g.beginPath();
    g.rect(0, 0, x, H);
    g.clip();
    picture(f, s["photo-after"], { zoom });
    g.restore();
    // The divider and its handle, as in Develop's split view.
    const a = at(t, 0.6, 0.2) * (1 - at(t, 2.3, 0.25, leave));
    if (a > 0) {
      g.save();
      g.globalAlpha = a;
      g.fillStyle = INK;
      g.fillRect(x - 1.5, 0, 3, H);
      const r = Math.min(W, H) * 0.028;
      g.beginPath();
      g.arc(x, H / 2, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = BG;
      for (const dir of [-1, 1]) {
        g.beginPath();
        g.moveTo(x + dir * r * 0.55, H / 2);
        g.lineTo(x + dir * r * 0.15, H / 2 - r * 0.32);
        g.lineTo(x + dir * r * 0.15, H / 2 + r * 0.32);
        g.fill();
      }
      g.restore();
    }
  }
  caption(f, "One photo.", 0.25, 3, { kicker: "Develop" });
}

/** The photo's place in the Develop screenshot (1920 × 1080). */
const DEVELOP_PHOTO: Rect = { x: 276, y: 96, w: 1308, h: 872 };

/** 3–10 s · "Edit only the sky.": the mask overlay, then the sky changes on its own. */
function sky(f: Frame) {
  const { t, W, H } = f;
  const s = f.a.still;
  const zoom = f.reduced ? 1 : lerp(1, 1.05, at(t, 5.4, 4.6, easeOut));
  screen(f, s["develop-mask"], DEVELOP_PHOTO, at(t, 4.2, 1.2, glide), { fy: 0.45, zoom });
  // The overlay fades away: the clean photo, framed exactly as the close-up.
  picture(f, s["photo-after"], { alpha: at(t, 5.6, 0.5, easeInOut), zoom, fy: 0.45 });
  // The sky's edit sweeps down the frame like the gradient that made it.
  const p = at(t, 6.6, 1.8, glide);
  if (p <= 0) return caption(f, "Edit only the sky.", 3.3, 10, { kicker: "Masks" });
  if (f.reduced) picture(f, s["photo-sky"], { alpha: p, fy: 0.45 });
  else {
    const { canvas, b } = bufferFor(W, H);
    const feather = H * 0.25;
    const edge = lerp(0, H * 0.9 + feather, p);
    blit(b as unknown as CanvasRenderingContext2D, s["photo-sky"], cover(full(s["photo-sky"]), W / H, 0.5, 0.45, zoom), { x: 0, y: 0, w: W, h: H });
    const mask = b.createLinearGradient(0, edge - feather, 0, edge);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    b.globalCompositeOperation = "destination-in";
    b.fillStyle = mask;
    b.fillRect(0, 0, W, H);
    f.g.drawImage(canvas, 0, 0);
  }
  caption(f, "Edit only the sky.", 3.3, 10, { kicker: "Masks" });
}

/** The canvas in the Composite screenshot. */
const COMPOSITE_CANVAS: Rect = { x: 312, y: 120, w: 1236, h: 824 };

type Spot = { at: number; x: number; y: number; h: number; back: string };
/** Where the balloon goes, beat by beat (fractions of the frame; h = height). */
const SPOTS_WIDE: Spot[] = [
  { at: 14, x: 0.3, y: 0.52, h: 0.62, back: "photo-sky" },
  { at: 15, x: 0.68, y: 0.4, h: 0.42, back: "photo-sky" },
  { at: 16, x: 0.36, y: 0.46, h: 0.5, back: "photo-dunes" },
  { at: 17, x: 0.62, y: 0.5, h: 0.72, back: "photo-dunes" },
];
const SPOTS_TALL: Spot[] = [
  { at: 14, x: 0.5, y: 0.58, h: 0.4, back: "photo-sky" },
  { at: 15, x: 0.62, y: 0.48, h: 0.28, back: "photo-sky" },
  { at: 16, x: 0.42, y: 0.55, h: 0.34, back: "photo-dunes" },
  { at: 17, x: 0.55, y: 0.6, h: 0.46, back: "photo-dunes" },
];

/** 10–18 s · "Cut it out. Put it anywhere.": Remove Background, then the cutout moves between photos. */
function cutout(f: Frame) {
  const { g, t, W, H, vertical } = f;
  const s = f.a.still;
  if (t < 14) {
    // A small breath of the camera when the background goes.
    const bump = f.reduced ? 0 : Math.sin(Math.PI * clamp01((t - 12) / 0.6)) * (1 - at(t, 12, 0.6, linear)) * 0.025;
    const fx = 0.3;
    screen(f, s["composite-before"], COMPOSITE_CANVAS, at(t, 10.5, 1.1, glide), { fx, fy: 0.5, zoom: 1 + bump });
    picture(f, s["cut-before"], { alpha: at(t, 11.6, 0.15, linear), fx, zoom: 1 + bump });
    picture(f, s["cut-after"], { alpha: at(t, 12, 0.35, easeOut), fx, zoom: 1 + bump });
    caption(f, "Cut it out.", 10.3, 14, { kicker: "Remove Background" });
    return;
  }
  const spots = vertical ? SPOTS_TALL : SPOTS_WIDE;
  let i = 0;
  while (i + 1 < spots.length && t >= spots[i + 1].at) i++;
  const now = spots[i];
  picture(f, s[now.back], { zoom: f.reduced ? 1 : lerp(1, 1.04, at(t, now.at, 2, easeOut)), fx: 0.55 });
  const from = i === 0 ? { ...now, y: 1.35 } : spots[i - 1];
  const p = move(f, sprung(t, now.at, LAND));
  const bob = f.reduced ? 0 : Math.sin(t * 2.4) * 0.006;
  const box = f.a.balloonBox;
  const h = lerp(from.h, now.h, p) * H;
  const w = (h * box.w) / box.h;
  const cx = lerp(from.x, now.x, p) * W;
  const cy = (lerp(from.y, now.y, p) + bob) * H;
  g.save();
  g.globalAlpha = f.reduced ? at(t, now.at, 0.3, linear) : 1;
  g.shadowColor = "rgba(0,0,0,0.35)";
  g.shadowBlur = h * 0.06;
  g.shadowOffsetY = h * 0.03;
  blit(g, s.balloon, box, { x: cx - w / 2, y: cy - h / 2, w, h });
  g.restore();
  caption(f, "Put it anywhere.", 14.15, 18);
}

/** The canvas in the Design screenshot. */
const DESIGN_CANVAS: Rect = { x: 305, y: 120, w: 1250, h: 781 };

/** 18–24 s · "Ready to post.": the two-slide carousel, swiped like a post, then seen whole. */
function design(f: Frame) {
  const { g, t, W, H, vertical } = f;
  const s = f.a.still;
  const into = at(t, 19.2, 0.4, easeInOut);
  if (into < 1) screen(f, s.design, DESIGN_CANVAS, at(t, 18.4, 0.9, glide), { alpha: 1 - into });
  if (into <= 0) return caption(f, "Ready to post.", 18.3, 24, { kicker: "Design" });
  g.globalAlpha = into;
  backdrop(f);
  g.globalAlpha = 1;
  const strip = s.carousel;
  const slideW = strip.width / 2;
  // The post: one 4:5 slide, a card in the frame.
  const cw = vertical ? W * 0.78 : H * 0.62;
  const ch = cw * 1.25;
  const enter = move(f, sprung(t, 19.2, LAND));
  const whole = at(t, 22.3, 0.9, glide);
  const shrink = lerp(1, vertical ? 0.58 : 0.72, move(f, whole));
  const width = lerp(cw, cw * 2, move(f, whole)) * shrink;
  const height = ch * shrink * lerp(0.96, 1, enter);
  const cx = vertical ? W * 0.5 : lerp(W * 0.66, W * 0.6, move(f, whole));
  const cy = (vertical ? H * 0.58 : H * 0.47) + (1 - enter) * H * 0.05;
  const card: Rect = { x: cx - width / 2, y: cy - height / 2, w: width, h: height };
  // Swipe to slide 2 on the beat; the strip shows both slides at the end.
  const swiped = move(f, sprung(t, 20.6, SWIPE));
  const pos = swiped * (1 - move(f, whole));
  g.save();
  g.globalAlpha = into;
  g.shadowColor = "rgba(0,0,0,0.6)";
  g.shadowBlur = 50;
  g.shadowOffsetY = 18;
  roundRect(g, card, 18 * shrink);
  g.fillStyle = "#000";
  g.fill();
  g.shadowColor = "transparent";
  g.clip();
  blit(g, strip, { x: pos * slideW, y: 0, w: lerp(1, 2, move(f, whole)) * slideW, h: strip.height }, card);
  // Where one slide ends and the next begins.
  if (whole > 0) {
    g.globalAlpha = into * whole * 0.7;
    g.setLineDash([10, 10]);
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, card.y);
    g.lineTo(cx, card.y + card.h);
    g.stroke();
  }
  g.restore();
  // Page dots under the post.
  const dots = (1 - whole) * into;
  if (dots > 0) {
    for (let k = 0; k < 2; k++) {
      const on = 1 - Math.abs(k - pos);
      g.globalAlpha = dots * lerp(0.35, 1, clamp01(on));
      g.fillStyle = on > 0.5 ? ACCENT : INK;
      g.beginPath();
      g.arc(cx + (k - 0.5) * 22, card.y + card.h + 28, 5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
  // The finger that swipes.
  const touch = at(t, 20.2, 0.25) * (1 - at(t, 21.1, 0.25, leave));
  if (touch > 0 && !f.reduced) {
    const x = cx + cw * 0.28 - cw * 0.56 * at(t, 20.5, 0.45, glide);
    g.globalAlpha = touch * 0.85;
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath();
    g.arc(x, cy + ch * 0.15, cw * 0.045, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
  caption(f, "Ready to post.", 18.3, 24, { kicker: "Design" });
}

/** The grid's tiles (fx-N): halftone (fx-0) in the middle. */
const GRID = [1, 2, 3, 4, 0, 5, 6, 7, 8];

/** 24–34 s · "Make it move.": a grid of looks turns over, halftone fills the frame, then snow falls. */
function effects(f: Frame) {
  const { g, t, W, H, vertical } = f;
  const s = f.a.still;
  if (t < 25) {
    screen(f, s["effects-browser"], full(s["effects-browser"]), 0, { zoom: f.reduced ? 1 : lerp(1, 1.04, at(t, 24, 1, linear)) });
    return;
  }
  if (t >= 30) {
    // Snow: the effect's own frames, 30 a second.
    picture(f, f.a.snow(snowFrame(t)), { fx: 0.32 });
    caption(f, "Make it move.", 28.2, 34, { kicker: "Effects" });
    return;
  }
  backdrop(f);
  const gap = Math.round(Math.min(W, H) * 0.014);
  const cw = vertical ? (W * 0.9 - 2 * gap) / 3 : Math.min((W * 0.86 - 2 * gap) / 3, ((H * 0.84 - 2 * gap) / 3) * 1.5);
  const ch = vertical ? cw * 1.3 : cw / 1.5;
  const gx = W / 2 - (3 * cw + 2 * gap) / 2;
  const gy = (vertical ? H * 0.56 : H * 0.5) - (3 * ch + 2 * gap) / 2;
  const cell = (i: number): Rect => ({ x: gx + (i % 3) * (cw + gap), y: gy + Math.floor(i / 3) * (ch + gap), w: cw, h: ch });
  const turn = stagger(0.07, { from: "center" });
  const away = stagger(0.04, { from: "center" });
  GRID.forEach((fx, i) => {
    if (i === 4) return;
    const flip = sprung(t, 25 + (turn(i, 9) as number), FLIP);
    const gone = at(t, 27.8 + (away(i, 9) as number), LEAVE, leave);
    const alpha = clamp01(flip * 4) * (1 - gone);
    if (alpha <= 0) return;
    const r = cell(i);
    g.save();
    g.globalAlpha = alpha;
    g.translate(r.x + r.w / 2, r.y + r.h / 2);
    if (!f.reduced) g.scale(Math.max(0.001, flip) * (1 - gone * 0.15), 1 - gone * 0.15);
    picture(f, s[`fx-${fx}`], { d: { x: -r.w / 2, y: -r.h / 2, w: r.w, h: r.h }, fx: 0.32 });
    // The far side of the turn is in shade.
    if (!f.reduced && flip < 1) {
      g.fillStyle = `rgba(0,0,0,${(1 - clamp01(flip)) * 0.5})`;
      g.fillRect(-r.w / 2, -r.h / 2, r.w, r.h);
    }
    g.restore();
  });
  // The middle tile: turns first, then grows to fill the frame.
  const flip = sprung(t, 25, FLIP);
  const grow = move(f, sprung(t, 28.1, GROW));
  const r = lerpRect(cell(4), { x: 0, y: 0, w: W, h: H }, grow);
  g.save();
  g.globalAlpha = clamp01(flip * 4);
  g.translate(r.x + r.w / 2, r.y + r.h / 2);
  if (!f.reduced) g.scale(Math.max(0.001, flip), 1);
  const zoom = f.reduced ? 1 : lerp(1, 1.04, at(t, 28.6, 1.4, easeOut));
  picture(f, grow > 0 ? s["fx-halftone"] : s["fx-0"], { d: { x: -r.w / 2, y: -r.h / 2, w: r.w, h: r.h }, fx: 0.32, zoom });
  g.restore();
  caption(f, "Make it move.", 28.2, 34, { kicker: "Effects" });
}

/** The viewer in the Video screenshot, and the picture inside each captured viewer frame. */
const VIDEO_VIEWER: Rect = { x: 240, y: 90, w: 1380, h: 776 };
const CLIP_PICTURE: Rect = { x: 0, y: 12, w: 1380, h: 777 };
/** When the clip's cut (its frame `plan.cut`) plays: on the beat. */
const CUT_AT = 37;

const clipStart = (plan: ClipPlan) => CUT_AT - plan.cut / plan.fps;
const clipFrame = (t: number, plan: ClipPlan) => clamp(Math.floor((t - clipStart(plan)) * plan.fps), 0, plan.frames - 1);
/** The snow plays once at 30–34 s and loops on the video card at 44–52 s. */
const snowFrame = (t: number) => (t < 44 ? clamp(Math.floor((t - 30) * 30), 0, SNOW_FRAMES - 1) : Math.floor((t - 44) * 30) % SNOW_FRAMES);

/** The moving frames drawn at `t`, so a player can decode them first. */
export function framesAt(t: number, plan: ClipPlan): { snow: number[]; clip: number[] } {
  return {
    snow: (t >= 30 && t < 34) || (t >= 44 && t < 52) ? [snowFrame(t)] : [],
    clip: t >= clipStart(plan) && t < 44 ? [clipFrame(t, plan)] : [],
  };
}

/** 34–44 s · "w-w-w-what": the app's stutter, word by word, then the stare-down. */
function stutter(f: Frame) {
  const { g, t, W, H, vertical } = f;
  const { plan, clip } = f.a;
  if (t < clipStart(plan)) {
    screen(f, f.a.still.video, VIDEO_VIEWER, at(t, 34.6, 1, glide));
    return;
  }
  const k = clipFrame(t, plan);
  // Where each repeat starts (the stutter), and where the picture freezes.
  const hits = Array.from({ length: plan.repeats }, (_, i) => CUT_AT + (i * plan.repeat) / plan.fps);
  const held = clipStart(plan) + (plan.frames - 1) / plan.fps;
  let punch = 0;
  for (const hit of hits) if (t >= hit) punch = 1 - sprung(t, hit, PUNCH);
  const stare = at(t, CUT_AT + ((plan.repeats - 1) * plan.repeat) / plan.fps + 2, 4.5, easeInOut);
  const zoom = f.reduced ? 1 : 1 + punch * 0.05 + stare * (vertical ? 0.12 : 0.3);
  picture(f, clip(k), { region: CLIP_PICTURE, zoom, fx: 0.47, fy: 0.3 });
  // Letterbox for the stare-down.
  const bars = at(t, held - 1.4, 0.8) * (vertical ? 0.08 : 0.1) * H;
  if (bars > 0) {
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, bars);
    g.fillRect(0, H - bars, W, bars);
  }
  // The words: one piece per repeat, each punching in as its repeat starts.
  const pieces = [...hits.slice(0, -1).map(() => "W-"), "WHAT"];
  const size = vertical ? W * 0.2 : H * 0.17;
  const out = at(t, 43.7, LEAVE, leave);
  g.save();
  g.font = `${size}px ${DISPLAY}`;
  g.letterSpacing = "0.01em";
  g.fillStyle = INK;
  g.shadowColor = "rgba(0,0,0,0.45)";
  g.shadowBlur = size * 0.25;
  let x = vertical ? W * 0.08 : W * 0.065;
  const y = vertical ? H * 0.1 + size * 0.8 + bars : H * 0.86 - bars * 0.3;
  pieces.forEach((piece, i) => {
    const hit = hits[i];
    const w = g.measureText(piece).width;
    if (t >= hit) {
      const p = sprung(t, hit, PUNCH);
      const scale = f.reduced ? 1 : lerp(1.45, 1, p);
      g.save();
      g.globalAlpha = clamp01(p * 3) * (1 - out);
      g.translate(x + w / 2, y - size * 0.35);
      g.scale(scale, scale);
      g.fillText(piece, -w / 2, size * 0.35);
      g.restore();
    }
    x += w + size * 0.02;
  });
  g.restore();
  if (t >= hits[0]) kicker(f, "Video", hits[0], 44, vertical ? W * 0.08 : W * 0.065, y - size * 0.92, size * 0.14);
}

/** 44–52 s · "Photos. Carousels. Video.": what comes out, each landing with its word. */
function exports(f: Frame) {
  const { g, t, W, H, vertical } = f;
  const s = f.a.still;
  backdrop(f);
  const beats = [44.5, 45.5, 46.5];
  const snow = f.a.snow(snowFrame(t));
  type Card = { img: Image; src: Rect; label: string; w: number; aspect: number; x: number; y: number; turn: number; video?: boolean };
  const slide: Rect = { x: 0, y: 0, w: s.carousel.width / 2, h: s.carousel.height };
  const cards: Card[] = vertical
    ? [
        { img: s["photo-sky"], src: full(s["photo-sky"]), label: "Photo", w: 0.58, aspect: 1.5, x: 0.33, y: 0.45, turn: -3 },
        { img: s.carousel, src: slide, label: "Carousel", w: 0.42, aspect: 0.8, x: 0.72, y: 0.55, turn: 4 },
        { img: snow, src: full(snow), label: "Video", w: 0.7, aspect: 1.5, x: 0.44, y: 0.76, turn: -2, video: true },
      ]
    : [
        { img: s["photo-sky"], src: full(s["photo-sky"]), label: "Photo", w: 0.33, aspect: 1.5, x: 0.21, y: 0.42, turn: -2 },
        { img: s.carousel, src: slide, label: "Carousel", w: 0.19, aspect: 0.8, x: 0.5, y: 0.42, turn: 2 },
        { img: snow, src: full(snow), label: "Video", w: 0.33, aspect: 1.5, x: 0.79, y: 0.42, turn: -1.5, video: true },
      ];
  const out = at(t, 52 - LEAVE, LEAVE, leave);
  cards.forEach((c, i) => {
    const p = sprung(t, beats[i], LAND);
    if (p <= 0) return;
    const w = c.w * W;
    const h = w / c.aspect;
    const rise = move(f, p);
    g.save();
    g.globalAlpha = clamp01(p * 3) * (1 - out);
    g.translate(c.x * W, c.y * H + (1 - rise) * H * 0.12 - move(f, out) * H * 0.03);
    if (!f.reduced) {
      g.rotate((c.turn * Math.PI) / 180);
      g.scale(lerp(0.92, 1, rise), lerp(0.92, 1, rise));
    }
    const d = { x: -w / 2, y: -h / 2, w, h };
    g.shadowColor = "rgba(0,0,0,0.55)";
    g.shadowBlur = 40;
    g.shadowOffsetY = 16;
    roundRect(g, d, 14);
    g.fillStyle = "#000";
    g.fill();
    g.shadowColor = "transparent";
    g.save();
    g.clip();
    blit(g, c.img, cover(c.src, c.aspect, 0.32), d);
    if (c.video) {
      // A player's progress bar.
      const played = ((t - 44) % 4) / 4;
      g.fillStyle = "rgba(255,255,255,0.3)";
      g.fillRect(d.x, d.y + h - 6, w, 6);
      g.fillStyle = ACCENT;
      g.fillRect(d.x, d.y + h - 6, w * played, 6);
    }
    g.restore();
    g.font = `600 ${Math.round(Math.min(W, H) * 0.022)}px ${TEXT}`;
    g.letterSpacing = "0.24em";
    g.fillStyle = "rgba(244,239,230,0.75)";
    g.fillText(c.label.toUpperCase(), d.x, d.y + h + Math.min(W, H) * 0.045);
    g.restore();
  });
  caption(f, "Photos. Carousels. Video.", 44.5, 52, { kicker: "Export", times: beats });
}

/** 52–60 s · the end card: the mark lands, the name tracks in, the promise, the call to action. */
function ending(f: Frame) {
  const { g, t, W, H, vertical } = f;
  backdrop(f, at(t, 52, 0.6));
  const unit = vertical ? W : H * 1.1;
  const mark = sprung(t, 52.2, LAND);
  const name = "FOCUSED";
  const nameSize = unit * 0.075;
  g.font = `700 ${nameSize}px ${TEXT}`;
  g.letterSpacing = "0.28em";
  const nameWidth = g.measureText(name).width;
  const r = nameSize * 0.62;
  const groupW = r * 2 + nameSize * 0.6 + nameWidth;
  const left = W / 2 - groupW / 2;
  const cy = vertical ? H * 0.42 : H * 0.4;
  // The mark: a ring and the amber dot, as in the app's corner.
  if (mark > 0) {
    const scale = f.reduced ? 1 : lerp(0.6, 1, mark);
    g.save();
    g.globalAlpha = clamp01(mark * 3);
    g.translate(left + r, cy);
    g.scale(scale, scale);
    g.lineWidth = r * 0.24;
    g.strokeStyle = INK;
    g.beginPath();
    g.arc(0, 0, r - g.lineWidth / 2, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = ACCENT;
    g.beginPath();
    g.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // The name, letter by letter, tracking in from wide.
  const letters = stagger(0.045);
  let x = left + r * 2 + nameSize * 0.6;
  g.save();
  g.font = `700 ${nameSize}px ${TEXT}`;
  g.letterSpacing = "0px";
  g.fillStyle = INK;
  [...name].forEach((ch, i) => {
    const p = at(t, 52.5 + (letters(i, name.length) as number), ARRIVE);
    const w = g.measureText(ch).width;
    if (p > 0) {
      g.globalAlpha = p;
      g.fillText(ch, x + (1 - move(f, p)) * nameSize * 0.5 * (i + 1) * 0.3, cy + nameSize * 0.36);
    }
    x += w + nameSize * 0.28;
  });
  g.restore();
  // The promise, then what to do.
  const lineSize = unit * (vertical ? 0.05 : 0.036);
  const words = (text: string, y: number, start: number, color: string, weight: number) => {
    g.save();
    g.font = `${weight} ${lineSize}px ${TEXT}`;
    g.letterSpacing = "0px";
    g.fillStyle = color;
    const parts = text.split(" ");
    const space = g.measureText(" ").width;
    const total = parts.reduce((sum, p) => sum + g.measureText(p).width, 0) + space * (parts.length - 1);
    let px = W / 2 - total / 2;
    const delay = stagger(0.05);
    parts.forEach((p, i) => {
      const a = at(t, start + (delay(i, parts.length) as number), ARRIVE);
      const w = g.measureText(p).width;
      if (a > 0) {
        g.globalAlpha = a;
        g.fillText(p, px, y + (1 - move(f, a)) * lineSize * 0.6);
      }
      px += w + space;
    });
    g.restore();
  };
  if (vertical) {
    words("In your browser.", cy + unit * 0.22, 53.6, INK, 500);
    words("Nothing is uploaded.", cy + unit * 0.3, 54.0, INK, 500);
    words("Start with Chapter 1.", cy + unit * 0.46, 55.2, ACCENT, 600);
  } else {
    words("In your browser. Nothing is uploaded.", cy + unit * 0.16, 53.6, INK, 500);
    words("Start with Chapter 1.", cy + unit * 0.25, 55.2, ACCENT, 600);
  }
  // Out to black.
  const end = at(t, 59.2, 0.8, easeInOut);
  if (end > 0) {
    g.fillStyle = `rgba(0,0,0,${end})`;
    g.fillRect(0, 0, W, H);
  }
}

const SCENES: [number, number, (f: Frame) => void][] = [
  [0, 3, opening],
  [3, 10, sky],
  [10, 18, cutout],
  [18, 24, design],
  [24, 34, effects],
  [34, 44, stutter],
  [44, 52, exports],
  [52, DURATION + 1, ending],
];

/** Draws the trailer at `f.t`. */
export function render(f: Frame) {
  const { g, W, H } = f;
  g.save();
  g.globalAlpha = 1;
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  for (const [from, to, scene] of SCENES) {
    if (f.t >= from && f.t < to) {
      scene(f);
      break;
    }
  }
  g.restore();
}
