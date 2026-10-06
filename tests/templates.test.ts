import { describe, expect, it } from "vitest";
import { assetData } from "@/core/design/assets";
import { buildCollage, COLLAGE_LAYOUTS, collageCells, defaultLayout, relayout, rotatePhotos } from "@/core/document/collage";
import type { CompositeDocument, GroupLayer, Layer, SlotLayer } from "@/core/document/model";
import { createDocument, flatten, relinkFrames, sanitizeDocument, syncLinkedFrames, updateLayer } from "@/core/document/operations";
import { fitLayers } from "@/core/looks/look";
import { ELEMENTS } from "@/features/design/elements";
import { TEMPLATES, matchesTemplate } from "@/features/design/templates";

const frames = (g: GroupLayer) => g.children.filter((c): c is SlotLayer => c.kind === "slot");

describe("collages", () => {
  it("every layout tiles the unit square without overlaps", () => {
    for (const l of COLLAGE_LAYOUTS) {
      if (l.id === "5-center") continue; // the middle photo sits over the others on purpose
      const area = l.cells.reduce((a, [, , w, h]) => a + w * h, 0);
      expect(area, l.id).toBeCloseTo(1, 6);
    }
  });

  it("cells are evenly spaced: the same gap between cells and at the edges", () => {
    const cells = collageCells(COLLAGE_LAYOUTS.find((l) => l.id === "4-grid")!, { x: 0, y: 0, width: 1000, height: 1000 }, 20);
    expect(cells[0]).toEqual({ x: 20, y: 20, width: 470, height: 470 });
    expect(cells[1].x - (cells[0].x + cells[0].width)).toBeCloseTo(20);
    expect(1000 - (cells[3].x + cells[3].width)).toBeCloseTo(20);
  });

  it("re-laying out keeps the photos (in order) and adds or drops empty frames", () => {
    const doc = createDocument(1080, 1080);
    const g = buildCollage(doc, "4-grid", { photos: ["a", "b", "c"] });
    expect(frames(g).map((f) => f.assetId)).toEqual(["a", "b", "c", null]);
    const three = relayout(g, { layout: "3-left" });
    expect(frames(three).map((f) => f.assetId)).toEqual(["a", "b", "c"]);
    const nine = relayout(three, { layout: "9-grid", spacing: 0.05, radius: 0.5 });
    expect(frames(nine)).toHaveLength(9);
    expect(frames(nine).slice(0, 3).map((f) => f.assetId)).toEqual(["a", "b", "c"]);
    expect(frames(nine)[0].frame.round).toBe(0.5);
    expect(nine.collage).toMatchObject({ layout: "9-grid", spacing: 0.05, radius: 0.5 });
    expect(frames(rotatePhotos(g)).map((f) => f.assetId)).toEqual([null, "a", "b", "c"]);
    expect(defaultLayout(4).cells).toHaveLength(4);
    expect(defaultLayout(30).cells).toHaveLength(9);
  });

  it("survives saving, and scales its area with the canvas", () => {
    const doc = createDocument(1080, 1350);
    const d = { ...doc, layers: [buildCollage(doc, "5-mosaic", { photos: ["p"] })] };
    expect(sanitizeDocument(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const [scaled] = fitLayers({ width: 1080, height: 1350, items: d.layers }, 540, 675) as GroupLayer[];
    expect(scaled.collage!.area).toEqual({ x: 0, y: 0, width: 540, height: 675 });
  });
});

describe("templates and elements", () => {
  it("every template builds valid layers inside its canvas, with unique ids", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(30);
    for (const t of TEMPLATES) {
      const doc = { ...createDocument(t.width, t.height, t.name, t.background, "design") };
      const layers = t.build(doc);
      expect(layers.length, t.id).toBeGreaterThan(0);
      const all = flatten(layers);
      expect(new Set(all.map((l) => l.id)).size, t.id).toBe(all.length);
      const saved = { ...doc, layers };
      // Clean data: a round trip through the sanitizer changes nothing.
      expect(sanitizeDocument(JSON.parse(JSON.stringify(saved))), t.id).toEqual(saved);
      for (const l of all) {
        if (l.kind === "group") continue;
        const tr = l.transform;
        expect(tr.x, `${t.id} ${l.name}`).toBeGreaterThan(-tr.width / 2);
        expect(tr.x, `${t.id} ${l.name}`).toBeLessThan(t.width + tr.width / 2);
        expect(tr.y, `${t.id} ${l.name}`).toBeGreaterThan(-tr.height / 2);
        expect(tr.y, `${t.id} ${l.name}`).toBeLessThan(t.height + tr.height / 2);
      }
    }
  });

  it("finds templates by name, category and tag", () => {
    expect(TEMPLATES.filter((t) => matchesTemplate(t, "wedding")).map((t) => t.id)).toContain("invite-wedding");
    expect(TEMPLATES.filter((t) => matchesTemplate(t, "wallpaper")).length).toBeGreaterThanOrEqual(4);
    expect(TEMPLATES.filter((t) => matchesTemplate(t, "collage")).length).toBeGreaterThanOrEqual(6);
  });

  it("every element builds clean layers centred on the canvas", () => {
    const doc = createDocument(1000, 800);
    for (const e of ELEMENTS) {
      const layer: Layer = e.make(doc, "#111111");
      const d = { ...doc, layers: [layer] };
      expect(sanitizeDocument(JSON.parse(JSON.stringify(d))), e.id).toEqual(d);
    }
  });
});

describe("saved design assets", () => {
  it("validates what it reads", () => {
    expect(assetData({ kind: "palette", data: { colors: ["#ff0000", "red", 7, "#00FF00"] } })).toEqual({ colors: ["#ff0000", "#00FF00"] });
    expect(assetData({ kind: "palette", data: { colors: [] } })).toBeNull();
    expect(assetData({ kind: "element", data: { width: 100, height: 100, layers: [{ kind: "nope" }] } })).toBeNull();
    const el = assetData({ kind: "element", data: { width: 100, height: 50, layers: [{ kind: "fill", color: "#123456" }] } });
    expect(el).toMatchObject({ width: 100, height: 50, layers: [{ kind: "fill", color: "#123456" }] });
    expect(assetData({ kind: "template", data: { document: { width: 10, height: 20, layers: [] } } })).toMatchObject({ document: { width: 10, height: 20 } });
    expect(assetData({ kind: "gradient", data: { gradient: { type: "radial", stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] } } })).toMatchObject({ gradient: { type: "radial" } });
    expect(assetData({ kind: "font", data: { family: "X", file: "not a blob" } })).toBeNull();
  });
});

describe("yes / but templates", () => {
  it("stack an edited frame over a before-edits frame, inside the canvas, with the two words", () => {
    for (const id of ["post-yes-but", "story-yes-but"]) {
      const t = TEMPLATES.find((x) => x.id === id)!;
      const layers = sanitizeDocument({ ...createDocument(t.width, t.height), layers: t.build({ width: t.width, height: t.height }) }).layers;
      const slots = flatten(layers).filter((l): l is SlotLayer => l.kind === "slot");
      expect(slots.map((s) => [s.name, !!s.original]), id).toEqual([
        ["Edited photo", false],
        ["Before edits", true],
      ]);
      const [upper, lower] = slots.map((s) => s.transform);
      expect(upper.y).toBeLessThan(lower.y);
      expect(upper.width).toBe(lower.width);
      expect(lower.y + lower.height / 2).toBeLessThanOrEqual(t.height);
      expect(upper.y - upper.height / 2).toBeGreaterThanOrEqual(0);
      const words = layers.filter((l) => l.kind === "text").map((l) => (l.kind === "text" ? l.style.text : ""));
      expect(words).toEqual(["yes", "but"]);
      expect(matchesTemplate(t, "before after")).toBe(true);
    }
  });
});

describe("two photos on one backdrop", () => {
  it("is two slides: a backdrop frame over both, and a frame centred on each slide", () => {
    const t = TEMPLATES.find((x) => x.id === "carousel-backdrop-pair")!;
    expect([t.width, t.height, t.slides]).toEqual([2160, 1350, 2]);
    const slots = flatten(t.build({ width: t.width, height: t.height })).filter((l): l is SlotLayer => l.kind === "slot");
    const byName = Object.fromEntries(slots.map((s) => [s.name, s.transform]));
    expect(byName["Background photo"]).toMatchObject({ x: 1080, y: 675, width: 2160, height: 1350 });
    expect(byName["Photo 1"]).toMatchObject({ x: 540, y: 675 });
    expect(byName["Photo 2"]).toMatchObject({ x: 1620, y: 675 });
    expect(byName["Photo 1"].width).toBe(byName["Photo 2"].width);
    // Filling empty frames top of the list first: Photo 1, Photo 2, then the backdrop.
    expect(slots.reverse().map((s) => s.name)).toEqual(["Photo 1", "Photo 2", "Background photo"]);
  });
});

describe("playing card (linked frames)", () => {
  const t = TEMPLATES.find((x) => x.id === "card-playing")!;
  const doc = createDocument(t.width, t.height);
  const card: CompositeDocument = { ...doc, layers: t.build(doc) };
  const halves = (d: CompositeDocument) => flatten(d.layers).filter((l): l is SlotLayer => l.kind === "slot");

  it("has the photo twice, the lower one upside down, the same size and mirrored through the middle", () => {
    const [top, bottom] = halves(card);
    expect(top.link).toBeTruthy();
    expect(bottom.link).toBe(top.link);
    expect(top.transform.rotation).toBe(0);
    expect(bottom.transform.rotation).toBe(180);
    expect(bottom.transform.width).toBeCloseTo(top.transform.width);
    expect(bottom.transform.height).toBeCloseTo(top.transform.height);
    expect(top.transform.x).toBeCloseTo(doc.width / 2);
    expect(top.transform.y + bottom.transform.y).toBeCloseTo(doc.height);
    // The corner letters too: one at the top left, one upside down at the bottom right.
    const letters = flatten(card.layers).filter((l) => l.kind === "text");
    expect(letters[0].transform.x + letters[1].transform.x).toBeCloseTo(doc.width);
    expect(letters[1].transform.rotation).toBe(180);
  });

  it("filling, moving or emptying one half does the same to the other", () => {
    const [top, bottom] = halves(card);
    const filled = syncLinkedFrames(card, updateLayer(card, bottom.id, (l) => (l.kind === "slot" ? { ...l, assetId: "p1" } : l)));
    expect(halves(filled).map((f) => f.assetId)).toEqual(["p1", "p1"]);
    const moved = syncLinkedFrames(filled, updateLayer(filled, top.id, (l) => (l.kind === "slot" ? { ...l, fit: { zoom: 2, x: 0.3, y: -0.1 } } : l)));
    expect(halves(moved).map((f) => f.fit)).toEqual([{ zoom: 2, x: 0.3, y: -0.1 }, { zoom: 2, x: 0.3, y: -0.1 }]);
    const emptied = syncLinkedFrames(moved, updateLayer(moved, bottom.id, (l) => (l.kind === "slot" ? { ...l, assetId: null } : l)));
    expect(halves(emptied).map((f) => f.assetId)).toEqual([null, null]);
    // Other edits pass through untouched.
    const renamed = updateLayer(card, top.id, (l) => ({ ...l, name: "Me" }));
    expect(syncLinkedFrames(card, renamed)).toBe(renamed);
  });

  it("an unlinked frame keeps its own photo", () => {
    const [top, bottom] = halves(card);
    const apart = updateLayer(card, bottom.id, (l) => {
      const { link: _off, ...rest } = l as SlotLayer;
      return rest;
    });
    const filled = syncLinkedFrames(apart, updateLayer(apart, top.id, (l) => (l.kind === "slot" ? { ...l, assetId: "p1" } : l)));
    expect(halves(filled).map((f) => f.assetId)).toEqual(["p1", null]);
  });

  it("links survive saving, and a second copy gets its own link", () => {
    expect(sanitizeDocument(JSON.parse(JSON.stringify(card)))).toEqual(card);
    const bad = sanitizeDocument({ ...card, layers: card.layers.map((l) => (l.kind === "slot" ? { ...l, link: "<script>" } : l)) });
    expect(halves(bad).every((f) => f.link === undefined)).toBe(true);
    const again = relinkFrames(card.layers);
    const [a, b] = flatten(again).filter((l): l is SlotLayer => l.kind === "slot");
    expect(a.link).toBe(b.link);
    expect(a.link).not.toBe(halves(card)[0].link);
  });
});
