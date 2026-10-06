import type { CompositeDocument, Layer } from "@/core/document/model";
import type { Point } from "@/lib/math";
import { frame, fx, group, kit, path, shape, text, trace } from "./kit";

/**
 * Ready-made elements: badges, ribbons, doodles, decorations and photo frames, plus text
 * combinations. All original, drawn as editable vector layers (no images, nothing to
 * license); each lands as a group centred on the canvas.
 */
export type ElementGroup = "Badges" | "Lines & doodles" | "Decor" | "Photo frames" | "Text";
export type Element = { readonly id: string; readonly label: string; readonly group: ElementGroup; readonly make: (doc: Pick<CompositeDocument, "width" | "height">, ink: string, share?: number) => Layer };

const ANTON = "Anton, Impact, sans-serif";
const BEBAS = "'Bebas Neue', Impact, sans-serif";
const MONT = "Montserrat, sans-serif";
const PLAYFAIR = "'Playfair Display', Georgia, serif";
const CAVEAT = "Caveat, cursive";

export const ELEMENTS: readonly Element[] = [
  {
    id: "sale-burst",
    label: "Sale burst",
    group: "Badges",
    make: (doc, _ink, share = 0.45) => {
      const k = kit(doc, 1000, 1000, share);
      return group(k, "Sale burst", [
        shape(k, 0, 0, 1000, 1000, { kind: "burst", points: 22, ratio: 0.82, round: 0 }, { fill: "#e8343a" }),
        text(k, 100, 300, 800, 260, "SALE", { size: 250, font: ANTON, color: "#ffffff", letterSpacing: 0.02 }),
        text(k, 120, 560, 760, 130, "UP TO 50% OFF", { size: 76, font: MONT, weight: 800, color: "#ffffff" }),
      ]);
    },
  },
  {
    id: "new-badge",
    label: "New badge",
    group: "Badges",
    make: (doc, _ink, share = 0.35) => {
      const k = kit(doc, 1000, 1000, share);
      return group(k, "New badge", [
        shape(k, 0, 0, 1000, 1000, "ellipse", { fill: "#111111" }),
        shape(k, 45, 45, 910, 910, { kind: "ring", points: 4, ratio: 0.95, round: 0 }, { fill: "#ffd34d" }),
        text(k, 100, 330, 800, 340, "NEW", { size: 330, font: BEBAS, color: "#ffd34d", letterSpacing: 0.04 }),
      ]);
    },
  },
  {
    id: "ribbon",
    label: "Ribbon banner",
    group: "Badges",
    make: (doc, _ink, share = 0.8) => {
      const k = kit(doc, 1000, 260, share);
      return group(k, "Ribbon banner", [
        path(k, [{ closed: true, nodes: [{ x: 0, y: 60 }, { x: 180, y: 60 }, { x: 180, y: 250 }, { x: 0, y: 250 }, { x: 60, y: 155 }] }], { fill: "#a3252f" }, "Ribbon tail"),
        path(k, [{ closed: true, nodes: [{ x: 820, y: 60 }, { x: 1000, y: 60 }, { x: 940, y: 155 }, { x: 1000, y: 250 }, { x: 820, y: 250 }] }], { fill: "#a3252f" }, "Ribbon tail"),
        path(k, [{ closed: true, nodes: [{ x: 100, y: 190 }, { x: 180, y: 190 }, { x: 180, y: 250 }] }], { fill: "#5e131b" }, "Ribbon fold"),
        path(k, [{ closed: true, nodes: [{ x: 900, y: 190 }, { x: 820, y: 250 }, { x: 820, y: 190 }] }], { fill: "#5e131b" }, "Ribbon fold"),
        shape(k, 100, 0, 800, 190, "rectangle", { fill: "#d6343f" }),
        text(k, 120, 20, 760, 150, "YOUR TITLE HERE", { size: 66, font: MONT, weight: 800, color: "#ffffff", letterSpacing: 0.05 }),
      ]);
    },
  },
  {
    id: "price-tag",
    label: "Price tag",
    group: "Badges",
    make: (doc, _ink, share = 0.5) => {
      const k = kit(doc, 1000, 420, share);
      return group(k, "Price tag", [
        path(k, [{ closed: true, nodes: [{ x: 0, y: 210 }, { x: 170, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 420 }, { x: 170, y: 420 }] }], { fill: "#f4c542", join: "round" }, "Tag"),
        shape(k, 95, 175, 70, 70, "ellipse", { fill: "#ffffff" }),
        text(k, 220, 60, 740, 300, "$19.99", { size: 230, font: ANTON, color: "#111111" }),
      ]);
    },
  },
  {
    id: "stamp",
    label: "Stamp",
    group: "Badges",
    make: (doc, _ink, share = 0.4) => {
      const k = kit(doc, 1000, 1000, share);
      const red = "#c62828";
      return group(k, "Stamp", [
        shape(k, 0, 0, 1000, 1000, { kind: "ring", points: 4, ratio: 0.9, round: 0 }, { fill: red }),
        shape(k, 70, 70, 860, 860, { kind: "ring", points: 4, ratio: 0.97, round: 0 }, { fill: red }),
        text(k, 60, 390, 880, 220, "APPROVED", { size: 170, font: ANTON, color: red, letterSpacing: 0.04 }, { transform: { ...text(k, 60, 390, 880, 220, "", { size: 1 }).transform, rotation: -14 } }),
        shape(k, 440, 170, 120, 120, "star", { fill: red }),
        shape(k, 440, 710, 120, 120, "star", { fill: red }),
      ]);
    },
  },
  {
    id: "speech-hello",
    label: "Speech bubble",
    group: "Badges",
    make: (doc, _ink, share = 0.45) => {
      const k = kit(doc, 1000, 760, share);
      return group(k, "Speech bubble", [
        shape(k, 0, 0, 1000, 760, { kind: "speech", points: 4, ratio: 0.25, round: 0.5 }, { fill: "#ffffff", stroke: "#111111", strokeWidth: 14 }),
        text(k, 60, 120, 880, 330, "Hello!", { size: 230, font: CAVEAT, weight: 700, color: "#111111" }),
      ]);
    },
  },
  {
    id: "divider",
    label: "Divider",
    group: "Lines & doodles",
    make: (doc, ink, share = 0.7) => {
      const k = kit(doc, 1000, 80, share);
      return group(k, "Divider", [
        shape(k, 0, 30, 420, 20, "line", { stroke: ink, strokeWidth: 8, fill: null }),
        shape(k, 460, 0, 80, 80, { kind: "polygon", points: 4, ratio: 0.5, round: 0 }, { fill: ink }),
        shape(k, 580, 30, 420, 20, "line", { stroke: ink, strokeWidth: 8, fill: null }),
      ]);
    },
  },
  {
    id: "doodle-circle",
    label: "Hand-drawn circle",
    group: "Lines & doodles",
    make: (doc, _ink, share = 0.55) => {
      const k = kit(doc, 1000, 620, share);
      const loop = trace(90, (t) => {
        const a = -0.5 + t * Math.PI * 2.15;
        const r = 1 + 0.05 * Math.sin(t * 9) + 0.04 * t;
        return { x: 500 + 470 * r * Math.cos(a) * 0.98, y: 310 + 280 * r * Math.sin(a) };
      });
      return path(k, [{ closed: false, nodes: loop }], { fill: null, stroke: "#e8343a", strokeWidth: 16, cap: "round", join: "round" }, "Hand-drawn circle");
    },
  },
  {
    id: "swoosh",
    label: "Underline swoosh",
    group: "Lines & doodles",
    make: (doc, _ink, share = 0.6) => {
      const k = kit(doc, 1000, 200, share);
      return path(k, [{ closed: false, nodes: [{ x: 0, y: 150, out: { x: 350, y: 10 } }, { x: 1000, y: 70, in: { x: 640, y: 200 } }] }], { fill: null, stroke: "#e8343a", strokeWidth: 26, cap: "round" }, "Swoosh");
    },
  },
  {
    id: "arrow-doodle",
    label: "Curvy arrow",
    group: "Lines & doodles",
    make: (doc, ink, share = 0.4) => {
      const k = kit(doc, 1000, 700, share);
      const st = { fill: null, stroke: ink, strokeWidth: 20, cap: "round" as const, join: "round" as const };
      return group(k, "Curvy arrow", [
        path(k, [{ closed: false, nodes: [{ x: 40, y: 640, out: { x: 120, y: 160 } }, { x: 880, y: 130, in: { x: 480, y: -10 } }] }], st, "Arrow line"),
        path(k, [{ closed: false, nodes: [{ x: 740, y: 40 }, { x: 890, y: 128 }, { x: 790, y: 270 }] }], st, "Arrow head"),
      ]);
    },
  },
  {
    id: "squiggle",
    label: "Squiggle",
    group: "Lines & doodles",
    make: (doc, _ink, share = 0.6) => {
      const k = kit(doc, 1000, 160, share);
      const wave = trace(80, (t) => ({ x: t * 1000, y: 80 + 55 * Math.sin(t * Math.PI * 8) }));
      return path(k, [{ closed: false, nodes: wave }], { fill: null, stroke: "#3d8bfd", strokeWidth: 18, cap: "round", join: "round" }, "Squiggle");
    },
  },
  {
    id: "corners",
    label: "Corner brackets",
    group: "Decor",
    make: (doc, ink, share = 0.85) => {
      const k = kit(doc, 1000, 1000, share);
      const st = { fill: null, stroke: ink, strokeWidth: 14, cap: "square" as const, join: "miter" as const };
      const L = (pts: Point[]) => path(k, [{ closed: false, nodes: pts }], st, "Corner");
      return group(k, "Corner brackets", [
        L([{ x: 0, y: 200 }, { x: 0, y: 0 }, { x: 200, y: 0 }]),
        L([{ x: 800, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 200 }]),
        L([{ x: 1000, y: 800 }, { x: 1000, y: 1000 }, { x: 800, y: 1000 }]),
        L([{ x: 200, y: 1000 }, { x: 0, y: 1000 }, { x: 0, y: 800 }]),
      ]);
    },
  },
  {
    id: "sparkles",
    label: "Sparkles",
    group: "Decor",
    make: (doc, _ink, share = 0.35) => {
      const k = kit(doc, 1000, 1000, share);
      const star = { kind: "star" as const, points: 4, ratio: 0.22, round: 0 };
      return group(k, "Sparkles", [
        shape(k, 0, 0, 580, 580, star, { fill: "#ffd34d" }),
        shape(k, 610, 430, 320, 320, star, { fill: "#ffd34d" }),
        shape(k, 330, 720, 230, 230, star, { fill: "#ffd34d" }),
      ]);
    },
  },
  {
    id: "confetti",
    label: "Confetti",
    group: "Decor",
    make: (doc, _ink, share = 0.9) => {
      const k = kit(doc, 1000, 1000, share);
      const colors = ["#e8343a", "#ffd34d", "#3d8bfd", "#2fbf71", "#8b5cf6", "#ff7a45"];
      // A fixed scatter (the same every time).
      let seed = 7;
      const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const bits: Layer[] = [];
      for (let i = 0; i < 26; i++) {
        const x = r() * 940;
        const y = r() * 940;
        const c = colors[i % colors.length];
        const kind = (["ellipse", "rectangle", "star", "polygon"] as const)[i % 4];
        const size = 26 + r() * 40;
        const l = shape(k, x, y, kind === "rectangle" ? size * 0.5 : size, size, kind === "polygon" ? { kind, points: 3, ratio: 0.5, round: 0 } : kind, { fill: c });
        bits.push({ ...l, transform: { ...l.transform, rotation: Math.round(r() * 360) } });
      }
      return group(k, "Confetti", bits);
    },
  },
  {
    id: "tape",
    label: "Washi tape",
    group: "Decor",
    make: (doc, _ink, share = 0.4) => {
      const k = kit(doc, 1000, 260, share);
      const l = shape(k, 0, 0, 1000, 260, "rectangle", { fill: "#f3e3a1", fillOpacity: 0.85 });
      return { ...l, name: "Washi tape", transform: { ...l.transform, rotation: -8 } };
    },
  },
  {
    id: "quote-mark",
    label: "Quote mark",
    group: "Decor",
    make: (doc, _ink, share = 0.3) => {
      const k = kit(doc, 1000, 1000, share);
      return text(k, 0, 0, 1000, 1000, "“", { size: 1300, font: PLAYFAIR, weight: 700, color: "#d9a441", lineHeight: 1 }, { name: "Quote mark" });
    },
  },
  {
    id: "polaroid",
    label: "Instant photo",
    group: "Photo frames",
    make: (doc, _ink, share = 0.6) => {
      const k = kit(doc, 1000, 1200, share);
      return group(k, "Instant photo", [
        shape(k, 0, 0, 1000, 1200, "rectangle", { fill: "#ffffff" }, { fx: fx(k, { shadow: { color: "#000000", opacity: 0.35, angle: 90, distance: 14, blur: 40, spread: 0 } }) }),
        frame(k, 60, 60, 880, 880),
        text(k, 60, 990, 880, 150, "summer days", { size: 110, font: CAVEAT, weight: 700, color: "#333333" }),
      ]);
    },
  },
  {
    id: "circle-photo",
    label: "Round photo",
    group: "Photo frames",
    make: (doc, _ink, share = 0.55) => {
      const k = kit(doc, 1000, 1000, share);
      return frame(k, 0, 0, 1000, 1000, "ellipse", { name: "Round photo", fx: fx(k, { outline: { color: "#ffffff", opacity: 1, width: 24 }, shadow: { color: "#000000", opacity: 0.3, angle: 90, distance: 12, blur: 36, spread: 0 } }) });
    },
  },
  {
    id: "heart-photo",
    label: "Heart photo",
    group: "Photo frames",
    make: (doc, _ink, share = 0.55) => {
      const k = kit(doc, 1000, 920, share);
      return frame(k, 0, 0, 1000, 920, "heart", { name: "Heart photo" });
    },
  },
  {
    id: "arch-photo",
    label: "Rounded photo",
    group: "Photo frames",
    make: (doc, _ink, share = 0.6) => {
      const k = kit(doc, 800, 1000, share);
      return frame(k, 0, 0, 800, 1000, { kind: "rectangle", points: 4, ratio: 0.5, round: 0.35 }, { name: "Rounded photo" });
    },
  },
  // ─── Text combinations ───
  {
    id: "title-sub",
    label: "Title and subtitle",
    group: "Text",
    make: (doc, ink, share = 0.8) => {
      const k = kit(doc, 1000, 420, share);
      return group(k, "Title and subtitle", [
        text(k, 0, 0, 1000, 280, "BIG TITLE", { size: 250, font: ANTON, color: ink }),
        text(k, 0, 300, 1000, 110, "a short line to go with it", { size: 62, font: MONT, weight: 700, color: ink, letterSpacing: 0.2, textCase: "upper" }),
      ]);
    },
  },
  {
    id: "quote",
    label: "Quote",
    group: "Text",
    make: (doc, ink, share = 0.8) => {
      const k = kit(doc, 1000, 460, share);
      return group(k, "Quote", [
        text(k, 0, 0, 1000, 320, "“Make it simple,\nbut significant.”", { size: 96, font: PLAYFAIR, weight: 700, italic: true, color: ink, lineHeight: 1.2 }),
        text(k, 0, 350, 1000, 90, "— A WISE PERSON", { size: 44, font: MONT, weight: 600, color: ink, letterSpacing: 0.25 }),
      ]);
    },
  },
  {
    id: "big-number",
    label: "Big number",
    group: "Text",
    make: (doc, ink, share = 0.6) => {
      const k = kit(doc, 1000, 640, share);
      return group(k, "Big number", [
        text(k, 0, 0, 1000, 470, "50%", { size: 470, font: ANTON, color: "#e8343a" }),
        text(k, 0, 480, 1000, 150, "OFF EVERYTHING", { size: 128, font: BEBAS, color: ink, letterSpacing: 0.1 }),
      ]);
    },
  },
  {
    id: "event",
    label: "Event date",
    group: "Text",
    make: (doc, ink, share = 0.7) => {
      const k = kit(doc, 1000, 380, share);
      return group(k, "Event date", [
        text(k, 0, 0, 1000, 230, "SAT 12 OCT", { size: 220, font: BEBAS, color: ink, letterSpacing: 0.06 }),
        shape(k, 380, 245, 240, 14, "line", { stroke: "#d9a441", strokeWidth: 8, fill: null }),
        text(k, 0, 280, 1000, 90, "Doors 7 PM · The Hall", { size: 62, font: MONT, weight: 600, color: ink }),
      ]);
    },
  },
  {
    id: "script-caps",
    label: "Script and capitals",
    group: "Text",
    make: (doc, ink, share = 0.75) => {
      const k = kit(doc, 1000, 520, share);
      return group(k, "Script and capitals", [
        text(k, 0, 0, 1000, 290, "Happy", { size: 230, font: "Pacifico, cursive", color: "#e0457b" }),
        text(k, 0, 290, 1000, 220, "BIRTHDAY", { size: 210, font: BEBAS, color: ink, letterSpacing: 0.18 }),
      ]);
    },
  },
  {
    id: "neon",
    label: "Neon sign",
    group: "Text",
    make: (doc, _ink, share = 0.7) => {
      const k = kit(doc, 1000, 340, share);
      return text(k, 0, 0, 1000, 340, "OPEN", { size: 260, font: "Monoton, sans-serif", color: "#ff7ae6" }, { name: "Neon sign", fx: fx(k, { glow: { color: "#ff2ad4", opacity: 1, blur: 46, spread: 0.2 } }) });
    },
  },
  {
    id: "sticker-text",
    label: "Sticker text",
    group: "Text",
    make: (doc, _ink, share = 0.6) => {
      const k = kit(doc, 1000, 400, share);
      return text(k, 0, 0, 1000, 400, "WOW!", { size: 330, font: ANTON, color: "#ffd34d", letterSpacing: 0.02 }, { name: "Sticker text", fx: fx(k, { outline: { color: "#111111", opacity: 1, width: 18 }, shadow: { color: "#000000", opacity: 0.35, angle: 90, distance: 16, blur: 4, spread: 0 } }) });
    },
  },
  {
    id: "highlighted",
    label: "Highlighted words",
    group: "Text",
    make: (doc, _ink, share = 0.8) => {
      const k = kit(doc, 1000, 200, share);
      return text(k, 0, 0, 1000, 200, "Highlighted words", { size: 84, font: MONT, weight: 800, color: "#111111", highlight: { color: "#ffe14d", opacity: 1, padding: 0.22, radius: 0.12 } }, { name: "Highlighted words" });
    },
  },
];

export const ELEMENT_GROUPS: readonly ElementGroup[] = ["Badges", "Lines & doodles", "Decor", "Photo frames", "Text"];
