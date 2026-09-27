import { describe, expect, it } from "vitest";
import {
  align,
  contentToCanvas,
  createDocument,
  distribute,
  duplicateLayer,
  fillLayer,
  groupLayers,
  hitTest,
  layerBounds,
  locate,
  moveLayer,
  sanitizeDocument,
  shapeLayer,
  textLayer,
  ungroup,
} from "@/core/document/operations";
import { apply } from "@/core/develop/geometry";

const doc0 = createDocument(1000, 500);
const a = shapeLayer(doc0, "rectangle");
const b = fillLayer(doc0);
const c = textLayer(doc0);
const doc = { ...doc0, layers: [a, b, c] };

describe("composite document", () => {
  it("maps content uv to canvas through the transform", () => {
    const t = { x: 500, y: 250, width: 200, height: 100, rotation: 90, flipX: false, flipY: false };
    const m = contentToCanvas(t);
    const [x, y] = apply(m, 0, 0);
    // Rotated 90° clockwise, the top-left corner moves to the top-right.
    expect(x).toBeCloseTo(550, 6);
    expect(y).toBeCloseTo(150, 6);
    const [cx, cy] = apply(m, 0.5, 0.5);
    expect(cx).toBeCloseTo(500, 6);
    expect(cy).toBeCloseTo(250, 6);
  });

  it("hit tests the transformed quad and respects crop", () => {
    const layer = { ...a, transform: { ...a.transform, x: 200, y: 200, width: 100, height: 100 } };
    expect(hitTest(layer, { x: 200, y: 200 })).toBe(true);
    expect(hitTest(layer, { x: 260, y: 200 })).toBe(false);
    expect(hitTest({ ...layer, crop: { left: 0.6, top: 0, right: 1, bottom: 1 } }, { x: 200, y: 200 })).toBe(false);
  });

  it("groups, moves and ungroups while keeping order", () => {
    const grouped = groupLayers(doc, [a.id, b.id]);
    expect(grouped.doc.layers.map((l) => l.kind)).toEqual(["group", "text"]);
    const g = grouped.doc.layers[0];
    expect(g.kind === "group" && g.children.map((l) => l.id)).toEqual([a.id, b.id]);
    const moved = moveLayer(grouped.doc, c.id, grouped.id, 0);
    expect(locate(moved.layers, c.id)?.parent?.id).toBe(grouped.id);
    // A group cannot be moved into itself.
    expect(moveLayer(moved, grouped.id!, grouped.id, 0)).toBe(moved);
    const flat = ungroup(moved, grouped.id!);
    expect(flat.layers.map((l) => l.id)).toEqual([c.id, a.id, b.id]);
  });

  it("duplicates above the original with new ids", () => {
    const { doc: next, id } = duplicateLayer(doc, a.id);
    expect(next.layers.map((l) => l.id).indexOf(id!)).toBe(1);
    expect(id).not.toBe(a.id);
  });

  it("aligns to the canvas and distributes evenly", () => {
    const left = align(doc, [a.id], "left");
    expect(layerBounds(left.layers[0]).x).toBeCloseTo(0, 6);
    const three = [0, 1, 2].map((i) => ({ ...shapeLayer(doc0, "ellipse"), transform: { ...a.transform, x: [100, 150, 900][i], width: 50, height: 50 } }));
    const spread = distribute({ ...doc0, layers: three }, three.map((l) => l.id), "x");
    expect(spread.layers.map((l) => l.transform.x)).toEqual([100, 500, 900]);
  });

  it("sanitizes untrusted documents", () => {
    const clean = sanitizeDocument({ width: -5, layers: [{ kind: "fill", color: "red", opacity: 7 }, { kind: "evil" }], guides: [{ axis: "y", position: 10 }] });
    expect(clean.width).toBe(1);
    expect(clean.layers).toHaveLength(1);
    expect(clean.layers[0].opacity).toBe(1);
    expect(clean.layers[0].kind === "fill" && clean.layers[0].color).toBe("#000000");
    expect(clean.guides[0].axis).toBe("y");
    expect(sanitizeDocument(JSON.parse(JSON.stringify(doc))).layers).toHaveLength(3);
  });
});
