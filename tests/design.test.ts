import { describe, expect, it } from "vitest";
import type { Layer, PathLayer, SlotLayer, TextLayer } from "@/core/document/model";
import { createDocument, documentAssets, imageLayer, layerAsset, layerPaths, pathLayer, sanitizeDocument, slotLayer, textLayer, toEditablePath } from "@/core/document/operations";
import { fitUnit, mapPaths, pathBounds, pathData, SMART_SHAPES, shapePaths, smartShape } from "@/core/document/shapes";
import { lookLayers } from "@/core/looks/look";
import { curveSag, shownText } from "@/core/text/draw";

const doc = createDocument(1080, 1350, "Poster", "#ffffff", "design");

describe("smart shapes", () => {
  it("every shape fills its unit box and is closed (lines are open)", () => {
    for (const { kind } of SMART_SHAPES) {
      for (const aspect of [0.5, 1, 2]) {
        const paths = shapePaths(smartShape(kind), aspect);
        expect(paths.length, kind).toBeGreaterThan(0);
        const b = pathBounds(paths);
        // Within the box (curves may sample a hair inside the true extremes).
        expect(b.x, kind).toBeGreaterThanOrEqual(-1e-6);
        expect(b.y, kind).toBeGreaterThanOrEqual(-1e-6);
        expect(b.x + b.width, kind).toBeLessThanOrEqual(1 + 1e-6);
        expect(b.y + b.height, kind).toBeLessThanOrEqual(1 + 1e-6);
        if (kind !== "line") {
          expect(b.width, kind).toBeGreaterThan(0.9);
          expect(b.height, kind).toBeGreaterThan(0.9);
        }
        for (const p of paths) expect(p.closed, kind).toBe(kind !== "line");
        for (const p of paths) for (const n of p.nodes) for (const v of [n.x, n.y, n.in?.x ?? 0, n.out?.y ?? 0]) expect(Number.isFinite(v), kind).toBe(true);
      }
    }
  });

  it("stars have two corners per point, polygons one per side", () => {
    expect(shapePaths({ kind: "star", points: 5, ratio: 0.4, round: 0 })[0].nodes).toHaveLength(10);
    expect(shapePaths({ kind: "polygon", points: 6, ratio: 0.5, round: 0 })[0].nodes).toHaveLength(6);
    expect(shapePaths({ kind: "burst", points: 20, ratio: 0.8, round: 0 })[0].nodes).toHaveLength(40);
  });

  it("rounded corners become two nodes with handles, and stay round on wide boxes", () => {
    const sharp = shapePaths({ kind: "rectangle", points: 4, ratio: 0.5, round: 0 }, 2)[0];
    const round = shapePaths({ kind: "rectangle", points: 4, ratio: 0.5, round: 0.5 }, 2)[0];
    expect(sharp.nodes).toHaveLength(4);
    expect(round.nodes).toHaveLength(8);
    // Corner cut along x (unit box of a 2:1 box) is half the cut along y: a circular corner.
    // The top-left corner: cut along the left edge, then along the top.
    const [a, b] = [round.nodes[0], round.nodes[1]];
    expect(a.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo(0);
    expect(b.x * 2).toBeCloseTo(a.y, 5);
    expect(a.out).toBeDefined();
    expect(b.in).toBeDefined();
  });

  it("a ring is two ellipses wound in opposite directions (a hole with nonzero filling)", () => {
    const [outer, inner] = shapePaths({ kind: "ring", points: 4, ratio: 0.5, round: 0 });
    const area = (nodes: readonly { x: number; y: number }[]) => nodes.reduce((s, p, i) => s + p.x * nodes[(i + 1) % nodes.length].y - nodes[(i + 1) % nodes.length].x * p.y, 0);
    expect(Math.sign(area(outer.nodes))).toBe(-Math.sign(area(inner.nodes)));
    expect(pathBounds([inner]).width).toBeCloseTo(0.5, 2);
  });

  it("writes SVG path data and maps paths", () => {
    const d = pathData(shapePaths(smartShape("heart")), 100, 100);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("C");
    expect(d.endsWith("Z")).toBe(true);
    const moved = mapPaths([{ closed: false, nodes: [{ x: 0, y: 0, out: { x: 1, y: 1 } }] }], (p) => ({ x: p.x + 1, y: p.y }));
    expect(moved[0].nodes[0]).toEqual({ x: 1, y: 0, out: { x: 2, y: 1 } });
    expect(pathBounds(fitUnit([{ closed: true, nodes: [{ x: 3, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 9 }] }]))).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("path, frame and style layers", () => {
  it("a smart shape layer draws its generator until converted to nodes", () => {
    const star = pathLayer(doc, smartShape("star"));
    expect(star.paths).toEqual([]);
    expect(layerPaths(star)[0].nodes).toHaveLength(10);
    const editable = toEditablePath(star);
    expect(editable.shape).toBeNull();
    expect(layerPaths(editable)).toEqual(layerPaths(star));
  });

  it("survive a save and load, and junk is cleaned", () => {
    const star: PathLayer = { ...pathLayer(doc, smartShape("star")), fx: { shadow: { color: "#000000", opacity: 0.5, angle: 90, distance: 10, blur: 20, spread: 0.1 }, outline: { color: "#ffffff", opacity: 1, width: 6 } } };
    const drawn = { ...toEditablePath(pathLayer(doc, smartShape("heart"))), style: { ...star.style, fill: null, stroke: "#ff0000", strokeWidth: 4, dash: [3, 2] } };
    const frame: SlotLayer = { ...slotLayer(doc, smartShape("ellipse")), assetId: "a1", fit: { zoom: 2, x: 0.5, y: -0.25 } };
    const text: TextLayer = (() => {
      const t = textLayer(doc, { text: "hello world" }) as TextLayer;
      return { ...t, style: { ...t.style, curve: 0.5, textCase: "upper", underline: true, highlight: { color: "#ffe14d", opacity: 1, padding: 0.2, radius: 0.1 }, gradient: { type: "linear", angle: 0, scale: 1, offsetX: 0, offsetY: 0, reverse: false, stops: [{ offset: 0, color: "#ff0000", opacity: 1 }, { offset: 1, color: "#0000ff", opacity: 1 }] } } };
    })();
    const saved = { ...doc, layers: [star, drawn, frame, text] as Layer[] };
    const loaded = sanitizeDocument(JSON.parse(JSON.stringify(saved)));
    expect(loaded).toEqual(saved);
    expect(loaded.purpose).toBe("design");

    const junk = sanitizeDocument({
      ...saved,
      layers: [
        { ...star, shape: { kind: "spaceship", points: 1e9, ratio: -4, round: "x" }, fx: { shadow: { opacity: 9, blur: -3 }, glow: "nope" } },
        { ...drawn, paths: [{ closed: "yes", nodes: [{ x: 1e9, y: "q", in: { x: 0.5 } }, null] }, "bad"], style: { fill: "red", stroke: 7, dash: Array(50).fill(-1) } },
        { ...frame, assetId: 42, fit: { zoom: 0, x: 9 } },
        { kind: "warp-drive" },
      ],
    });
    expect(junk.layers).toHaveLength(3);
    const [j1, j2, j3] = junk.layers as [PathLayer, PathLayer, SlotLayer];
    expect(j1.shape).toEqual({ kind: "rectangle", points: 48, ratio: 0, round: 0 });
    expect(j1.fx).toEqual({ shadow: { color: "#000000", opacity: 1, angle: 90, distance: 10, blur: 0, spread: 0 } });
    expect(j2.paths).toEqual([{ closed: false, nodes: [{ x: 100, y: 0, in: { x: 0.5, y: 0 } }] }]);
    expect(j2.style.fill).toBe("#d9a441");
    expect(j2.style.stroke).toBeNull();
    expect(j2.style.dash).toHaveLength(8);
    expect(j2.style.dash.every((d) => d >= 0.01)).toBe(true);
    expect(j3.assetId).toBeNull();
    expect(j3.fit).toEqual({ zoom: 1, x: 1, y: 0 });
  });

  it("frames count as the photos a design uses; looks keep frames, empty", () => {
    const photo = imageLayer(doc, "p1", "Photo", 3000, 2000);
    const frame: SlotLayer = { ...slotLayer(doc), assetId: "p2" };
    const empty = slotLayer(doc);
    expect(layerAsset(frame)).toBe("p2");
    expect(layerAsset(empty)).toBeNull();
    expect(documentAssets([photo, frame, empty, { ...frame, id: "x", visible: false }])).toEqual(["p1", "p2"]);
    expect(documentAssets([photo, { ...frame, visible: false }], true)).toEqual(["p1"]);
    const look = lookLayers({ ...doc, layers: [photo, frame] });
    expect(look?.items).toHaveLength(1);
    expect((look?.items[0] as SlotLayer).assetId).toBeNull();
  });
});

describe("text", () => {
  it("applies letter case", () => {
    expect(shownText({ text: "hello World", textCase: "upper" })).toBe("HELLO WORLD");
    expect(shownText({ text: "Hello World", textCase: "lower" })).toBe("hello world");
    expect(shownText({ text: "the QUICK-brown fox", textCase: "title" })).toBe("The Quick-Brown Fox");
    expect(shownText({ text: "As typed" })).toBe("As typed");
  });

  it("a curve rises more the more it bends, up to a half circle", () => {
    expect(curveSag(0, 100)).toBe(0);
    expect(curveSag(0.5, 100)).toBeGreaterThan(curveSag(0.25, 100));
    // A half circle over 100 px of text: radius 100/π.
    expect(curveSag(1, 100)).toBeCloseTo(100 / Math.PI, 5);
    expect(curveSag(-1, 100)).toBeCloseTo(curveSag(1, 100), 9);
  });
});
