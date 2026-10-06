import { describe, expect, it } from "vitest";
import { duplicateSlide, insertSlides, makeCarousel, moveSlide, removeSlide, sliceDocument, slideAt, slideCount, slideWidth } from "@/core/document/carousel";
import type { CompositeDocument, Layer, PaintLayer } from "@/core/document/model";
import { createDocument, fillLayer, paintLayer, pathLayer, sanitizeDocument, textLayer } from "@/core/document/operations";
import { smartShape } from "@/core/document/shapes";

const at = (doc: CompositeDocument, x: number, name: string): Layer => {
  const t = textLayer(doc, { text: name });
  return { ...t, name, transform: { ...t.transform, x, width: 200 } };
};
const xs = (doc: CompositeDocument) => Object.fromEntries(doc.layers.map((l) => [l.name, Math.round(l.transform.x)]));

function three(): CompositeDocument {
  const base = { ...createDocument(3240, 1350, "c", "#ffffff", "design"), carousel: { slides: 3 } };
  return { ...base, layers: [fillLayer(base, "#123456"), at(base, 500, "one"), at(base, 1500, "two"), at(base, 2700, "three"), at(base, 1080, "edge")] };
}

describe("carousels", () => {
  it("measures slides", () => {
    const d = three();
    expect(slideCount(d)).toBe(3);
    expect(slideWidth(d)).toBe(1080);
    expect(slideAt(d, 0)).toBe(0);
    expect(slideAt(d, 1079)).toBe(0);
    expect(slideAt(d, 1080)).toBe(1);
    expect(slideAt(d, 99999)).toBe(2);
    expect(sanitizeDocument(JSON.parse(JSON.stringify(d))).carousel).toEqual({ slides: 3 });
    expect(sanitizeDocument({ ...d, carousel: { slides: 99 } }).carousel).toEqual({ slides: 20 });
    expect(sanitizeDocument({ ...d, carousel: { slides: 1 } }).carousel).toBeUndefined();
  });

  it("adding a slide in the middle shifts what comes after and stretches backgrounds", () => {
    const d = insertSlides(three(), 1);
    expect(d.width).toBe(4320);
    expect(d.carousel).toEqual({ slides: 4 });
    expect(xs(d)).toMatchObject({ one: 500, two: 2580, three: 3780, edge: 2160 });
    const fill = d.layers[0];
    expect(fill.transform.width).toBe(4320);
    expect(fill.transform.x).toBe(2160);
  });

  it("removing a slide removes its layers and closes the gap", () => {
    const d = removeSlide(three(), 1);
    expect(d.width).toBe(2160);
    expect(d.layers.map((l) => l.name)).not.toContain("two");
    expect(xs(d)).toMatchObject({ one: 500, three: 1620 });
    // Down to one slide, it is a single design again.
    expect(removeSlide(removeSlide(three(), 0), 0).carousel).toBeUndefined();
  });

  it("moves a slide with its layers", () => {
    const d = moveSlide(three(), 0, 2);
    expect(xs(d)).toMatchObject({ one: 2660, two: 420, three: 1620 });
    const back = moveSlide(d, 2, 0);
    expect(xs(back)).toMatchObject(xs(three()));
  });

  it("duplicates a slide's layers into a new slide after it", () => {
    let n = 0;
    const d = duplicateSlide(three(), 0, () => `copy${n++}`);
    expect(slideCount(d)).toBe(4);
    const copies = d.layers.filter((l) => l.id.startsWith("copy"));
    expect(copies.map((l) => l.name)).toEqual(["one"]);
    expect(Math.round(copies[0].transform.x)).toBe(1580);
  });

  it("turns a design into a carousel; drawings keep their strokes in place", () => {
    const base = createDocument(1080, 1350, "d", "#ffffff", "design");
    const drawing: PaintLayer = { ...paintLayer(base), ops: [{ type: "stroke", brush: "round", color: "#000000", size: 0.1, opacity: 1, hardness: 1, points: [0.5, 0.5, 1, 0.9, 0.5, 1], seed: 1 }] };
    const star = pathLayer(base, smartShape("star"));
    const c = makeCarousel({ ...base, layers: [drawing, star] }, 3);
    expect(c.width).toBe(3240);
    expect(c.carousel).toEqual({ slides: 3 });
    const p = c.layers[0] as PaintLayer;
    expect(p.transform.width).toBe(3240);
    const stroke = p.ops[0];
    if (stroke.type !== "stroke") throw new Error();
    expect(stroke.points[0] * 3240).toBeCloseTo(540);
    expect(stroke.points[3] * 3240).toBeCloseTo(972);
    expect(stroke.size * 3240).toBeCloseTo(108);
    // The star stays on the first slide.
    expect(c.layers[1].transform.x).toBe(540);
  });

  it("slices slides for export so neighbours meet exactly", () => {
    const d = three();
    const s1 = sliceDocument(d, 1);
    expect(s1.width).toBe(1080);
    expect(s1.carousel).toBeUndefined();
    expect(xs(s1)).toMatchObject({ two: 420, edge: 0, one: -580 });
    const pair = sliceDocument(d, 1, 2);
    expect(pair.width).toBe(2160);
    expect(pair.carousel).toEqual({ slides: 2 });
  });
});

describe("slides from templates", () => {
  it("adds a template's pages as new slides after one, shifted into place, under top effects", async () => {
    const { insertSlidesWith } = await import("@/core/document/carousel");
    const { effectLayer } = await import("@/core/document/operations");
    const d0 = three();
    const fx = effectLayer(d0, "blur")!;
    const d = { ...d0, layers: [...d0.layers, fx] };
    // Two pages laid out for a 2160 × 1350 canvas.
    const page = { width: 2160, height: 1350 };
    const left = at(page as CompositeDocument, 540, "page-a");
    const right = at(page as CompositeDocument, 1620, "page-b");
    const out = insertSlidesWith(d, 2, 2, [left, right]);
    expect(slideCount(out)).toBe(5);
    expect(out.width).toBe(5400);
    // Inserted after slide 2 (index 2): the pages land on slides 3 and 4; slide 3's text moves on.
    expect(xs(out)).toMatchObject({ one: 500, two: 1500, three: 2700 + 2160, "page-a": 2160 + 540, "page-b": 2160 + 1620 });
    // Above the design's layers, under the canvas-wide effect at the top.
    expect(out.layers.map((l) => l.name).slice(-3)).toEqual(["page-a", "page-b", fx.name]);
    // A single design becomes a carousel; too many slides change nothing.
    const single = createDocument(1080, 1350, "s", "#ffffff", "design");
    expect(slideCount(insertSlidesWith(single, 1, 1, [at(single, 540, "p")]))).toBe(2);
    expect(insertSlidesWith({ ...d, carousel: { slides: 20 }, width: 21600 }, 0, 1, [left])).toEqual({ ...d, carousel: { slides: 20 }, width: 21600 });
  });

  it("offers only templates with the same slide shape, carousels included", async () => {
    const { templatesForSlides } = await import("@/features/design/slide-templates");
    const portrait = { width: 3240, height: 1350, carousel: { slides: 3 } };
    const ids = templatesForSlides(portrait).map((t) => t.id);
    expect(ids).toContain("post-yes-but");
    expect(ids).toContain("carousel-tips"); // 5 slides of 4:5 fit (3 + 5 ≤ 20)
    expect(ids).not.toContain("post-quote"); // square
    expect(ids).not.toContain("story-weekend"); // 9:16
    const full = { width: 1080 * 19, height: 1350, carousel: { slides: 19 } };
    expect(templatesForSlides(full).map((t) => t.id)).not.toContain("carousel-tips"); // would pass 20 slides
    expect(templatesForSlides({ width: 1080, height: 1080 }).map((t) => t.id)).toContain("post-quote");
  });
});
