import type { CompositeDocument, EffectLayer, Gradient, GroupLayer, Layer, PathStyle, SlotLayer, SmartShape, SubPath, TextLayer, TextStyle } from "@/core/document/model";
import { canvasTransform, effectLayer, gradientLayer } from "@/core/document/operations";
import { smartShape } from "@/core/document/shapes";
import type { EffectParams } from "@/core/effects/types";
import { frame, fx, group, kit, type Kit, path, shape, text } from "./kit";
import type { Template } from "./templates";

/**
 * Stylized event posters: Crazy, Minimal and Futuristic. Each is layered the way a
 * designer would build it: a backdrop group with its own effect, the artwork, crisp type,
 * then a finish over the whole poster. Every detail people change is a labelled field,
 * so Design's Details form fills the poster in one go, and photo frames carry their own
 * treatment, so a photo dropped in comes out in the poster's style. Effects don't show in
 * the gallery's quick sketches, so these show rendered previews (public/templates/).
 *
 * Drawn on a 1000 × 1294 unit page (US Letter, 2550 × 3300 px).
 */
const W = 1000;
const H = 1294;
const page = (doc: Pick<CompositeDocument, "width" | "height">) => kit(doc, W, H);
type Doc = Pick<CompositeDocument, "width" | "height">;

const ANTON = "Anton, Impact, sans-serif";
const BEBAS = "'Bebas Neue', Impact, sans-serif";
const MONT = "Montserrat, sans-serif";
const INTER = "Inter, system-ui, sans-serif";
const OSWALD = "Oswald, 'Arial Narrow', sans-serif";
const PLAYFAIR = "'Playfair Display', Georgia, serif";
const DMSERIF = "'DM Serif Display', Georgia, serif";
const RIGHTEOUS = "Righteous, sans-serif";
const SPACE = "'Space Mono', monospace";
const MARKER = "'Permanent Marker', cursive";
const BUNGEE = "'Bungee Shade', sans-serif";
const PIXEL = "'Press Start 2P', monospace";
const VT = "VT323, monospace";

/** A colour stop: a colour, or [colour, offset] / [colour, offset, opacity]. */
type Stop = string | readonly [string, number] | readonly [string, number, number];
const linear = (angle: number, ...stops: Stop[]): Gradient => ({
  type: "linear",
  angle,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  reverse: false,
  stops: stops.map((s, i) => {
    const [color, offset = i / Math.max(1, stops.length - 1), opacity = 1] = typeof s === "string" ? [s] : s;
    return { offset, color, opacity };
  }),
});
const radial = (...stops: Stop[]): Gradient => ({ ...linear(0, ...stops), type: "radial" });

/** A gradient over the whole page. */
const backdrop = (k: Kit, g: Gradient, name = "Background"): Layer => ({ ...gradientLayer(k.doc as CompositeDocument, g), name, transform: canvasTransform(k.doc) });
/** A flat colour over the whole page (under an effect, so it has something to work on). */
const paper = (k: Kit, color: string, name = "Paper"): Layer => shape(k, 0, 0, W, H, "rectangle", fill(color), { name });

/** An effect over everything below it in its group (or, clipped, over the layer below), with its starting values. */
const effect = (k: Kit, id: string, params: EffectParams = {}, extra: Partial<EffectLayer> = {}): EffectLayer => {
  const l = effectLayer(k.doc as CompositeDocument, id) as EffectLayer;
  return { ...l, effect: { ...l.effect, params: { ...l.effect.params, ...params } }, ...extra };
};
/** Static film grain over everything below: an effect that changes nothing but adds grain. */
const grain = (k: Kit, amount: number, size = 2): EffectLayer => ({ ...effect(k, "blur", { amount: 0, post_grain: true, post_grainAmount: amount, post_grainSize: size }), name: "Grain" });

/** A group that keeps its effects to itself, folded in the Layers panel. */
const set = (k: Kit, name: string, children: Layer[], extra: Partial<GroupLayer> = {}): GroupLayer => ({ ...group(k, name, children), ...extra });

/** Words people change: a text layer labelled for the Details form (copies share the label and change together). */
const field = (k: Kit, label: string, x: number, y: number, w: number, h: number, value: string, style: Partial<TextStyle> & { size: number }, extra: Partial<TextLayer> = {}): TextLayer =>
  text(k, x, y, w, h, value, style, { name: label, field: label, ...extra });
/** A photo frame with its own treatment: `effects` are clipped to it, so a photo put in comes out styled. */
const photo = (k: Kit, name: string, x: number, y: number, w: number, h: number, sh: SmartShape | SmartShape["kind"], placeholder: string, effects: EffectLayer[] = [], extra: Partial<SlotLayer> = {}): Layer[] => [
  frame(k, x, y, w, h, sh, { name, placeholder, ...extra }),
  ...effects.map((e) => ({ ...e, clip: true })),
];

const fill = (color: string, extra: Partial<PathStyle> = {}): Partial<PathStyle> => ({ fill: color, stroke: null, ...extra });
const line = (color: string, width: number, extra: Partial<PathStyle> = {}): Partial<PathStyle> => ({ fill: null, stroke: color, strokeWidth: width, ...extra });
const rounded = (round: number): SmartShape => ({ kind: "rectangle", points: 4, ratio: 0.5, round });
/** Turned by `deg` about its own centre. */
const turn = <T extends Layer>(l: T, deg: number): T => ({ ...l, transform: { ...l.transform, rotation: deg } });

/** A repeatable pseudo-random sequence (so a template draws the same every time). */
function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
}

/** A checkerboard of `cols × rows` cells of `cell` units from x, y. */
const checker = (k: Kit, x: number, y: number, cols: number, rows: number, cell: number, color: string, name = "Checkerboard") => {
  const subs: { closed: boolean; nodes: { x: number; y: number }[] }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if ((r + c) % 2 === 0) {
        const x0 = x + c * cell;
        const y0 = y + r * cell;
        subs.push({ closed: true, nodes: [{ x: x0, y: y0 }, { x: x0 + cell, y: y0 }, { x: x0 + cell, y: y0 + cell }, { x: x0, y: y0 + cell }] });
      }
  return path(k, subs, fill(color), name);
};

/** A four-pointed sparkle at cx, cy. */
const sparkle = (k: Kit, cx: number, cy: number, r: number, color: string, name = "Sparkle") => shape(k, cx - r, cy - r, r * 2, r * 2, { kind: "star", points: 4, ratio: 0.22, round: 0 }, fill(color), { name });

// ─── Crazy ──────────────────────────────────────────────────────────────────

/** Club night: acid colours, a burst, the title stacked like a cheap 3D sign, a CMYK print and a prism split. */
function clubNight(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#0d0d0d";
  const lime = "#c6ff00";
  const pink = "#ff2bd6";
  const title = { size: 330, font: ANTON, letterSpacing: 0.01 };
  // The extrude: copies of the title stepping down-right in alternating colours.
  const steps = [5, 4, 3, 2, 1].map((i) => field(k, "Title", 40 + i * 9, 110 + i * 9, 920, 340, "BASS", { ...title, color: i % 2 ? "#2d5bff" : pink }, { name: `Title depth ${i}` }));
  return [
    set(k, "Backdrop", [
      backdrop(k, linear(115, pink, "#ff7a00")),
      turn(shape(k, -160, -40, 1320, 1320, { kind: "burst", points: 28, ratio: 0.7, round: 0 }, fill(lime), { name: "Burst" }), 8),
      turn(checker(k, -200, 0, 30, 2, 50, ink, "Checker stripe"), -14),
      shape(k, 600, 560, 520, 520, "ring", { ...fill("#2d5bff"), fillOpacity: 1 }, { name: "Ring" }),
      effect(k, "halftone-cmyk", { size: 9, misregister: 2.5, density: 1.15, paper: "#fff4e6" }),
    ]),
    ...steps,
    field(k, "Title", 40, 110, 920, 340, "BASS", { ...title, color: ink }),
    field(k, "Subtitle", 40, 470, 920, 260, "RITUAL", { size: 240, font: ANTON, color: lime, letterSpacing: 0.02 }, { fx: fx(k, { outline: { color: ink, opacity: 1, width: 7 }, shadow: { color: ink, opacity: 1, angle: 135, distance: 16, blur: 0, spread: 0 } }) }),
    turn(shape(k, 710, 700, 240, 240, { kind: "burst", points: 16, ratio: 0.82, round: 0.2 }, fill("#ffffff", { stroke: ink, strokeWidth: 5 }), { name: "Sticker" }), -12),
    turn(field(k, "Sticker", 710, 740, 240, 160, "FREE\nB4 11", { size: 56, font: RIGHTEOUS, color: ink, lineHeight: 0.95 }), -12),
    shape(k, 0, 1010, 1000, 284, "rectangle", fill(ink), { name: "Details band" }),
    field(k, "Line-up", 50, 1030, 900, 60, "DJ NOVA · KAI RIVERS · MOTHERBOARD", { size: 40, font: MONT, weight: 700, color: "#ffffff", letterSpacing: 0.04 }),
    field(k, "Date", 50, 1110, 440, 90, "SAT 14 DEC", { size: 74, font: ANTON, color: lime, align: "left" }),
    field(k, "Time", 510, 1110, 440, 90, "10PM — LATE", { size: 74, font: ANTON, color: pink, align: "right" }),
    field(k, "Place", 50, 1205, 900, 50, "THE WAREHOUSE · 21 DOCK STREET", { size: 32, font: MONT, weight: 700, color: "#ffffff", letterSpacing: 0.12 }),
    effect(k, "prism", { dispersion: 6, leak: 0.08, leakAngle: 30, post_grain: true, post_grainAmount: 26 }, { name: "Print finish" }),
  ];
}

/** Birthday: a two-ink risograph zine, the photo and confetti printed together, a giant age. */
function birthday(doc: Doc): Layer[] {
  const k = page(doc);
  const pink = "#ff4fa3";
  const blue = "#1f5fbf";
  const rnd = random(7);
  const confetti: Layer[] = [];
  for (let i = 0; i < 46; i++) {
    const x = rnd() * 960 + 20;
    const y = rnd() * 1250 + 20;
    if (x > 170 && x < 830 && y > 140 && y < 760) continue; // keep the photo clear
    const color = rnd() < 0.5 ? pink : blue;
    const size = 18 + rnd() * 34;
    const kinds: SmartShape[] = [{ kind: "star", points: 5, ratio: 0.45, round: 0.1 }, smartShape("ellipse"), rounded(0.4), { kind: "polygon", points: 3, ratio: 0.5, round: 0.1 }];
    confetti.push(turn(shape(k, x, y, size, size * (rnd() < 0.3 ? 0.4 : 1), kinds[Math.floor(rnd() * kinds.length)], fill(color), { name: "Confetti" }), rnd() * 360));
  }
  return [
    set(k, "Riso print", [
      paper(k, "#f6f0e2"),
      field(k, "Age", -40, 20, 560, 640, "30", { size: 560, font: ANTON, color: blue }, { opacity: 0.9 }),
      ...photo(k, "Birthday photo", 230, 150, 540, 540, "ellipse", "#e86fa8"),
      shape(k, 230, 150, 540, 540, "ellipse", line(pink, 10), { name: "Photo ring" }),
      set(k, "Confetti", confetti),
      effect(k, "risograph", { inkA: pink, inkB: blue, paper: "#f6f0e2", grain: 2, misregister: 6, contrast: 1.2, seed: 3 }),
    ]),
    // Type printed in the two inks, the second slipped out of register.
    turn(field(k, "Name", 60, 690, 880, 150, "LUNA'S", { size: 124, font: MARKER, color: pink }, { fx: fx(k, { shadow: { color: blue, opacity: 0.9, angle: 30, distance: 9, blur: 0, spread: 0 } }) }), -4),
    field(k, "Title", 40, 850, 920, 240, "BIRTHDAY\nRIOT", { size: 124, font: ANTON, color: blue, lineHeight: 0.92, letterSpacing: 0.02 }, { fx: fx(k, { shadow: { color: pink, opacity: 0.9, angle: 210, distance: 10, blur: 0, spread: 0 } }) }),
    shape(k, 90, 1100, 820, 130, rounded(1), fill(blue), { name: "Details pill" }),
    field(k, "Date & time", 110, 1110, 780, 60, "SAT 6 DEC · 8PM TIL LATE", { size: 46, font: ANTON, color: "#f6f0e2", letterSpacing: 0.04 }),
    field(k, "Place", 110, 1170, 780, 44, "THE ROOFTOP · 12 ELM STREET", { size: 28, font: MONT, weight: 700, color: "#f6f0e2", letterSpacing: 0.14 }),
    turn(shape(k, 790, 40, 180, 180, { kind: "burst", points: 12, ratio: 0.8, round: 0.3 }, fill(pink), { name: "Sticker" }), 10),
    turn(field(k, "Sticker", 790, 85, 180, 90, "BRING\nGLITTER", { size: 30, font: ANTON, color: "#f6f0e2", lineHeight: 1 }), 10),
    grain(k, 22),
  ];
}

/** Punk gig: a photocopied zine. The band photo halftoned, torn strips, tape and a marker scrawl. */
function punkGig(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#111111";
  const red = "#e10600";
  const strip = (x: number, y: number, w: number, h: number, deg: number, name: string) => turn(shape(k, x, y, w, h, "rectangle", fill(ink), { name }), deg);
  const tape = (x: number, y: number, deg: number) => turn(shape(k, x, y, 170, 52, "rectangle", { fill: "#f2e86d", stroke: null, fillOpacity: 0.85 }, { name: "Tape" }), deg);
  return [
    paper(k, "#ebe7de"),
    set(k, "Band photo", [turn(set(k, "Photo", photo(k, "Band photo", 70, 150, 860, 700, "rectangle", "#5f5f5f", [effect(k, "halftone", { size: 9, angle: 45, shape: "dot", contrast: 1.7, ink, paper: "#ebe7de" })])), -2.5)], {
      fx: fx(k, { shadow: { color: "#000000", opacity: 0.35, angle: 100, distance: 8, blur: 10, spread: 0 } }),
    }),
    tape(40, 130, -18),
    tape(800, 820, -14),
    strip(20, 36, 820, 120, -3, "Title strip"),
    turn(field(k, "Band", 40, 46, 780, 100, "THE STATIC KIDS", { size: 80, font: MARKER, color: "#ffffff" }), -3),
    turn(field(k, "Shout", 560, 610, 440, 260, "LIVE!", { size: 230, font: ANTON, color: red }, { fx: fx(k, { outline: { color: ink, opacity: 1, width: 6 } }) }), 7),
    strip(60, 880, 560, 80, 2, "Support strip"),
    turn(field(k, "Support", 70, 888, 540, 64, "+ VELVET RUST + GLUE", { size: 46, font: MARKER, color: "#ffffff" }), 2),
    field(k, "Date", 60, 1000, 880, 120, "FRI 28 NOV", { size: 120, font: ANTON, color: ink, align: "left" }),
    shape(k, 60, 1135, 560, 64, "rectangle", fill(red), { name: "Highlighter" }),
    field(k, "Place", 70, 1138, 540, 58, "THE BASEMENT, 4 CANAL RD", { size: 40, font: OSWALD, weight: 700, color: "#ffffff", align: "left" }),
    field(k, "Entry", 60, 1215, 880, 50, "DOORS 8PM · £5 ON THE DOOR · ALL AGES", { size: 30, font: OSWALD, weight: 400, color: ink, align: "left", letterSpacing: 0.08 }),
    turn(field(k, "Note", 690, 1010, 280, 160, "no\nsleep\ntill\nmonday", { size: 40, font: MARKER, color: red, lineHeight: 0.9 }), -8),
    grain(k, 30, 3),
  ];
}

/** Summer festival: psychedelic rings from a topographic effect on colour blobs, a bent title. */
function festival(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#2b0a3d";
  const blob = (cx: number, cy: number, r: number, colors: Stop[], name: string) => shape(k, cx - r, cy - r, r * 2, r * 2, "ellipse", { fill: "#ffffff", stroke: null, fillGradient: radial(...colors) }, { name });
  return [
    set(k, "Melting rings", [
      backdrop(k, linear(160, "#ffd23f", "#ff6b35")),
      blob(250, 330, 420, ["#ff2e88", ["#ff6b35", 1, 0]], "Pink bloom"),
      blob(800, 640, 460, ["#7b2ff7", ["#ff2e88", 1, 0]], "Violet bloom"),
      blob(330, 1050, 420, ["#00c2a8", ["#ffd23f", 1, 0]], "Teal bloom"),
      effect(k, "paper-cut", { layers: 7, smooth: 14, shadow: 14, palette: "photo" }),
    ]),
    shape(k, 140, 230, 720, 720, "ellipse", fill("#fff3d6", { stroke: ink, strokeWidth: 8 }), { name: "Sun disc" }),
    sparkle(k, 500, 300, 60, ink),
    field(k, "Title", 170, 390, 660, 280, "SUNBURN", { size: 140, font: BUNGEE, color: ink, curve: 0.34, letterSpacing: 0.02 }),
    field(k, "Subtitle", 150, 640, 700, 120, "FESTIVAL", { size: 92, font: RIGHTEOUS, color: "#ff2e88", letterSpacing: 0.18 }),
    field(k, "Dates", 150, 760, 700, 80, "JULY 17—19", { size: 64, font: RIGHTEOUS, color: ink }),
    field(k, "Line-up", 60, 990, 880, 150, "MOON TAXI · PALM VIOLET\nTHE GOLDEN HOURS · SOFT LIGHTS", { size: 48, font: ANTON, color: "#fff3d6", lineHeight: 1.15, letterSpacing: 0.04 }, { fx: fx(k, { outline: { color: ink, opacity: 1, width: 6 } }) }),
    field(k, "Place", 60, 1170, 880, 60, "BLUE LAKE MEADOWS · CAMPING · 3 STAGES", { size: 34, font: MONT, weight: 700, color: ink, letterSpacing: 0.08 }),
    grain(k, 20),
  ];
}

/** Horror night: a B-movie title bleeding down the page, a halftone moon, red on black. */
function horrorNight(doc: Doc): Layer[] {
  const k = page(doc);
  const red = "#ff1e1e";
  const bone = "#f1e6cf";
  return [
    backdrop(k, linear(90, "#120000", "#3a0006", "#000000")),
    set(k, "Moon", [
      shape(k, 220, 110, 560, 560, "ellipse", { fill: bone, stroke: null, fillGradient: radial(["#ffffff", 0], [bone, 0.45], ["#5a4a33", 1]) }, { name: "Moon" }),
      effect(k, "halftone", { size: 11, angle: 30, shape: "dot", contrast: 1.3, invert: true, ink: bone, paper: "#000000" }),
    ], { blend: "screen" }),
    set(k, "Bleeding title", [
      field(k, "Title", 30, 560, 940, 250, "FRIGHT", { size: 250, font: ANTON, color: red, letterSpacing: 0.02 }),
      field(k, "Title line 2", 30, 780, 940, 250, "NIGHT", { size: 250, font: ANTON, color: red, letterSpacing: 0.06 }),
      effect(k, "streaks", { length: 160, threshold: 0.2, direction: "down", falloff: 0.35 }, { name: "Drips" }),
    ], { fx: fx(k, { glow: { color: "#ff0000", opacity: 0.5, blur: 40, spread: 0 } }) }),
    field(k, "Tagline", 60, 40, 880, 60, "THEY CAME FROM THE BASEMENT", { size: 34, font: OSWALD, weight: 700, color: red, letterSpacing: 0.3 }),
    field(k, "What", 60, 1060, 880, 60, "A DOUBLE FEATURE OF CLASSIC HORROR", { size: 34, font: OSWALD, weight: 400, color: bone, letterSpacing: 0.12 }),
    field(k, "Date & time", 60, 1120, 880, 80, "31 OCTOBER · MIDNIGHT", { size: 70, font: BEBAS, color: red, letterSpacing: 0.08 }),
    field(k, "Place", 60, 1200, 880, 50, "THE ORPHEUM CINEMA · COSTUMES WELCOME", { size: 30, font: OSWALD, weight: 400, color: bone, letterSpacing: 0.14 }),
    effect(k, "halftone-cmyk", { size: 3, misregister: 1.6, density: 1, paper: "#f1e6cf" }, { name: "Print", opacity: 0.18, blend: "overlay" }),
    grain(k, 34, 3),
  ];
}

// ─── Minimal ────────────────────────────────────────────────────────────────

/** Gallery opening: a sun and a block seen through reeded glass, a serif title, a quiet grid of facts. */
function galleryOpening(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#1b1b1b";
  const small = { size: 22, font: INTER, weight: 700, color: ink, letterSpacing: 0.14, align: "left" as const };
  return [
    shape(k, 130, 160, 540, 540, "ellipse", { fill: "#ff5a1f", stroke: null, fillGradient: radial("#ff8a4d", "#e8380d") }, { name: "Sun" }),
    set(k, "Glass panel", [
      shape(k, 400, 120, 600, 760, "rectangle", fill("#e6e0d4"), { name: "Panel" }),
      shape(k, 130, 160, 540, 540, "ellipse", { fill: "#ff5a1f", stroke: null, fillGradient: radial("#ff8a4d", "#e8380d") }, { name: "Sun behind the glass" }),
      shape(k, 560, 560, 260, 260, "ellipse", fill("#22324f"), { name: "Moon behind the glass" }),
      effect(k, "fluted-glass", { width: 26, strength: 1.3, frost: 0.12, dispersion: 0.03, highlight: 0.4 }, { name: "Reeded glass" }),
    ]),
    path(k, [{ closed: false, nodes: [{ x: 80, y: 960 }, { x: 920, y: 960 }] }], line(ink, 2), "Rule"),
    field(k, "Title", 80, 975, 840, 140, "Quiet Matter", { size: 118, font: PLAYFAIR, weight: 400, italic: true, color: ink, align: "left" }),
    field(k, "Artist", 80, 1120, 500, 40, "NEW WORK BY MARA ILVES", small),
    field(k, "Dates", 80, 1160, 500, 40, "14 NOV — 20 DEC 2026", small),
    field(k, "Place", 560, 1120, 360, 40, "HALDEN GALLERY", { ...small, align: "right" }),
    field(k, "Address", 560, 1160, 360, 40, "8 RUE VASSE, LYON", { ...small, align: "right" }),
    field(k, "Opening", 80, 70, 840, 40, "OPENING NIGHT · THU 13 NOV · 7 PM", { ...small, size: 20 }),
    grain(k, 14),
  ];
}

/** Wedding: one tall photo with a film glow, names in a display serif, thin gold rules. */
function wedding(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#2d2a26";
  const gold = "#b08d57";
  const small = { size: 22, font: INTER, weight: 400, color: ink, letterSpacing: 0.3 };
  return [
    ...photo(k, "Couple photo", 260, 110, 480, 640, rounded(1), "#d9c7b0", [
      effect(k, "glow", { threshold: 0.55, radius: 50, intensity: 0.8, soften: 0.4, tint: "#ffd9b0" }, { name: "Film glow" }),
      grain(k, 18),
    ]),
    shape(k, 240, 90, 520, 680, rounded(1), line(gold, 2), { name: "Gold outline" }),
    field(k, "Invite", 100, 800, 800, 40, "TOGETHER WITH THEIR FAMILIES", small),
    field(k, "Names", 60, 845, 880, 170, "Ana & Leo", { size: 150, font: DMSERIF, color: ink }),
    field(k, "Ask", 100, 1015, 800, 40, "INVITE YOU TO CELEBRATE THEIR WEDDING", small),
    path(k, [{ closed: false, nodes: [{ x: 360, y: 1085 }, { x: 640, y: 1085 }] }], line(gold, 2), "Rule"),
    field(k, "Date", 100, 1100, 800, 70, "18 · 09 · 2027", { size: 52, font: PLAYFAIR, weight: 400, color: ink, letterSpacing: 0.12 }),
    field(k, "Place", 100, 1175, 800, 40, "VILLA SERRA, LAKE COMO · 4 PM", small),
    field(k, "RSVP", 100, 1220, 800, 36, "RSVP BY 1 JULY", { ...small, size: 18, color: gold }),
    grain(k, 10),
  ];
}

/** Lecture: a Swiss grid, a giant number, a dithered gradient block for the idea. */
function lecture(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#111111";
  const red = "#e4322b";
  const label = { size: 20, font: INTER, weight: 700, color: ink, letterSpacing: 0.08, align: "left" as const };
  return [
    set(k, "Dither block", [shape(k, 480, 80, 440, 620, "rectangle", { fill: "#000000", stroke: null, fillGradient: linear(70, "#000000", "#ffffff") }, { name: "Gradient" }), effect(k, "dither", { pixel: 5, palette: "bit", matrix: "8", spread: 1, contrast: 1.2 })]),
    shape(k, 80, 80, 140, 140, "rectangle", fill(red), { name: "Red square" }),
    field(k, "Number", 60, 220, 420, 360, "04", { size: 330, font: INTER, weight: 700, color: ink, align: "left", letterSpacing: -0.06 }),
    field(k, "Series", 80, 600, 380, 40, "LECTURE SERIES — FALL", label),
    path(k, [{ closed: false, nodes: [{ x: 80, y: 740 }, { x: 920, y: 740 }] }], line(ink, 3), "Rule"),
    field(k, "Title", 80, 760, 840, 250, "On Machines\nThat Dream", { size: 104, font: INTER, weight: 700, color: ink, align: "left", lineHeight: 1.02, letterSpacing: -0.035 }),
    field(k, "Speaker", 80, 1060, 420, 40, "DR. IRIS OKAFOR", label),
    field(k, "Speaker role", 80, 1095, 420, 40, "Professor of Cognitive Science", { ...label, weight: 400, letterSpacing: 0 }),
    field(k, "Date & time", 520, 1060, 400, 40, "WED 3 DEC, 18:30", label),
    field(k, "Place", 520, 1095, 400, 40, "Main Hall, Room 1.04", { ...label, weight: 400, letterSpacing: 0 }),
    field(k, "Entry", 80, 1200, 840, 40, "FREE ENTRY · ALL WELCOME", { ...label, color: red }),
  ];
}

/** Wellness retreat: a soft colour field under a frosted glass panel, a lower-case serif word. */
function retreat(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#3b3346";
  const blob = (cx: number, cy: number, r: number, color: string, name: string) => shape(k, cx - r, cy - r, r * 2, r * 2, "ellipse", fill(color), { name });
  return [
    set(k, "Colour field", [
      paper(k, "#f4e9e1"),
      blob(220, 260, 330, "#f7b8a1", "Peach"),
      blob(820, 420, 360, "#c9b6f2", "Lilac"),
      blob(380, 900, 380, "#b9d8c2", "Sage"),
      blob(860, 1150, 280, "#f6d58e", "Honey"),
      effect(k, "blur", { amount: 70 }),
      effect(k, "liquid-glass", { shape: "pill", size: 0.62, cx: 0.5, cy: 0.47, corner: 1, refraction: 0.6, bevel: 70, frost: 0.55, dispersion: 0.05, rim: 0.4, light: 120, tint: "#ffffff", tintAmount: 0.18, shadow: 0.2 }, { name: "Frosted glass" }),
    ]),
    field(k, "Title", 100, 420, 800, 230, "breathe", { size: 190, font: PLAYFAIR, italic: true, color: ink }),
    field(k, "Subtitle", 100, 640, 800, 50, "A WEEKEND OF YOGA, SILENCE & SLOW FOOD", { size: 24, font: INTER, weight: 700, color: ink, letterSpacing: 0.18 }),
    field(k, "Dates", 100, 1140, 800, 50, "21—23 MARCH 2027", { size: 34, font: PLAYFAIR, color: ink, letterSpacing: 0.1 }),
    field(k, "Place", 100, 1190, 800, 40, "CASA DEL MONTE, ALENTEJO · BOOK AT BREATHE.RETREAT", { size: 18, font: INTER, weight: 400, color: ink, letterSpacing: 0.16 }),
    grain(k, 12),
  ];
}

/** Jazz night: a spotlight rendered as gold halftone on black, a serif title, almost nothing else. */
function jazzNight(doc: Doc): Layer[] {
  const k = page(doc);
  const gold = "#d4af6a";
  return [
    set(k, "Spotlight", [
      shape(k, 100, 40, 800, 800, "ellipse", { fill: "#ffffff", stroke: null, fillGradient: radial(["#ffffff", 0], ["#b0b0b0", 0.3], ["#000000", 1]) }, { name: "Light" }),
      effect(k, "halftone", { size: 13, angle: 45, shape: "dot", contrast: 1.1, invert: true, ink: gold, paper: "#000000" }),
    ], { blend: "screen" }),
    field(k, "Series", 100, 860, 800, 40, "JAZZ SESSIONS · VOL. 3", { size: 22, font: INTER, weight: 700, color: gold, letterSpacing: 0.4 }),
    field(k, "Title", 60, 900, 880, 180, "Blue Hour", { size: 150, font: DMSERIF, color: "#f3ead9" }),
    field(k, "Line-up", 100, 1085, 800, 44, "The Maren Holt Trio with Sid Adeyemi", { size: 30, font: PLAYFAIR, italic: true, color: "#f3ead9" }),
    path(k, [{ closed: false, nodes: [{ x: 470, y: 1150 }, { x: 530, y: 1150 }] }], line(gold, 2), "Rule"),
    field(k, "Date & time", 100, 1170, 800, 40, "FRIDAYS IN JANUARY · 9 PM", { size: 22, font: INTER, weight: 700, color: gold, letterSpacing: 0.3 }),
    field(k, "Place", 100, 1210, 800, 40, "THE LANTERN ROOM", { size: 22, font: INTER, weight: 400, color: "#f3ead9", letterSpacing: 0.3 }),
    grain(k, 16),
  ];
}

/** Book reading: an engraved sphere like a banknote vignette, an editorial serif and a quiet footer. */
function bookReading(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#1f2a44";
  const small = { size: 21, font: INTER, weight: 700, color: ink, letterSpacing: 0.18 };
  return [
    set(k, "Engraving", [
      shape(k, 230, 150, 540, 540, "ellipse", { fill: "#ffffff", stroke: null, fillGradient: radial(["#cfcfcf", 0], ["#6e6e6e", 0.5], ["#121212", 1]) }, { name: "Sphere" }),
      effect(k, "engraving", { spacing: 6.5, angle: 28, relief: 1.8, cross: false, ink, paper: "#f3efe6" }),
    ]),
    field(k, "Kicker", 100, 760, 800, 40, "AN EVENING WITH NOOR HADDAD", small),
    field(k, "Title", 40, 800, 920, 170, "The Salt Archive", { size: 120, font: DMSERIF, color: ink }),
    field(k, "Subtitle", 100, 975, 800, 44, "A reading from the new novel, and a conversation", { size: 30, font: PLAYFAIR, italic: true, color: ink }),
    path(k, [{ closed: false, nodes: [{ x: 100, y: 1110 }, { x: 900, y: 1110 }] }], line(ink, 1.5), "Rule"),
    field(k, "Date & time", 100, 1130, 380, 40, "THU 5 FEB · 7 PM", { ...small, align: "left" }),
    field(k, "Place", 520, 1130, 380, 40, "MARLOWE BOOKS, LEEDS", { ...small, align: "right" }),
    field(k, "Note", 100, 1175, 800, 36, "Free entry · signed copies", { size: 20, font: INTER, weight: 400, color: ink, align: "left" }),
    grain(k, 12),
  ];
}

/** Design week: Bauhaus primaries in a tight print, lower-case grotesque type set flush left. */
function designWeek(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#141414";
  const label = { size: 22, font: INTER, weight: 700, color: ink, align: "left" as const };
  return [
    set(k, "Shapes", [
      shape(k, 80, 80, 400, 400, "ellipse", fill("#e63b2e"), { name: "Circle" }),
      shape(k, 520, 80, 400, 400, "rectangle", fill("#1d4ed8"), { name: "Square" }),
      shape(k, 520, 300, 400, 380, { kind: "polygon", points: 3, ratio: 0.5, round: 0 }, fill("#f5c518"), { name: "Triangle" }),
      shape(k, 80, 520, 400, 160, "rectangle", fill(ink), { name: "Bar" }),
      effect(k, "halftone-cmyk", { size: 3.5, misregister: 0.7, density: 1.05, paper: "#f2ede3" }),
    ]),
    field(k, "Title", 66, 720, 880, 330, "design\nweek", { size: 190, font: INTER, weight: 700, color: ink, align: "left", lineHeight: 0.86, letterSpacing: -0.05 }),
    field(k, "Dates", 80, 1090, 420, 40, "08—14.03.2027", label),
    field(k, "What", 80, 1125, 420, 40, "Talks, workshops, open studios", { ...label, weight: 400 }),
    field(k, "Place", 520, 1090, 400, 40, "Kunsthalle Nord", { ...label, align: "right" }),
    field(k, "Website", 520, 1125, 400, 40, "designweek.example", { ...label, weight: 400, align: "right" }),
    grain(k, 10),
  ];
}

/** Tea ceremony: one red sun drawn in ink dots, a lot of paper, a serif title. */
function teaCeremony(doc: Doc): Layer[] {
  const k = page(doc);
  const red = "#b3261e";
  const ink = "#2a2522";
  return [
    set(k, "Ink sun", [
      shape(k, 290, 170, 420, 420, "ellipse", { fill: red, stroke: null, fillGradient: radial(["#5a0f0a", 0], ["#3a0905", 0.7], ["#1a0402", 1]) }, { name: "Sun" }),
      effect(k, "stipple", { size: 2.4, density: 1.35, mode: "ink", ink: red, paper: "#f4efe4", seed: 5 }),
    ]),
    field(k, "Title", 100, 700, 800, 150, "Slow Tea", { size: 120, font: DMSERIF, color: ink }),
    field(k, "Subtitle", 100, 860, 800, 40, "A TEA CEREMONY IN FOUR SEASONS", { size: 22, font: INTER, weight: 700, color: ink, letterSpacing: 0.32 }),
    shape(k, 493, 950, 14, 14, "ellipse", fill(red), { name: "Dot" }),
    field(k, "Date & time", 100, 1010, 800, 44, "Sundays in April · 11:00 and 15:00", { size: 30, font: PLAYFAIR, italic: true, color: ink }),
    field(k, "Place", 100, 1060, 800, 40, "THE GARDEN PAVILION, 3 KEW ROW", { size: 20, font: INTER, weight: 700, color: ink, letterSpacing: 0.24 }),
    field(k, "Note", 100, 1190, 800, 36, "Ten guests a sitting · book ahead", { size: 19, font: INTER, weight: 400, color: red, letterSpacing: 0.1 }),
    grain(k, 12),
  ];
}

/** Photography show: a contour map drawn from soft hills, the title tracked wide. */
function terrain(doc: Doc): Layer[] {
  const k = page(doc);
  const ink = "#2f4a3a";
  const hill = (cx: number, cy: number, r: number, color: string, name: string) => shape(k, cx - r, cy - r, r * 2, r * 2, "ellipse", { fill: color, stroke: null, fillGradient: radial([color, 0], [color, 1, 0]) }, { name });
  return [
    set(k, "Contour map", [
      shape(k, 0, 0, 1000, 840, "rectangle", { fill: "#808080", stroke: null, fillGradient: linear(60, "#b8b8b8", "#5a5a5a") }, { name: "Land" }),
      hill(330, 300, 360, "#111111", "Hill"),
      hill(720, 520, 320, "#202020", "Ridge"),
      hill(470, 640, 180, "#ffffff", "Valley"),
      hill(820, 160, 200, "#f0f0f0", "Lake"),
      effect(k, "contours", { levels: 26, smooth: 16, width: 1.1, style: "ink", index: true, ink, paper: "#eef0ea" }),
    ]),
    field(k, "Title", 40, 900, 920, 140, "TERRAIN", { size: 120, font: INTER, weight: 700, color: ink, letterSpacing: 0.42 }),
    field(k, "Subtitle", 100, 1040, 800, 40, "Landscape photographs by Elin Saro", { size: 28, font: PLAYFAIR, italic: true, color: ink }),
    field(k, "Dates", 80, 1180, 420, 40, "6 MAR — 27 APR 2027", { size: 21, font: INTER, weight: 700, color: ink, letterSpacing: 0.16, align: "left" }),
    field(k, "Place", 500, 1180, 420, 40, "FJELL GALLERY, BERGEN", { size: 21, font: INTER, weight: 700, color: ink, letterSpacing: 0.16, align: "right" }),
  ];
}

/** Recital: a warm light seen through rippled glass, like sound spreading, on deep navy. */
function recital(doc: Doc): Layer[] {
  const k = page(doc);
  const cream = "#f3ead9";
  const gold = "#e0b26b";
  return [
    set(k, "Rippled light", [
      paper(k, "#131a2e"),
      shape(k, 160, 120, 680, 680, "ellipse", { fill: gold, stroke: null, fillGradient: radial(["#ffd79a", 0], ["#e0905a", 0.45], ["#131a2e", 1]) }, { name: "Light" }),
      effect(k, "fluted-glass", { shape: "rings", width: 34, strength: 1.6, frost: 0.1, dispersion: 0.05, highlight: 0.45 }, { name: "Rippled glass" }),
    ]),
    field(k, "Kicker", 100, 860, 800, 40, "AN EVENING RECITAL", { size: 22, font: INTER, weight: 700, color: gold, letterSpacing: 0.4 }),
    field(k, "Title", 40, 900, 920, 150, "Cello & Silence", { size: 108, font: PLAYFAIR, italic: true, color: cream }),
    field(k, "Programme", 100, 1060, 800, 80, "Bach · Kodály · Pärt\nperformed by Ines Varga", { size: 26, font: INTER, weight: 400, color: cream, lineHeight: 1.5 }),
    field(k, "Date & time", 100, 1170, 800, 40, "SAT 21 FEB · 8 PM", { size: 22, font: INTER, weight: 700, color: gold, letterSpacing: 0.3 }),
    field(k, "Place", 100, 1210, 800, 40, "ST. ANNE'S CHAPEL", { size: 22, font: INTER, weight: 400, color: cream, letterSpacing: 0.3 }),
    grain(k, 14),
  ];
}

/** Open studios: two-colour paper hills, a short sans title and a tidy footer. */
function openStudios(doc: Doc): Layer[] {
  const k = page(doc);
  const navy = "#1d3557";
  const wave = (y: number, amp: number, phase: number, color: string, name: string) =>
    path(k, [{ closed: true, nodes: [...Array.from({ length: 41 }, (_, i) => ({ x: (i / 40) * 1000, y: y + Math.sin((i / 40) * Math.PI * 2 + phase) * amp })), { x: 1000, y: 760 }, { x: 0, y: 760 }] }], fill(color), name);
  return [
    set(k, "Paper hills", [
      paper(k, "#fbf1e1"),
      wave(260, 40, 0.4, "#e9b98a", "Far hills"),
      wave(380, 55, 2.1, "#c98f6a", "Hills"),
      wave(500, 45, 4.2, "#5b6b8c", "Near hills"),
      wave(620, 35, 1.3, navy, "Front hills"),
      shape(k, 660, 110, 150, 150, "ellipse", fill("#f6dfb6"), { name: "Sun" }),
      effect(k, "paper-cut", { layers: 8, smooth: 6, shadow: 12, palette: "photo" }),
    ]),
    field(k, "Title", 80, 820, 840, 150, "Open Studios", { size: 112, font: INTER, weight: 700, color: navy, align: "left", letterSpacing: -0.03 }),
    field(k, "Subtitle", 80, 965, 840, 44, "Twenty artists open their doors for one weekend", { size: 28, font: INTER, weight: 400, color: navy, align: "left" }),
    path(k, [{ closed: false, nodes: [{ x: 80, y: 1090 }, { x: 920, y: 1090 }] }], line(navy, 2), "Rule"),
    field(k, "Dates", 80, 1110, 420, 40, "SAT 16 — SUN 17 MAY", { size: 22, font: INTER, weight: 700, color: navy, letterSpacing: 0.12, align: "left" }),
    field(k, "Place", 500, 1110, 420, 40, "RIVERSIDE MILLS", { size: 22, font: INTER, weight: 700, color: navy, letterSpacing: 0.12, align: "right" }),
    field(k, "Hours", 80, 1150, 840, 40, "11:00 — 18:00 · free · map at the gate", { size: 20, font: INTER, weight: 400, color: navy, align: "left" }),
    grain(k, 10),
  ];
}

// ─── Futuristic ─────────────────────────────────────────────────────────────

/** Hackathon: liquid chrome title over a neon grid horizon. */
function hackathon(doc: Doc): Layer[] {
  const k = page(doc);
  const cyan = "#3df2ff";
  const mono = { font: SPACE, color: "#d8f9ff", letterSpacing: 0.08 };
  const horizon = 760;
  // A floor grid in perspective: lines fanning from the vanishing point, rungs closing up.
  const rays: SubPath[] = Array.from({ length: 21 }, (_, i) => ({ closed: false, nodes: [{ x: 500 + (i - 10) * 18, y: horizon }, { x: 500 + (i - 10) * 260, y: H + 40 }] }));
  const rungs: SubPath[] = Array.from({ length: 9 }, (_, i) => {
    const y = horizon + (H + 40 - horizon) * (i / 8) ** 1.9;
    return { closed: false, nodes: [{ x: -1600, y }, { x: 2600, y }] };
  });
  return [
    backdrop(k, linear(90, ["#05060a", 0], ["#140a2e", 0.55], ["#05060a", 1])),
    shape(k, 100, 380, 800, 800, "ellipse", { fill: "#ff3df2", stroke: null, fillGradient: radial(["#ff4fd8", 0], ["#7a2bff", 0.4, 0.8], ["#140a2e", 1, 0]) }, { name: "Horizon glow" }),
    set(k, "Grid", [path(k, [...rays, ...rungs], line(cyan, 2), "Floor grid")], { opacity: 0.55, fx: fx(k, { glow: { color: cyan, opacity: 0.9, blur: 14, spread: 0.1 } }) }),
    set(k, "Chrome title", [
      field(k, "Title", 40, 250, 920, 330, "HACK", { size: 320, font: ANTON, color: "#ffffff", letterSpacing: 0.02 }),
      field(k, "Year", 40, 545, 920, 170, "/26", { size: 160, font: ANTON, color: "#ffffff", letterSpacing: 0.04 }),
      effect(k, "liquid-metal", { metal: "chrome", shape: "bright", threshold: 0.5, background: "#000000", flow: 0.35, scale: 140, relief: 1.4, ripples: 0.25 }),
    ], { blend: "screen" }),
    field(k, "Tagline", 40, 80, 920, 50, "48 HOURS · 6 TRACKS · NO SLEEP", { ...mono, size: 30, color: cyan }),
    field(k, "Date", 60, 1000, 880, 70, "21—23 NOV 2026", { ...mono, size: 56, weight: 700, color: "#ffffff" }),
    field(k, "Place", 60, 1080, 880, 50, "DEPOT 9 · ROTTERDAM", { ...mono, size: 30 }),
    set(k, "Register button", [
      shape(k, 290, 1160, 420, 76, rounded(1), { fill: null, stroke: cyan, strokeWidth: 3 }, { name: "Button" }),
      field(k, "Sign-up", 290, 1160, 420, 76, "REGISTER → HACK26.DEV", { ...mono, size: 26, weight: 700, color: cyan }),
    ], { fx: fx(k, { glow: { color: cyan, opacity: 0.8, blur: 18, spread: 0 } }) }),
    effect(k, "glow", { threshold: 0.62, radius: 40, intensity: 0.9, tint: "#7fdcff", post_grain: true, post_grainAmount: 18 }, { name: "Bloom" }),
  ];
}

/** Electronic festival: a giant word bent through a liquid glass lens. */
function synthGlass(doc: Doc): Layer[] {
  const k = page(doc);
  const white = "#ffffff";
  return [
    set(k, "Lens scene", [
      backdrop(k, linear(150, "#ff3d6e", "#7a2bff", "#00d4ff")),
      shape(k, -100, 700, 700, 700, "ellipse", { fill: "#ffb000", stroke: null, fillGradient: radial("#ffb000", ["#ff3d6e", 1, 0]) }, { name: "Warm glow" }),
      field(k, "Title", -60, 380, 1120, 420, "SYNTH", { size: 400, font: ANTON, color: white, letterSpacing: 0.01 }),
      field(k, "Title", -60, 380, 1120, 420, "SYNTH", { size: 400, font: ANTON, color: white, letterSpacing: 0.01 }, { name: "Title shadow", opacity: 0.25, transform: text(k, -60, 392, 1120, 420, "", { size: 400 }).transform, fx: fx(k, { blur: 18 }) }),
      effect(k, "liquid-glass", { shape: "pill", size: 0.9, cx: 0.5, cy: 0.455, corner: 1, refraction: 0.8, bevel: 60, frost: 0.04, dispersion: 0.12, rim: 0.8, light: 135, tint: "#ffffff", tintAmount: 0.06, shadow: 0.4 }, { name: "Glass bar" }),
    ]),
    field(k, "Kicker", 60, 90, 880, 50, "AN ALL-NIGHT ELECTRONIC FESTIVAL", { size: 26, font: INTER, weight: 700, color: white, letterSpacing: 0.32 }),
    field(k, "Line-up", 60, 960, 880, 140, "AURORA KEYS · NEON MONK · FLUX\nHALCYON · DR. LOOP · PALE BLUE", { size: 40, font: INTER, weight: 700, color: white, lineHeight: 1.35, letterSpacing: 0.06 }),
    field(k, "Date", 60, 1130, 440, 60, "06.06.2027", { size: 44, font: SPACE, weight: 700, color: white, align: "left" }),
    field(k, "Place", 500, 1130, 440, 60, "HANGAR 2, BERLIN", { size: 34, font: SPACE, weight: 700, color: white, align: "right" }),
    field(k, "Tickets", 60, 1200, 880, 40, "TICKETS FROM 1 MARCH · SYNTH.FM", { size: 22, font: SPACE, color: white, letterSpacing: 0.12 }),
    grain(k, 14),
  ];
}

/** Product launch: an iridescent liquid-metal form floating in the dark, a clean sans title. */
function launch(doc: Doc): Layer[] {
  const k = page(doc);
  return [
    set(k, "Holographic form", [
      paper(k, "#000000"),
      shape(k, 200, 160, 600, 600, "ellipse", { fill: "#ffffff", stroke: null, fillGradient: radial(["#ffffff", 0], ["#cfcfcf", 0.55], ["#000000", 1]) }, { name: "Sphere" }),
      effect(k, "liquid-metal", { metal: "iridescent", shape: "bright", threshold: 0.12, background: "#000000", flow: 0.12, scale: 420, relief: 1.1, smooth: 18, ripples: 0.05, post_bloom: true, post_threshold: 0.7, post_intensity: 0.7 }),
    ]),
    field(k, "Kicker", 80, 880, 840, 40, "INTRODUCING", { size: 24, font: INTER, weight: 700, color: "#9aa0ff", letterSpacing: 0.5 }),
    field(k, "Title", 40, 920, 920, 170, "Prism One", { size: 140, font: INTER, weight: 700, color: "#ffffff", letterSpacing: -0.04 }),
    field(k, "Tagline", 80, 1090, 840, 50, "The launch event · live and online", { size: 32, font: INTER, weight: 400, color: "#c8c8d8" }),
    field(k, "Date & time", 80, 1180, 840, 40, "12 FEB 2027 · 19:00 CET", { size: 22, font: SPACE, color: "#ffffff", letterSpacing: 0.12 }),
    field(k, "Place", 80, 1220, 840, 40, "PRISM.LIVE/ONE", { size: 22, font: SPACE, color: "#9aa0ff", letterSpacing: 0.12 }),
  ];
}

/** Esports night: the title and a versus card on an LED wall, scoreboard style. */
function gameNight(doc: Doc): Layer[] {
  const k = page(doc);
  const amber = "#ffb300";
  const cyan = "#00e5ff";
  return [
    set(k, "LED wall", [
      backdrop(k, linear(90, "#0a0f2c", "#1b0636")),
      field(k, "Title", 40, 120, 920, 260, "GAME ON", { size: 210, font: ANTON, color: amber, letterSpacing: 0.04 }),
      field(k, "Event", 40, 380, 920, 110, "GRAND FINAL", { size: 100, font: ANTON, color: "#ffffff", letterSpacing: 0.12 }),
      effect(k, "led", { size: 6.5, style: "led", glow: 0.9, gain: 1.6 }),
    ]),
    field(k, "Team 1", 40, 540, 400, 220, "RED\nFOXES", { size: 100, font: ANTON, color: "#ff3b3b", lineHeight: 0.95 }, { fx: fx(k, { glow: { color: "#ff3b3b", opacity: 0.7, blur: 24, spread: 0 } }) }),
    field(k, "Versus", 430, 590, 140, 120, "VS", { size: 80, font: PIXEL, color: "#ffffff" }),
    field(k, "Team 2", 560, 540, 400, 220, "ICE\nWOLVES", { size: 100, font: ANTON, color: cyan, lineHeight: 0.95 }, { fx: fx(k, { glow: { color: cyan, opacity: 0.7, blur: 24, spread: 0 } }) }),
    shape(k, 60, 860, 880, 2, "rectangle", fill(cyan), { name: "Rule", fx: fx(k, { glow: { color: cyan, opacity: 1, blur: 12, spread: 0 } }) }),
    field(k, "Date & time", 60, 900, 880, 70, "SAT 17 JAN · 7PM", { size: 44, font: PIXEL, color: "#ffffff" }),
    field(k, "Place", 60, 990, 880, 60, "ARENA 5 · BIG SCREEN · FREE ENTRY", { size: 48, font: VT, color: cyan, letterSpacing: 0.06 }),
    field(k, "Prize", 60, 1070, 880, 60, "£2,000 PRIZE POOL", { size: 54, font: VT, color: amber, letterSpacing: 0.1 }),
    field(k, "Stream", 60, 1180, 880, 50, "WATCH LIVE: TWITCH.TV/ARENA5", { size: 22, font: PIXEL, color: "#8f9bd6" }),
    effect(k, "glow", { threshold: 0.55, radius: 30, intensity: 0.8, tint: "#ffffff" }, { name: "Bloom" }),
  ];
}

/** Space night: a halftone planet, glowing orbits, wide-tracked thin type. */
function spaceNight(doc: Doc): Layer[] {
  const k = page(doc);
  const ice = "#dff6ff";
  const rnd = random(11);
  const stars: Layer[] = Array.from({ length: 60 }, () => {
    const r = 1.5 + rnd() * 3;
    return shape(k, rnd() * 1000 - r, rnd() * 1294 - r, r * 2, r * 2, "ellipse", fill("#ffffff"), { name: "Star", opacity: 0.4 + rnd() * 0.6 });
  });
  const orbit = (w: number, h: number, deg: number, name: string) => turn(shape(k, 500 - w / 2, 520 - h / 2, w, h, "ellipse", line(ice, 2.5), { name }), deg);
  return [
    backdrop(k, radial(["#1a2a6c", 0], ["#0b1030", 0.6], ["#03040c", 1])),
    set(k, "Stars", stars),
    set(k, "Planet", [
      shape(k, 270, 290, 460, 460, "ellipse", { fill: "#7fd3ff", stroke: null, fillGradient: radial(["#ffffff", 0], ["#7fd3ff", 0.35], ["#2b3a8f", 0.8], ["#0b1030", 1]) }, { name: "Planet" }),
      effect(k, "halftone", { size: 7, angle: 20, shape: "dot", contrast: 1.2, invert: true, ink: "#9fe3ff", paper: "#03040c" }),
    ], { blend: "screen" }),
    set(k, "Orbits", [orbit(900, 220, -18, "Orbit"), orbit(760, 160, -18, "Inner orbit")], { opacity: 0.7, fx: fx(k, { glow: { color: "#7fd3ff", opacity: 1, blur: 10, spread: 0 } }) }),
    sparkle(k, 820, 330, 26, "#ffffff"),
    field(k, "Title", 40, 840, 920, 140, "O R B I T", { size: 120, font: INTER, weight: 400, color: ice, letterSpacing: 0.2 }),
    field(k, "Subtitle", 60, 980, 880, 50, "A NIGHT UNDER THE STARS", { size: 28, font: INTER, weight: 700, color: "#7fd3ff", letterSpacing: 0.4 }),
    field(k, "Details", 60, 1080, 880, 90, "TELESCOPES · TALKS · HOT CHOCOLATE", { size: 26, font: SPACE, color: ice, letterSpacing: 0.12 }),
    field(k, "Date & place", 60, 1180, 880, 50, "FRI 14 MAR, 21:00 · HILLTOP OBSERVATORY", { size: 24, font: SPACE, weight: 700, color: ice, letterSpacing: 0.08 }),
    effect(k, "glow", { threshold: 0.55, radius: 40, intensity: 1, tint: "#9fd8ff", post_grain: true, post_grainAmount: 16 }, { name: "Bloom" }),
  ];
}

/**
 * Frutiger Aero (the glossy mid-2000s look): a bright sky over green hills, clouds, bubbles,
 * white swooshes, a glass orb, a frosted panel and a glossy button.
 */
function frutigerAero(doc: Doc): Layer[] {
  const k = page(doc);
  const deep = "#0d47a1";
  const bubble = (cx: number, cy: number, r: number): Layer[] => [
    shape(k, cx - r, cy - r, r * 2, r * 2, "ellipse", { fill: "#ffffff", stroke: "#ffffff", strokeWidth: 2, strokeOpacity: 0.85, fillGradient: radial(["#ffffff", 0, 0.05], ["#bfe9ff", 0.75, 0.2], ["#ffffff", 1, 0.75]) }, { name: "Bubble" }),
    turn(shape(k, cx - r * 0.62, cy - r * 0.72, r * 0.7, r * 0.38, "ellipse", { fill: "#ffffff", stroke: null, fillOpacity: 0.85 }, { name: "Bubble shine" }), -30),
  ];
  // A cloud: overlapping puffs, softened, `w` units wide from x, y.
  const cloud = (x: number, y: number, w: number) =>
    set(k, "Cloud", [
      shape(k, x, y + w * 0.18, w * 0.5, w * 0.32, "ellipse", fill("#ffffff"), { name: "Puff" }),
      shape(k, x + w * 0.22, y, w * 0.45, w * 0.42, "ellipse", fill("#ffffff"), { name: "Puff" }),
      shape(k, x + w * 0.5, y + w * 0.1, w * 0.38, w * 0.34, "ellipse", fill("#ffffff"), { name: "Puff" }),
      shape(k, x + w * 0.1, y + w * 0.26, w * 0.85, w * 0.2, rounded(1), fill("#ffffff"), { name: "Puff" }),
    ], { opacity: 0.92, fx: fx(k, { blur: 5 }) });
  const swoosh = (y: number, amp: number, phase: number, width: number, opacity: number) =>
    path(k, [{ closed: false, nodes: Array.from({ length: 49 }, (_, i) => ({ x: -40 + (i / 48) * 1080, y: y + Math.sin((i / 48) * Math.PI * 1.6 + phase) * amp })) }], line("#ffffff", width, { cap: "round" }), "Swoosh", { opacity });
  return [
    set(k, "Sky and hills", [
      backdrop(k, linear(90, ["#1565c0", 0], ["#42a5f5", 0.35], ["#b3e5fc", 0.62], ["#e8f8ff", 0.72])),
      shape(k, 480, -260, 760, 760, "ellipse", { fill: "#ffffff", stroke: null, fillGradient: radial(["#ffffff", 0, 0.95], ["#fffde7", 0.25, 0.6], ["#ffffff", 1, 0]) }, { name: "Sun" }),
      cloud(40, 80, 300),
      cloud(560, 210, 240),
      cloud(330, 40, 170),
      shape(k, -380, 820, 1200, 760, "ellipse", { fill: "#7ed957", stroke: null, fillGradient: radial(["#c6f36b", 0], ["#6cc644", 0.6], ["#2e8b2e", 1]) }, { name: "Far hill" }),
      shape(k, 300, 900, 1200, 760, "ellipse", { fill: "#56ab2f", stroke: null, fillGradient: radial(["#b6f05a", 0], ["#4caf50", 0.55], ["#1b6e20", 1]) }, { name: "Near hill" }),
      set(k, "Swooshes", [swoosh(760, 60, 0.2, 7, 0.75), swoosh(800, 70, 0.8, 3, 0.55), swoosh(735, 45, 1.6, 2, 0.45)], { fx: fx(k, { glow: { color: "#ffffff", opacity: 0.9, blur: 14, spread: 0 } }) }),
      effect(k, "liquid-glass", { shape: "circle", size: 0.24, cx: 0.8, cy: 0.6, refraction: 1.2, bevel: 70, frost: 0.02, dispersion: 0.08, rim: 1, light: 135, tint: "#e0f7ff", tintAmount: 0.12, shadow: 0.25 }, { name: "Glass orb" }),
    ]),
    ...bubble(150, 520, 60),
    ...bubble(250, 640, 32),
    ...bubble(880, 160, 44),
    ...bubble(90, 720, 22),
    field(k, "Title", 40, 330, 920, 300, "Summer\nSplash", { size: 150, font: MONT, weight: 700, color: "#ffffff", lineHeight: 0.95, gradient: linear(90, "#ffffff", "#d6f1ff") }, {
      fx: fx(k, { shadow: { color: "#0d47a1", opacity: 0.45, angle: 90, distance: 8, blur: 18, spread: 0 }, glow: { color: "#ffffff", opacity: 0.6, blur: 24, spread: 0 } }),
    }),
    field(k, "Kicker", 40, 640, 920, 50, "a pool party at the lido", { size: 40, font: MONT, weight: 400, color: "#ffffff" }, { fx: fx(k, { shadow: { color: deep, opacity: 0.4, angle: 90, distance: 3, blur: 8, spread: 0 } }) }),
    shape(k, 120, 960, 760, 200, rounded(0.35), { fill: "#ffffff", stroke: "#ffffff", strokeWidth: 3, fillOpacity: 0.42, strokeOpacity: 0.95, fillGradient: linear(90, ["#ffffff", 0, 0.75], ["#e3f6ff", 1, 0.35]) }, { name: "Glass panel", fx: fx(k, { shadow: { color: "#0d47a1", opacity: 0.25, angle: 90, distance: 10, blur: 30, spread: 0 } }) }),
    field(k, "Date & time", 140, 980, 720, 60, "Saturday 12 July · 2—8 pm", { size: 44, font: MONT, weight: 700, color: deep }),
    field(k, "Place", 140, 1045, 720, 44, "Riverside Lido, Park Lane", { size: 30, font: MONT, weight: 400, color: deep }),
    field(k, "Note", 140, 1095, 720, 40, "Free entry · bring a towel and a friend", { size: 24, font: MONT, weight: 700, color: "#1565c0" }),
    shape(k, 300, 1190, 400, 70, rounded(1), { fill: "#1e88e5", stroke: "#0d47a1", strokeWidth: 2, fillGradient: linear(90, "#8fdcff", "#1e88e5", "#1565c0") }, { name: "Button", fx: fx(k, { glow: { color: "#4fc3f7", opacity: 0.7, blur: 16, spread: 0 } }) }),
    shape(k, 318, 1194, 364, 30, rounded(1), { fill: "#ffffff", stroke: null, fillOpacity: 0.5 }, { name: "Button shine" }),
    field(k, "Button", 300, 1190, 400, 70, "RSVP · SPLASH.FUN", { size: 26, font: MONT, weight: 700, color: "#ffffff", letterSpacing: 0.08 }, { fx: fx(k, { shadow: { color: deep, opacity: 0.5, angle: 90, distance: 2, blur: 4, spread: 0 } }) }),
    effect(k, "glow", { threshold: 0.82, radius: 36, intensity: 0.7, soften: 0.3, tint: "#ffffff" }, { name: "Bloom" }),
  ];
}

const poster = (t: Omit<Template, "category" | "width" | "height" | "background" | "preview"> & { background?: string | null }): Template => ({
  category: "Stylized",
  width: 2550,
  height: 3300,
  preview: true,
  ...t,
  background: t.background ?? null,
});

export const STYLIZED: readonly Template[] = [
  poster({ id: "sty-club-night", name: "Club night", look: "Crazy", tags: ["club", "dj", "party", "rave", "night", "poster", "event"], background: "#ff2bd6", build: clubNight }),
  poster({ id: "sty-birthday", name: "Birthday riot", look: "Crazy", tags: ["birthday", "party", "riso", "zine", "poster", "event"], background: "#f6f0e2", build: birthday }),
  poster({ id: "sty-punk-gig", name: "Gig night", look: "Crazy", tags: ["gig", "band", "concert", "punk", "music", "zine", "poster", "event"], background: "#ebe7de", build: punkGig }),
  poster({ id: "sty-festival", name: "Summer festival", look: "Crazy", tags: ["festival", "music", "summer", "psychedelic", "poster", "event"], background: "#ffd23f", build: festival }),
  poster({ id: "sty-horror-night", name: "Horror night", look: "Crazy", tags: ["halloween", "horror", "movie", "film", "poster", "event"], background: "#120000", build: horrorNight }),
  poster({ id: "sty-gallery", name: "Gallery opening", look: "Minimal", tags: ["art", "exhibition", "gallery", "opening", "poster", "event"], background: "#efebe3", build: galleryOpening }),
  poster({ id: "sty-wedding", name: "Wedding", look: "Minimal", tags: ["wedding", "invitation", "engagement", "save the date", "poster", "event"], background: "#f7f2ea", build: wedding }),
  poster({ id: "sty-lecture", name: "Lecture", look: "Minimal", tags: ["talk", "lecture", "conference", "school", "university", "poster", "event"], background: "#f4f4f0", build: lecture }),
  poster({ id: "sty-retreat", name: "Retreat", look: "Minimal", tags: ["yoga", "wellness", "retreat", "workshop", "poster", "event"], background: "#f4e9e1", build: retreat }),
  poster({ id: "sty-jazz", name: "Jazz night", look: "Minimal", tags: ["jazz", "music", "concert", "dinner", "poster", "event"], background: "#000000", build: jazzNight }),
  poster({ id: "sty-book-reading", name: "Book reading", look: "Minimal", tags: ["book", "reading", "author", "literature", "library", "poster", "event"], background: "#f3efe6", build: bookReading }),
  poster({ id: "sty-design-week", name: "Design week", look: "Minimal", tags: ["design", "bauhaus", "festival", "workshop", "architecture", "poster", "event"], background: "#f2ede3", build: designWeek }),
  poster({ id: "sty-tea", name: "Tea ceremony", look: "Minimal", tags: ["tea", "japanese", "ceremony", "workshop", "food", "poster", "event"], background: "#f4efe4", build: teaCeremony }),
  poster({ id: "sty-terrain", name: "Photo exhibition", look: "Minimal", tags: ["photography", "exhibition", "landscape", "gallery", "map", "poster", "event"], background: "#eef0ea", build: terrain }),
  poster({ id: "sty-recital", name: "Recital", look: "Minimal", tags: ["classical", "recital", "concert", "music", "cello", "poster", "event"], background: "#131a2e", build: recital }),
  poster({ id: "sty-open-studios", name: "Open studios", look: "Minimal", tags: ["art", "studios", "open day", "craft", "community", "poster", "event"], background: "#fbf1e1", build: openStudios }),
  poster({ id: "sty-hackathon", name: "Hackathon", look: "Futuristic", tags: ["tech", "hackathon", "meetup", "code", "conference", "poster", "event"], background: "#05060a", build: hackathon }),
  poster({ id: "sty-synth", name: "Electronic festival", look: "Futuristic", tags: ["festival", "electronic", "music", "rave", "techno", "poster", "event"], background: "#7a2bff", build: synthGlass }),
  poster({ id: "sty-launch", name: "Product launch", look: "Futuristic", tags: ["launch", "product", "business", "tech", "poster", "event"], background: "#000000", build: launch }),
  poster({ id: "sty-game-night", name: "Game night", look: "Futuristic", tags: ["gaming", "esports", "tournament", "game", "poster", "event"], background: "#0a0f2c", build: gameNight }),
  poster({ id: "sty-space", name: "Space night", look: "Futuristic", tags: ["space", "astronomy", "stars", "science", "poster", "event"], background: "#03040c", build: spaceNight }),
  poster({ id: "sty-aero", name: "Frutiger Aero party", look: "Futuristic", tags: ["frutiger aero", "aero", "y2k", "aqua", "glossy", "pool", "summer", "party", "poster", "event"], background: "#42a5f5", build: frutigerAero }),
];
