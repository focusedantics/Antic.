import { buildCollage } from "@/core/document/collage";
import type { CompositeDocument, Gradient, Layer } from "@/core/document/model";
import { canvasTransform, gradientLayer } from "@/core/document/operations";
import { ELEMENTS } from "./elements";
import { frame, fx, kit, type Kit, path, shape, text } from "./kit";

/**
 * Starting points: original templates written as code (no stock images; photos go in
 * frames the user fills). Each is drawn at its own size; `build` lays it out on a
 * document of that size.
 */
export type TemplateCategory = "Posts" | "Stories" | "Wallpapers" | "Flyers & posters" | "Invitations & cards" | "Business" | "Thumbnails & banners" | "Collages";
export type Template = {
  readonly id: string;
  readonly name: string;
  readonly category: TemplateCategory;
  readonly tags: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly background: string | null;
  readonly build: (doc: Pick<CompositeDocument, "width" | "height">) => Layer[];
};

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ["Posts", "Stories", "Wallpapers", "Flyers & posters", "Invitations & cards", "Business", "Thumbnails & banners", "Collages"];

const ANTON = "Anton, Impact, sans-serif";
const BEBAS = "'Bebas Neue', Impact, sans-serif";
const MONT = "Montserrat, sans-serif";
const INTER = "Inter, system-ui, sans-serif";
const PLAYFAIR = "'Playfair Display', Georgia, serif";
const DMSERIF = "'DM Serif Display', Georgia, serif";
const CAVEAT = "Caveat, cursive";
const PACIFICO = "Pacifico, cursive";
const MONOTON = "Monoton, sans-serif";

const grad = (angle: number, ...colors: string[]): Gradient => ({
  type: "linear",
  angle,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  reverse: false,
  stops: colors.map((c, i) => ({ offset: i / Math.max(1, colors.length - 1), color: c, opacity: 1 })),
});
const radial = (...colors: string[]): Gradient => ({ ...grad(0, ...colors), type: "radial", scale: 1.4 });

/** A gradient over the whole canvas. */
const backdrop = (k: Kit, g: Gradient, name = "Background") => ({ ...gradientLayer(k.doc as CompositeDocument, g), name, transform: canvasTransform(k.doc) });
/** An element from the Elements panel, placed at a spot (units) at a size (share of the canvas). */
const element = (k: Kit, id: string, ink: string, share: number, cx: number, cy: number, rotation = 0): Layer => {
  const el = ELEMENTS.find((e) => e.id === id)!.make(k.doc, ink, share);
  const dx = k.ox + cx * k.s - k.doc.width / 2;
  const dy = k.oy + cy * k.s - k.doc.height / 2;
  const move = (l: Layer): Layer => (l.kind === "group" ? { ...l, children: l.children.map(move) } : { ...l, transform: { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy, rotation: l.transform.rotation + rotation } });
  return move(el);
};
const pill = (k: Kit, x: number, y: number, w: number, h: number, fill: string, label: string, color: string, size: number, font = MONT): Layer[] => [
  shape(k, x, y, w, h, { kind: "rectangle", points: 4, ratio: 0.5, round: 1 }, { fill }),
  text(k, x, y, w, h, label, { size, font, weight: 800, color, letterSpacing: 0.06 }),
];

const P = (doc: Pick<CompositeDocument, "width" | "height">, w: number, h: number) => kit(doc, w, h, 1);

export const TEMPLATES: readonly Template[] = [
  // ─── Posts (1080 × 1080 / 1350) ───
  {
    id: "post-big-news",
    name: "Big news",
    category: "Posts",
    tags: ["announcement", "instagram", "bold"],
    width: 1080,
    height: 1080,
    background: "#111111",
    build: (doc) => {
      const k = P(doc, 1080, 1080);
      return [
        text(k, 90, 300, 900, 260, "BIG", { size: 260, font: ANTON, color: "#ffd34d" }),
        text(k, 90, 520, 900, 260, "NEWS", { size: 260, font: ANTON, color: "#ffffff" }),
        text(k, 140, 800, 800, 80, "something exciting is coming", { size: 44, font: MONT, weight: 600, color: "#bbbbbb", letterSpacing: 0.18, textCase: "upper" }),
        element(k, "sparkles", "#ffffff", 0.22, 860, 220),
      ];
    },
  },
  {
    id: "post-photo-caption",
    name: "Photo and caption",
    category: "Posts",
    tags: ["photo", "caption", "instagram", "minimal"],
    width: 1080,
    height: 1350,
    background: "#f6f2ea",
    build: (doc) => {
      const k = P(doc, 1080, 1350);
      return [
        frame(k, 60, 60, 960, 1000, { kind: "rectangle", points: 4, ratio: 0.5, round: 0.06 }),
        text(k, 60, 1090, 960, 110, "Golden hour", { size: 96, font: DMSERIF, color: "#222222" }),
        text(k, 60, 1200, 960, 70, "a little story about this photo", { size: 40, font: INTER, weight: 500, color: "#6b6357" }),
      ];
    },
  },
  {
    id: "post-quote",
    name: "Quote card",
    category: "Posts",
    tags: ["quote", "text", "inspiration"],
    width: 1080,
    height: 1080,
    background: "#f4ead5",
    build: (doc) => {
      const k = P(doc, 1080, 1080);
      return [
        text(k, 80, 120, 300, 300, "“", { size: 420, font: PLAYFAIR, weight: 700, color: "#d9a441", lineHeight: 1 }),
        text(k, 120, 380, 840, 330, "Creativity is\nintelligence having fun.", { size: 82, font: PLAYFAIR, weight: 700, italic: true, color: "#2b2b2b", lineHeight: 1.25 }),
        shape(k, 470, 760, 140, 16, "line", { stroke: "#d9a441", strokeWidth: 6, fill: null }),
        text(k, 120, 800, 840, 70, "SOMEONE CLEVER", { size: 38, font: MONT, weight: 700, color: "#5a5045", letterSpacing: 0.3 }),
      ];
    },
  },
  {
    id: "post-sale",
    name: "Sale",
    category: "Posts",
    tags: ["sale", "shop", "discount", "offer"],
    width: 1080,
    height: 1080,
    background: "#ffd34d",
    build: (doc) => {
      const k = P(doc, 1080, 1080);
      return [
        text(k, 60, 120, 960, 160, "SUMMER", { size: 150, font: BEBAS, color: "#111111", letterSpacing: 0.2 }),
        element(k, "sale-burst", "#111111", 0.52, 540, 540, -8),
        ...pill(k, 340, 870, 400, 110, "#111111", "SHOP NOW", "#ffd34d", 48),
      ];
    },
  },
  {
    id: "post-product",
    name: "Product spotlight",
    category: "Posts",
    tags: ["product", "shop", "price"],
    width: 1080,
    height: 1350,
    background: "#e9f0ff",
    build: (doc) => {
      const k = P(doc, 1080, 1350);
      return [
        shape(k, 140, 140, 800, 800, "ellipse", { fill: "#cddcff" }),
        frame(k, 190, 190, 700, 700, "ellipse", { fx: fx(k, { outline: { color: "#ffffff", opacity: 1, width: 18 }, shadow: { color: "#1b2a55", opacity: 0.3, angle: 90, distance: 18, blur: 40, spread: 0 } }) }),
        text(k, 80, 990, 920, 120, "The new classic", { size: 96, font: DMSERIF, color: "#1b2a55" }),
        text(k, 80, 1110, 920, 70, "handmade · limited run", { size: 40, font: INTER, weight: 600, color: "#4d5d8c", letterSpacing: 0.12 }),
        element(k, "price-tag", "#111111", 0.24, 870, 1230, -6),
      ];
    },
  },
  {
    id: "post-before-after",
    name: "Before and after",
    category: "Posts",
    tags: ["before", "after", "comparison", "transformation"],
    width: 1080,
    height: 1080,
    background: "#ffffff",
    build: (doc) => {
      const k = P(doc, 1080, 1080);
      return [
        frame(k, 0, 0, 536, 1080),
        frame(k, 544, 0, 536, 1080),
        ...pill(k, 40, 960, 240, 80, "#111111", "BEFORE", "#ffffff", 34),
        ...pill(k, 800, 960, 240, 80, "#ffffff", "AFTER", "#111111", 34),
      ];
    },
  },
  {
    id: "post-tips",
    name: "Three tips",
    category: "Posts",
    tags: ["tips", "list", "how to", "education"],
    width: 1080,
    height: 1350,
    background: "#0f3d3e",
    build: (doc) => {
      const k = P(doc, 1080, 1350);
      const row = (i: number, title: string, body: string): Layer[] => [
        shape(k, 90, 430 + i * 270, 130, 130, "ellipse", { fill: "#ffcf5c" }),
        text(k, 90, 430 + i * 270, 130, 130, String(i + 1), { size: 80, font: ANTON, color: "#0f3d3e" }),
        text(k, 260, 425 + i * 270, 740, 80, title, { size: 56, font: MONT, weight: 800, color: "#ffffff", align: "left" }),
        text(k, 260, 500 + i * 270, 740, 60, body, { size: 36, font: INTER, weight: 500, color: "#b8d4d1", align: "left" }),
      ];
      return [
        text(k, 90, 120, 900, 120, "3 TIPS FOR", { size: 90, font: BEBAS, color: "#ffcf5c", letterSpacing: 0.08, align: "left" }),
        text(k, 90, 220, 900, 140, "better photos", { size: 120, font: DMSERIF, color: "#ffffff", align: "left" }),
        ...row(0, "Find the light", "Shoot with the sun low and behind you."),
        ...row(1, "Get closer", "Fill the frame with what matters."),
        ...row(2, "Keep it level", "Line up the horizon before you shoot."),
      ];
    },
  },
  // ─── Stories (1080 × 1920) ───
  {
    id: "story-weekend",
    name: "Weekend story",
    category: "Stories",
    tags: ["story", "photo", "script", "reel"],
    width: 1080,
    height: 1920,
    background: "#fdf3e7",
    build: (doc) => {
      const k = P(doc, 1080, 1920);
      return [
        text(k, 60, 140, 960, 220, "weekend", { size: 200, font: PACIFICO, color: "#e0457b" }),
        text(k, 60, 360, 960, 100, "MOOD", { size: 90, font: BEBAS, color: "#2b2b2b", letterSpacing: 0.6 }),
        frame(k, 110, 520, 860, 1150, { kind: "rectangle", points: 4, ratio: 0.5, round: 0.12 }, { fx: fx(k, { shadow: { color: "#000000", opacity: 0.25, angle: 90, distance: 20, blur: 50, spread: 0 } }) }),
        element(k, "doodle-circle", "#e0457b", 0.3, 860, 1720, 0),
      ];
    },
  },
  {
    id: "story-poll",
    name: "This or that",
    category: "Stories",
    tags: ["poll", "question", "story", "interactive"],
    width: 1080,
    height: 1920,
    background: null,
    build: (doc) => {
      const k = P(doc, 1080, 1920);
      return [
        backdrop(k, grad(120, "#6a5cff", "#ff6fb5")),
        text(k, 80, 260, 920, 300, "Coffee\nor tea?", { size: 180, font: ANTON, color: "#ffffff", lineHeight: 1.05 }),
        frame(k, 100, 680, 420, 560, { kind: "rectangle", points: 4, ratio: 0.5, round: 0.2 }),
        frame(k, 560, 680, 420, 560, { kind: "rectangle", points: 4, ratio: 0.5, round: 0.2 }),
        ...pill(k, 140, 1300, 340, 120, "#ffffff", "COFFEE", "#6a5cff", 48),
        ...pill(k, 600, 1300, 340, 120, "#ffffff", "TEA", "#ff6fb5", 48),
        text(k, 80, 1600, 920, 80, "tap to vote", { size: 50, font: CAVEAT, weight: 700, color: "#ffffff" }),
      ];
    },
  },
  {
    id: "story-new-post",
    name: "New post",
    category: "Stories",
    tags: ["new post", "story", "share", "instant"],
    width: 1080,
    height: 1920,
    background: "#ffe14d",
    build: (doc) => {
      const k = P(doc, 1080, 1920);
      const photo = element(k, "polaroid", "#111111", 0.62, 540, 940, -5);
      return [
        text(k, 60, 150, 960, 260, "NEW POST", { size: 230, font: ANTON, color: "#111111" }),
        photo,
        element(k, "arrow-doodle", "#111111", 0.28, 820, 1640, 150),
        text(k, 60, 1720, 600, 100, "go check it out", { size: 70, font: CAVEAT, weight: 700, color: "#111111" }),
      ];
    },
  },
  {
    id: "story-countdown",
    name: "Countdown",
    category: "Stories",
    tags: ["countdown", "launch", "days", "event"],
    width: 1080,
    height: 1920,
    background: "#0b0b14",
    build: (doc) => {
      const k = P(doc, 1080, 1920);
      return [
        backdrop(k, radial("#2a1f5c", "#0b0b14")),
        text(k, 60, 420, 960, 120, "ONLY", { size: 110, font: BEBAS, color: "#a99cff", letterSpacing: 0.5 }),
        text(k, 60, 560, 960, 640, "3", { size: 700, font: ANTON, color: "#ffffff" }, { fx: fx(k, { glow: { color: "#7b61ff", opacity: 1, blur: 80, spread: 0.1 } }) }),
        text(k, 60, 1230, 960, 140, "DAYS TO GO", { size: 130, font: BEBAS, color: "#ffffff", letterSpacing: 0.2 }),
        element(k, "sparkles", "#ffffff", 0.2, 860, 380),
      ];
    },
  },
  // ─── Wallpapers (1290 × 2796) ───
  {
    id: "wall-moon",
    name: "Night moon",
    category: "Wallpapers",
    tags: ["wallpaper", "lock screen", "moon", "night", "minimal"],
    width: 1290,
    height: 2796,
    background: "#0c1024",
    build: (doc) => {
      const k = P(doc, 1290, 2796);
      return [
        backdrop(k, grad(90, "#0c1024", "#25305e", "#4b3b6e")),
        shape(k, 395, 1500, 500, 500, { kind: "crescent", points: 4, ratio: 0.42, round: 0 }, { fill: "#f6e7b4" }, { fx: fx(k, { glow: { color: "#f6e7b4", opacity: 0.6, blur: 90, spread: 0 } }) }),
        element(k, "sparkles", "#ffffff", 0.18, 300, 1200),
        element(k, "sparkles", "#ffffff", 0.12, 1000, 2250),
        path(k, [{ closed: true, nodes: [{ x: 0, y: 2380 }, { x: 420, y: 2150 }, { x: 760, y: 2330 }, { x: 1050, y: 2180 }, { x: 1290, y: 2300 }, { x: 1290, y: 2796 }, { x: 0, y: 2796 }] }], { fill: "#151a33" }, "Hills"),
      ];
    },
  },
  {
    id: "wall-retro-sun",
    name: "Retro sunset",
    category: "Wallpapers",
    tags: ["wallpaper", "retro", "sunset", "80s", "synthwave"],
    width: 1290,
    height: 2796,
    background: "#1a0b2e",
    build: (doc) => {
      const k = P(doc, 1290, 2796);
      // Clipped to the sun below them, so they cut across it only.
      const stripes = Array.from({ length: 6 }, (_, i) => shape(k, 245, 1720 + i * 62, 800, 14 + i * 5, "rectangle", { fill: "#2a0f3d" }, { clip: true, name: "Sun stripe" }));
      return [
        backdrop(k, grad(90, "#1a0b2e", "#5b1e6b", "#ff6a5b")),
        shape(k, 245, 1250, 800, 800, "ellipse", { fill: "#ffcf5c", fillGradient: grad(90, "#ffe66b", "#ff5f8f") }),
        ...stripes,
        path(k, [{ closed: true, nodes: [{ x: 0, y: 2150 }, { x: 330, y: 1840 }, { x: 560, y: 2060 }, { x: 760, y: 1900 }, { x: 1290, y: 2200 }, { x: 1290, y: 2796 }, { x: 0, y: 2796 }] }], { fill: "#2a0f3d" }, "Mountains"),
      ];
    },
  },
  {
    id: "wall-gradient-rings",
    name: "Soft rings",
    category: "Wallpapers",
    tags: ["wallpaper", "gradient", "abstract", "pastel"],
    width: 1290,
    height: 2796,
    background: "#ffd1dc",
    build: (doc) => {
      const k = P(doc, 1290, 2796);
      return [
        backdrop(k, grad(60, "#ffd1dc", "#c7d2ff", "#b8f0e0")),
        ...[900, 700, 500, 300].map((d, i) => shape(k, 645 - d / 2, 1100 - d / 2, d, d, { kind: "ring", points: 4, ratio: 0.9, round: 0 }, { fill: "#ffffff", fillOpacity: 0.35 + i * 0.1 })),
        ...[1300, 1000].map((d) => shape(k, 645 - d / 2, 2100 - d / 2, d, d, { kind: "ring", points: 4, ratio: 0.94, round: 0 }, { fill: "#ffffff", fillOpacity: 0.3 })),
      ];
    },
  },
  {
    id: "wall-photo",
    name: "Photo wallpaper",
    category: "Wallpapers",
    tags: ["wallpaper", "photo", "lock screen"],
    width: 1290,
    height: 2796,
    background: "#000000",
    build: (doc) => {
      const k = P(doc, 1290, 2796);
      return [frame(k, 0, 0, 1290, 2796), { ...backdrop(k, { ...grad(90, "#000000", "#000000"), stops: [{ offset: 0.55, color: "#000000", opacity: 0 }, { offset: 1, color: "#000000", opacity: 0.55 }] }), name: "Shade" }];
    },
  },
  // ─── Flyers & posters (2550 × 3300) ───
  {
    id: "flyer-event",
    name: "Event flyer",
    category: "Flyers & posters",
    tags: ["event", "flyer", "party", "poster"],
    width: 2550,
    height: 3300,
    background: "#111111",
    build: (doc) => {
      const k = P(doc, 2550, 3300);
      return [
        frame(k, 0, 0, 2550, 1800),
        backdrop(k, { ...grad(90, "#111111", "#111111"), stops: [{ offset: 0.3, color: "#111111", opacity: 0 }, { offset: 0.52, color: "#111111", opacity: 1 }] }),
        text(k, 150, 1650, 2250, 520, "SUMMER\nNIGHTS", { size: 480, font: ANTON, color: "#ffffff", lineHeight: 0.95 }),
        shape(k, 1075, 2330, 400, 30, "line", { stroke: "#ff5f6d", strokeWidth: 16, fill: null }),
        text(k, 150, 2420, 2250, 200, "FRIDAY · 21 JUNE · 9 PM", { size: 140, font: BEBAS, color: "#ff5f6d", letterSpacing: 0.12 }),
        text(k, 150, 2650, 2250, 140, "The Rooftop, 12 Harbour Street", { size: 100, font: MONT, weight: 600, color: "#dddddd" }),
        text(k, 150, 2950, 2250, 120, "free entry before 10", { size: 120, font: CAVEAT, weight: 700, color: "#ffd34d" }),
      ];
    },
  },
  {
    id: "poster-concert",
    name: "Neon concert",
    category: "Flyers & posters",
    tags: ["concert", "music", "neon", "poster", "gig"],
    width: 2550,
    height: 3300,
    background: "#07070f",
    build: (doc) => {
      const k = P(doc, 2550, 3300);
      return [
        backdrop(k, radial("#1b1240", "#07070f")),
        text(k, 100, 500, 2350, 700, "LIVE", { size: 760, font: MONOTON, color: "#ff7ae6" }, { fx: fx(k, { glow: { color: "#ff2ad4", opacity: 1, blur: 120, spread: 0.15 } }) }),
        text(k, 100, 1300, 2350, 360, "THE MIDNIGHT ECHO", { size: 230, font: BEBAS, color: "#7df9ff", letterSpacing: 0.08 }, { fx: fx(k, { glow: { color: "#00d0ff", opacity: 0.9, blur: 60, spread: 0.1 } }) }),
        text(k, 100, 1800, 2350, 500, "with special guests\nSOFT STATIC · NORTHBOUND", { size: 120, font: MONT, weight: 600, color: "#d8d8f0", lineHeight: 1.6 }),
        shape(k, 300, 2500, 1950, 4, "line", { stroke: "#ff7ae6", strokeWidth: 8, fill: null }),
        text(k, 100, 2600, 2350, 200, "SAT 14 SEPT · DOORS 8 PM", { size: 150, font: BEBAS, color: "#ffffff", letterSpacing: 0.1 }),
        text(k, 100, 2850, 2350, 160, "tickets at the door", { size: 100, font: INTER, weight: 500, color: "#9a9ab8" }),
      ];
    },
  },
  {
    id: "flyer-yard-sale",
    name: "Yard sale",
    category: "Flyers & posters",
    tags: ["yard sale", "garage sale", "flyer", "community"],
    width: 2550,
    height: 3300,
    background: "#ffe14d",
    build: (doc) => {
      const k = P(doc, 2550, 3300);
      return [
        text(k, 100, 260, 2350, 1000, "YARD\nSALE", { size: 820, font: ANTON, color: "#111111", lineHeight: 0.92 }),
        element(k, "sale-burst", "#111111", 0.28, 2050, 1500, 12),
        text(k, 150, 1550, 1700, 600, "Books · toys · furniture\nclothes · plants · records", { size: 140, font: MONT, weight: 700, color: "#111111", lineHeight: 1.4, align: "left" }),
        shape(k, 150, 2350, 2250, 600, { kind: "rectangle", points: 4, ratio: 0.5, round: 0.2 }, { fill: "#111111" }),
        text(k, 150, 2400, 2250, 280, "SATURDAY 8 AM – 2 PM", { size: 190, font: BEBAS, color: "#ffe14d", letterSpacing: 0.06 }),
        text(k, 150, 2660, 2250, 220, "42 Maple Avenue", { size: 140, font: MONT, weight: 700, color: "#ffffff" }),
      ];
    },
  },
  {
    id: "flyer-workshop",
    name: "Workshop",
    category: "Flyers & posters",
    tags: ["workshop", "class", "course", "flyer", "learn"],
    width: 2480,
    height: 3508,
    background: "#f7f4ee",
    build: (doc) => {
      const k = P(doc, 2480, 3508);
      return [
        shape(k, 0, 0, 2480, 1500, "rectangle", { fill: "#2f6f5e" }),
        text(k, 160, 300, 2160, 200, "SATURDAY WORKSHOP", { size: 120, font: MONT, weight: 800, color: "#bfe3d8", letterSpacing: 0.25 }),
        text(k, 160, 520, 2160, 700, "Learn to\nshoot film", { size: 330, font: DMSERIF, color: "#ffffff", lineHeight: 1.05 }),
        frame(k, 640, 1150, 1200, 1200, "ellipse", { fx: fx(k, { outline: { color: "#f7f4ee", opacity: 1, width: 40 } }) }),
        text(k, 160, 2500, 2160, 200, "10 AM – 4 PM · all levels", { size: 130, font: MONT, weight: 700, color: "#2f6f5e" }),
        text(k, 160, 2750, 2160, 300, "Bring a camera and your curiosity.\nCoffee and film included.", { size: 100, font: INTER, weight: 500, color: "#555555", lineHeight: 1.5 }),
        ...pill(k, 790, 3150, 900, 200, "#2f6f5e", "BOOK A SEAT", "#ffffff", 80),
      ];
    },
  },
  // ─── Invitations & cards (1500 × 2100) ───
  {
    id: "invite-birthday",
    name: "Birthday party",
    category: "Invitations & cards",
    tags: ["birthday", "party", "invitation", "kids"],
    width: 1500,
    height: 2100,
    background: "#fff6e9",
    build: (doc) => {
      const k = P(doc, 1500, 2100);
      return [
        element(k, "confetti", "#111111", 0.95, 750, 1050),
        text(k, 100, 380, 1300, 330, "You're invited", { size: 150, font: CAVEAT, weight: 700, color: "#e0457b" }),
        text(k, 100, 680, 1300, 420, "Mia turns 7!", { size: 230, font: ANTON, color: "#2b2b2b" }),
        shape(k, 550, 1140, 400, 30, "line", { stroke: "#ffcf5c", strokeWidth: 18, fill: null }),
        text(k, 100, 1250, 1300, 160, "SATURDAY 3 MAY · 2 PM", { size: 100, font: BEBAS, color: "#2b2b2b", letterSpacing: 0.1 }),
        text(k, 100, 1420, 1300, 260, "Sunny Park, by the big oak\ncake, games and balloons", { size: 70, font: MONT, weight: 600, color: "#6b6357", lineHeight: 1.5 }),
      ];
    },
  },
  {
    id: "invite-wedding",
    name: "Wedding invitation",
    category: "Invitations & cards",
    tags: ["wedding", "invitation", "elegant", "save the date"],
    width: 1500,
    height: 2100,
    background: "#fbf8f2",
    build: (doc) => {
      const k = P(doc, 1500, 2100);
      return [
        shape(k, 80, 80, 1340, 1940, "rectangle", { fill: null, stroke: "#c2a878", strokeWidth: 6 }),
        shape(k, 110, 110, 1280, 1880, "rectangle", { fill: null, stroke: "#c2a878", strokeWidth: 2 }),
        text(k, 150, 300, 1200, 120, "TOGETHER WITH THEIR FAMILIES", { size: 46, font: MONT, weight: 600, color: "#8a7a5c", letterSpacing: 0.25 }),
        text(k, 150, 520, 1200, 600, "Anna\n&\nBenjamin", { size: 170, font: PLAYFAIR, italic: true, weight: 400, color: "#3a3326", lineHeight: 1.15 }),
        element(k, "divider", "#c2a878", 0.45, 750, 1260),
        text(k, 150, 1350, 1200, 160, "request the pleasure of your company", { size: 56, font: PLAYFAIR, italic: true, weight: 400, color: "#5d5442" }),
        text(k, 150, 1550, 1200, 160, "SATURDAY, 12 SEPTEMBER", { size: 70, font: MONT, weight: 700, color: "#3a3326", letterSpacing: 0.15 }),
        text(k, 150, 1700, 1200, 120, "Willow Hall, four o'clock", { size: 60, font: PLAYFAIR, weight: 400, color: "#5d5442" }),
      ];
    },
  },
  {
    id: "card-thank-you",
    name: "Thank you card",
    category: "Invitations & cards",
    tags: ["thank you", "card", "gratitude"],
    width: 1800,
    height: 1200,
    background: "#e8f1ea",
    build: (doc) => {
      const k = P(doc, 1800, 1200);
      return [
        text(k, 100, 330, 1600, 400, "Thank you", { size: 300, font: PACIFICO, color: "#2f6f5e" }),
        text(k, 100, 760, 1600, 120, "FOR BEING WONDERFUL", { size: 70, font: MONT, weight: 700, color: "#3e5d52", letterSpacing: 0.3 }),
        shape(k, 820, 920, 160, 150, "heart", { fill: "#e0457b" }),
      ];
    },
  },
  // ─── Business ───
  {
    id: "biz-card",
    name: "Business card",
    category: "Business",
    tags: ["business card", "contact", "minimal"],
    width: 1050,
    height: 600,
    background: "#ffffff",
    build: (doc) => {
      const k = P(doc, 1050, 600);
      return [
        shape(k, 0, 0, 24, 600, "rectangle", { fill: "#d9a441" }),
        text(k, 90, 150, 800, 90, "Alex Morgan", { size: 70, font: MONT, weight: 800, color: "#1b1b1b", align: "left" }),
        text(k, 90, 235, 800, 60, "Photographer & designer", { size: 34, font: INTER, weight: 500, color: "#777777", align: "left" }),
        shape(k, 90, 330, 120, 8, "line", { stroke: "#d9a441", strokeWidth: 4, fill: null }),
        text(k, 90, 370, 800, 160, "+1 555 123 4567\nhello@alexmorgan.studio\nalexmorgan.studio", { size: 30, font: INTER, weight: 500, color: "#333333", align: "left", lineHeight: 1.6 }),
      ];
    },
  },
  {
    id: "biz-logo",
    name: "Round logo",
    category: "Business",
    tags: ["logo", "brand", "badge", "monogram"],
    width: 2000,
    height: 2000,
    background: null,
    build: (doc) => {
      const k = P(doc, 2000, 2000);
      return [
        shape(k, 200, 200, 1600, 1600, "ellipse", { fill: "#1f3a5f" }),
        shape(k, 280, 280, 1440, 1440, { kind: "ring", points: 4, ratio: 0.97, round: 0 }, { fill: "#f2c14e" }),
        text(k, 300, 640, 1400, 600, "AM", { size: 560, font: DMSERIF, color: "#f2c14e" }),
        text(k, 300, 1250, 1400, 160, "STUDIO · EST 2024", { size: 90, font: MONT, weight: 700, color: "#ffffff", letterSpacing: 0.3 }),
      ];
    },
  },
  {
    id: "biz-certificate",
    name: "Certificate",
    category: "Business",
    tags: ["certificate", "award", "achievement", "diploma"],
    width: 3300,
    height: 2550,
    background: "#fffdf7",
    build: (doc) => {
      const k = P(doc, 3300, 2550);
      return [
        shape(k, 100, 100, 3100, 2350, "rectangle", { fill: null, stroke: "#1f3a5f", strokeWidth: 30 }),
        shape(k, 170, 170, 2960, 2210, "rectangle", { fill: null, stroke: "#c9a227", strokeWidth: 8 }),
        text(k, 200, 380, 2900, 220, "CERTIFICATE", { size: 200, font: DMSERIF, color: "#1f3a5f", letterSpacing: 0.15 }),
        text(k, 200, 600, 2900, 120, "OF ACHIEVEMENT", { size: 90, font: MONT, weight: 700, color: "#c9a227", letterSpacing: 0.4 }),
        text(k, 200, 900, 2900, 120, "This certificate is presented to", { size: 80, font: PLAYFAIR, italic: true, weight: 400, color: "#555555" }),
        text(k, 200, 1080, 2900, 300, "Jordan Lee", { size: 260, font: PACIFICO, color: "#1f3a5f" }),
        text(k, 200, 1420, 2900, 160, "for outstanding work in photography, 2024", { size: 80, font: INTER, weight: 500, color: "#555555" }),
        shape(k, 500, 1960, 800, 10, "line", { stroke: "#333333", strokeWidth: 4, fill: null }),
        shape(k, 2000, 1960, 800, 10, "line", { stroke: "#333333", strokeWidth: 4, fill: null }),
        text(k, 500, 2000, 800, 100, "DATE", { size: 60, font: MONT, weight: 700, color: "#777777", letterSpacing: 0.3 }),
        text(k, 2000, 2000, 800, 100, "SIGNATURE", { size: 60, font: MONT, weight: 700, color: "#777777", letterSpacing: 0.3 }),
        element(k, "new-badge", "#111111", 0.12, 1650, 1960),
      ];
    },
  },
  {
    id: "biz-menu",
    name: "Café menu",
    category: "Business",
    tags: ["menu", "restaurant", "cafe", "food", "prices"],
    width: 2550,
    height: 3300,
    background: "#1d1a17",
    build: (doc) => {
      const k = P(doc, 2550, 3300);
      const item = (y: number, name: string, price: string): Layer[] => [
        text(k, 300, y, 1500, 140, name, { size: 100, font: MONT, weight: 600, color: "#f3ead8", align: "left" }),
        text(k, 1850, y, 400, 140, price, { size: 100, font: MONT, weight: 700, color: "#d9a441", align: "right" }),
      ];
      return [
        text(k, 200, 220, 2150, 400, "Corner Café", { size: 300, font: DMSERIF, color: "#f3ead8" }),
        element(k, "divider", "#d9a441", 0.4, 1275, 700),
        text(k, 300, 880, 1950, 160, "COFFEE", { size: 110, font: BEBAS, color: "#d9a441", letterSpacing: 0.3, align: "left" }),
        ...item(1060, "Espresso", "2.50"),
        ...item(1220, "Flat white", "3.40"),
        ...item(1380, "Cappuccino", "3.20"),
        text(k, 300, 1680, 1950, 160, "BAKERY", { size: 110, font: BEBAS, color: "#d9a441", letterSpacing: 0.3, align: "left" }),
        ...item(1860, "Butter croissant", "2.80"),
        ...item(2020, "Cinnamon bun", "3.10"),
        ...item(2180, "Banana bread", "3.00"),
        text(k, 200, 2850, 2150, 160, "open daily 7 – 4", { size: 130, font: CAVEAT, weight: 700, color: "#a69a86" }),
      ];
    },
  },
  // ─── Thumbnails & banners ───
  {
    id: "yt-thumb",
    name: "Video thumbnail",
    category: "Thumbnails & banners",
    tags: ["youtube", "thumbnail", "video", "bold"],
    width: 1280,
    height: 720,
    background: "#ffd34d",
    build: (doc) => {
      const k = P(doc, 1280, 720);
      return [
        frame(k, 640, 0, 640, 720, { kind: "rectangle", points: 4, ratio: 0.5, round: 0 }),
        text(k, 50, 120, 620, 480, "I TRIED\nIT FOR\n30 DAYS", { size: 150, font: ANTON, color: "#ffffff", lineHeight: 1, align: "left" }, { fx: fx(k, { outline: { color: "#111111", opacity: 1, width: 12 }, shadow: { color: "#000000", opacity: 0.5, angle: 90, distance: 10, blur: 0, spread: 0 } }) }),
        element(k, "arrow-doodle", "#e8343a", 0.28, 640, 560, 20),
      ];
    },
  },
  {
    id: "web-banner",
    name: "Web banner",
    category: "Thumbnails & banners",
    tags: ["banner", "web", "header", "link preview"],
    width: 1200,
    height: 628,
    background: null,
    build: (doc) => {
      const k = P(doc, 1200, 628);
      return [
        backdrop(k, grad(0, "#1f3a5f", "#3d8bfd")),
        text(k, 80, 160, 700, 200, "Launch week", { size: 120, font: DMSERIF, color: "#ffffff", align: "left" }),
        text(k, 80, 360, 700, 80, "new features every day", { size: 42, font: INTER, weight: 600, color: "#cfe0ff", align: "left" }),
        frame(k, 820, 114, 400, 400, "ellipse", { fx: fx(k, { outline: { color: "#ffffff", opacity: 1, width: 12 } }) }),
      ];
    },
  },
  // ─── Collages ───
  ...(
    [
      ["4-grid", 1080, 1080, "Four squares", 0.015, 0],
      ["3-left", 1080, 1350, "Big and two", 0.02, 0.08],
      ["5-mosaic", 1080, 1350, "Mosaic", 0.015, 0.05],
      ["9-grid", 1080, 1080, "Nine grid", 0.008, 0],
      ["2-rows", 1080, 1920, "Story pair", 0.025, 0.12],
      ["4-top", 1080, 1920, "Story four", 0.02, 0.06],
    ] as const
  ).map(
    ([layout, w, h, name, spacing, radius]): Template => ({
      id: `collage-${layout}-${w}x${h}`,
      name,
      category: "Collages",
      tags: ["collage", "grid", "photos", "layout"],
      width: w,
      height: h,
      background: "#ffffff",
      build: (doc) => [buildCollage(doc, layout, { spacing, radius })],
    }),
  ),
  {
    id: "collage-scrapbook",
    name: "Scrapbook",
    category: "Collages",
    tags: ["collage", "scrapbook", "instant", "memories"],
    width: 1080,
    height: 1350,
    background: "#efe6d8",
    build: (doc) => {
      const k = P(doc, 1080, 1350);
      return [
        element(k, "polaroid", "#111111", 0.5, 330, 420, -8),
        element(k, "polaroid", "#111111", 0.5, 760, 760, 6),
        element(k, "tape", "#111111", 0.2, 360, 140, 0),
        text(k, 60, 1150, 960, 140, "best summer ever", { size: 110, font: CAVEAT, weight: 700, color: "#5a3e2b" }),
      ];
    },
  },
];

/** A template's matching text (name, category, tags) contains the query. */
export const matchesTemplate = (t: Template, q: string) => !q || [t.name, t.category, ...t.tags].some((s) => s.toLowerCase().includes(q));

