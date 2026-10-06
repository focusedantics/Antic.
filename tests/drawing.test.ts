import { describe, expect, it } from "vitest";
import type { PaintLayer, PathLayer } from "@/core/document/model";
import { canvasToPathPoint, createDocument, hitTest, paintLayer, pathFromCanvas, pathPointToCanvas, refitPath, sanitizeDocument } from "@/core/document/operations";
import { floodFill, paintExtent, recognize, resample, simplify, streamline } from "@/core/document/paint";
import { splitSegment } from "@/features/composite/tools/PenTool";

const doc = createDocument(1000, 800, "Drawing", "#ffffff", "design");
const close = (a: { x: number; y: number }, b: { x: number; y: number }, d = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, -Math.log10(d));
  expect(a.y).toBeCloseTo(b.y, -Math.log10(d));
};

describe("predictive brush", () => {
  const wobble = (i: number) => Math.sin(i * 1.7) * 2;
  it("straightens a shaky line", () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: 100 + wobble(i) }));
    const r = recognize(pts);
    expect(r?.kind).toBe("line");
    close(r!.points[0], pts[0]);
    close(r!.points[r!.points.length - 1], pts[39]);
    // Every point on the straight chord.
    for (const p of r!.points) expect(Math.abs(p.y - (pts[0].y + ((pts[39].y - pts[0].y) * (p.x - pts[0].x)) / (pts[39].x - pts[0].x)))).toBeLessThan(1e-6);
  });

  it("rounds a wobbly loop into an ellipse", () => {
    const pts = Array.from({ length: 80 }, (_, i) => {
      const a = (i / 79) * Math.PI * 2;
      return { x: 300 + 200 * Math.cos(a) + wobble(i), y: 300 + 120 * Math.sin(a) + wobble(i + 3) };
    });
    const r = recognize(pts);
    expect(r?.kind).toBe("ellipse");
    const xs = r!.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(390);
  });

  it("squares up a rough rectangle and a triangle", () => {
    const side = (a: { x: number; y: number }, b: { x: number; y: number }) => Array.from({ length: 15 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / 15 + wobble(i), y: a.y + ((b.y - a.y) * i) / 15 + wobble(i + 1) }));
    const rect = [...side({ x: 0, y: 0 }, { x: 400, y: 0 }), ...side({ x: 400, y: 0 }, { x: 400, y: 250 }), ...side({ x: 400, y: 250 }, { x: 0, y: 250 }), ...side({ x: 0, y: 250 }, { x: 0, y: 4 })];
    const r = recognize(rect);
    expect(r?.kind).toBe("rectangle");
    // Corners are exactly the bounds'.
    expect(new Set(r!.points.map((p) => Math.round(p.x)))).toContain(Math.round(Math.min(...rect.map((p) => p.x))));
    const tri = [...side({ x: 0, y: 300 }, { x: 200, y: 0 }), ...side({ x: 200, y: 0 }, { x: 400, y: 300 }), ...side({ x: 400, y: 300 }, { x: 3, y: 298 })];
    expect(recognize(tri)?.kind).toBe("triangle");
  });

  it("leaves scribbles alone", () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({ x: (i * 37) % 200, y: (i * 53) % 170 }));
    expect(recognize(pts)).toBeNull();
    expect(recognize([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });

  it("streamline lags behind the pointer by the amount", () => {
    expect(streamline(null, 10, 10, 0.5)).toEqual({ x: 10, y: 10 });
    expect(streamline({ x: 0, y: 0 }, 10, 0, 0).x).toBeCloseTo(10);
    expect(streamline({ x: 0, y: 0 }, 10, 0, 0.5).x).toBeCloseTo(5.5);
  });

  it("simplifies polylines", () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(simplify(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });
});

describe("paint", () => {
  it("resamples strokes evenly and ends at the last point", () => {
    const dabs = resample([0, 0, 1, 0.1, 0, 0.5], 100, 100, 2);
    expect(dabs).toHaveLength(6);
    expect(dabs[1].x).toBeCloseTo(2);
    expect(dabs[1].p).toBeCloseTo(0.9);
    expect(dabs[dabs.length - 1]).toEqual({ x: 10, y: 0, p: 0.5 });
  });

  it("bucket-fills an enclosed area and tucks under its anti-aliased edge", () => {
    const w = 20;
    const h = 20;
    const data = new Uint8ClampedArray(w * h * 4);
    // A black square outline from 4 to 15, with a half-covered pixel row inside it.
    for (let y = 4; y <= 15; y++)
      for (let x = 4; x <= 15; x++) {
        const edge = x === 4 || x === 15 || y === 4 || y === 15;
        const i = (y * w + x) * 4;
        if (edge) data[i + 3] = 255;
        else if (x === 5) data[i + 3] = 128;
      }
    const img = { width: w, height: h, data };
    const filled = floodFill(img, 10, 10, "#ff0000", 1, 0.1);
    expect(filled).toBe(9 * 10);
    const at = (x: number, y: number) => [...data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
    expect(at(10, 10)).toEqual([255, 0, 0, 255]);
    // Outside is untouched.
    expect(at(1, 1)).toEqual([0, 0, 0, 0]);
    // The half-covered pixel next to the fill got the fill underneath: fully opaque now, red showing through.
    expect(at(5, 10)[3]).toBe(255);
    expect(at(5, 10)[0]).toBeGreaterThan(100);
    // The outline keeps its colour where it was solid.
    expect(at(4, 10)).toEqual([0, 0, 0, 255]);
  });

  it("a drawing is picked only where something is drawn", () => {
    const empty = paintLayer(doc);
    expect(paintExtent(empty.ops)).toBeNull();
    expect(hitTest(empty, { x: 500, y: 400 })).toBe(false);
    const drawn: PaintLayer = { ...empty, ops: [{ type: "stroke", brush: "round", color: "#000000", size: 0.02, opacity: 1, hardness: 1, points: [0.1, 0.1, 1, 0.3, 0.2, 1], seed: 1 }] };
    expect(hitTest(drawn, { x: 200, y: 120 })).toBe(true);
    expect(hitTest(drawn, { x: 800, y: 700 })).toBe(false);
    // An eraser covers nothing; a fill covers the box.
    expect(paintExtent([{ ...drawn.ops[0], brush: "eraser" } as PaintLayer["ops"][number]])).toBeNull();
    expect(paintExtent([{ type: "fill", x: 0.5, y: 0.5, color: "#000000", opacity: 1, tolerance: 0 }])).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });

  it("strokes and fills survive a save, junk is cleaned and points are capped", () => {
    const layer: PaintLayer = {
      ...paintLayer(doc),
      ops: [
        { type: "stroke", brush: "spray", color: "#123456", size: 0.05, opacity: 0.5, hardness: 0.3, points: [0.1, 0.2, 1, 0.3, 0.4, 0.5], seed: 42 },
        { type: "fill", x: 0.5, y: 0.5, color: "#abcdef", opacity: 1, tolerance: 0.2 },
      ],
    };
    const d = { ...doc, layers: [layer] };
    expect(sanitizeDocument(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const junk = sanitizeDocument({ ...d, layers: [{ ...layer, ops: [{ type: "stroke", brush: "laser", points: [1, 2], color: "x" }, { type: "stroke", points: ["a", 2, 3, 4], seed: -5 }, { type: "nope" }, 7] }] });
    const ops = (junk.layers[0] as PaintLayer).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "stroke", brush: "round", color: "#000000", points: [0, 2, 3], seed: 0 });
  });
});

describe("pen and points", () => {
  it("a pen path keeps its points where they were drawn, with a stroke inset", () => {
    const nodes = [{ x: 100, y: 100 }, { x: 400, y: 100, in: { x: 300, y: 0 } }, { x: 400, y: 300 }];
    const layer = pathFromCanvas(doc, nodes, false, { fill: null, stroke: "#000000", strokeWidth: 20 });
    expect(layer.transform.width).toBeCloseTo(300 + 20 + 0, 0);
    nodes.forEach((n, i) => close(pathPointToCanvas(layer, layer.paths[0].nodes[i]), n, 1e-6));
    close(pathPointToCanvas(layer, layer.paths[0].nodes[1].in!), { x: 300, y: 0 }, 1e-6);
  });

  it("refitting keeps every point in place, also rotated and flipped", () => {
    const base = pathFromCanvas(doc, [{ x: 100, y: 100 }, { x: 300, y: 120 }, { x: 200, y: 260 }], true, { fill: "#ff0000", stroke: "#000000", strokeWidth: 10 });
    const turned: PathLayer = { ...base, transform: { ...base.transform, rotation: 30, flipX: true } };
    // Push a point outside the box, then refit.
    const moved: PathLayer = { ...turned, paths: [{ ...turned.paths[0], nodes: turned.paths[0].nodes.map((n, i) => (i === 1 ? { x: 1.6, y: -0.4 } : n)) }] };
    const before = moved.paths[0].nodes.map((n) => pathPointToCanvas(moved, n));
    const fitted = refitPath(moved);
    const after = fitted.paths[0].nodes.map((n) => pathPointToCanvas(fitted, n));
    before.forEach((p, i) => close(after[i], p, 1e-6));
    for (const n of fitted.paths[0].nodes) {
      expect(n.x).toBeGreaterThanOrEqual(-1e-9);
      expect(n.x).toBeLessThanOrEqual(1 + 1e-9);
    }
    close(canvasToPathPoint(fitted, after[2]), fitted.paths[0].nodes[2], 1e-6);
  });

  it("splitting a curve keeps its shape and adds a smooth point on it", () => {
    const sub = { closed: false, nodes: [{ x: 0, y: 0, out: { x: 0, y: 1 } }, { x: 1, y: 1, in: { x: 0, y: 1 } }] };
    const split = splitSegment(sub, 0, 0.5);
    expect(split.nodes).toHaveLength(3);
    const m = split.nodes[1];
    // The curve's midpoint: 0.125·P0 + 0.375·P1 + 0.375·P2 + 0.125·P3.
    close(m, { x: 0.125 * 0 + 0.375 * 0 + 0.375 * 0 + 0.125, y: 0.375 + 0.375 + 0.125 }, 1e-9);
    expect(m.in && m.out).toBeTruthy();
    const line = splitSegment({ closed: false, nodes: [{ x: 0, y: 0 }, { x: 2, y: 0 }] }, 0, 0.5);
    expect(line.nodes[1]).toEqual({ x: 1, y: 0 });
  });
});
