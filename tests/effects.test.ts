import { describe, expect, it } from "vitest";
import { createDocument, effectLayer, fillLayer, groupLayer, insertLayer, layersBelow, sanitizeDocument } from "@/core/document/operations";
import { EFFECTS, PICKS, effectById, newEffect, sanitizeEffect } from "@/core/effects/registry";
import { EFFECT_CATEGORIES, defaultParams, paramUniforms, sanitizeParams } from "@/core/effects/types";

describe("effect registry", () => {
  it("has unique ids, known categories and valid defaults", () => {
    const ids = new Set<string>();
    for (const def of EFFECTS) {
      expect(ids.has(def.id)).toBe(false);
      ids.add(def.id);
      expect(EFFECT_CATEGORIES).toContain(def.category);
      for (const p of def.params) {
        if (p.type === "number") {
          expect(p.default).toBeGreaterThanOrEqual(p.min);
          expect(p.default).toBeLessThanOrEqual(p.max);
        }
        if (p.type === "select") expect(p.options.map((o) => o.value)).toContain(p.default);
        if (p.type === "color") expect(p.default).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(sanitizeParams(def, defaultParams(def))).toEqual(defaultParams(def));
    }
    expect(EFFECTS.length).toBeGreaterThanOrEqual(30);
    for (const id of PICKS) expect(effectById(id)).toBeDefined();
  });

  it("covers every category", () => {
    for (const c of EFFECT_CATEGORIES) expect(EFFECTS.some((e) => e.category === c)).toBe(true);
  });

  it("clamps and repairs untrusted parameters", () => {
    const def = effectById("ascii")!;
    const p = sanitizeParams(def, { cell: 1e9, charset: "nope", background: "red", invert: "yes", extra: 1 });
    expect(p.cell).toBe(60);
    expect(p.charset).toBe("standard");
    expect(p.background).toBe("#0b0b0c");
    expect(p.invert).toBe(false);
    expect("extra" in p).toBe(false);
  });

  it("maps parameters to shader uniforms", () => {
    const def = effectById("halftone")!;
    const u = paramUniforms(def, { ...defaultParams(def), shape: "line", invert: true, ink: "#ff0000" });
    expect(u.p_shape).toBe(3);
    expect(u.p_invert).toBe(1);
    expect(u.p_ink).toEqual([1, 0, 0]);
    expect(u.p_size).toBe(10);
  });

  it("drops unknown effects", () => {
    expect(sanitizeEffect({ id: "does-not-exist", params: {} })).toBeNull();
    expect(sanitizeEffect({ id: "vhs", params: { bleed: -5 } })?.params.bleed).toBe(0);
    expect(newEffect("glitch")?.params.intensity).toBe(0.5);
  });
});

describe("effect layers", () => {
  it("round-trips through the document sanitizer", () => {
    const doc = createDocument(800, 600);
    const layer = effectLayer(doc, "bricks")!;
    const saved = insertLayer(doc, layer);
    const loaded = sanitizeDocument(JSON.parse(JSON.stringify(saved)));
    expect(loaded.layers[0]).toMatchObject({ kind: "effect", name: "Toy Bricks", effect: { id: "bricks" } });
    const broken = JSON.parse(JSON.stringify(saved));
    broken.layers[0].effect.id = "gone";
    expect(sanitizeDocument(broken).layers).toHaveLength(0);
  });

  it("previews only what is painted below the insertion point", () => {
    let doc = createDocument(100, 100);
    const a = fillLayer(doc, "#111111");
    const b = fillLayer(doc, "#222222");
    const c = fillLayer(doc, "#333333");
    const g = groupLayer(doc, [b, c]);
    doc = insertLayer(insertLayer(doc, a), g);
    const below = layersBelow(doc, b.id);
    const vis = (d: typeof doc) => [d.layers[0].visible, d.layers[1].visible, d.layers[1].kind === "group" && d.layers[1].children.map((l) => l.visible)];
    expect(vis(below)).toEqual([true, true, [true, false]]);
    expect(vis(layersBelow(doc, b.id, true))).toEqual([true, true, [false, false]]);
    expect(layersBelow(doc, null)).toBe(doc);
  });
});

describe("export verification", () => {
  const image = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x / w, y / h), (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  const scene = (u: number, v: number): [number, number, number, number] => [u * 255, v * 255, (1 - v) * 200, 255];

  it("accepts the same picture at another size and rejects blank, flipped or shrunken renders", async () => {
    const { similarImages } = await import("@/core/gpu/verify");
    const big = image(640, 480, scene);
    const small = image(128, 96, scene);
    expect(similarImages(big, small)).toBe(true);
    expect(similarImages(image(640, 480, () => [0, 0, 0, 0]), small)).toBe(false);
    expect(similarImages(image(640, 480, (u, v) => scene(u, 1 - v)), small)).toBe(false);
    expect(similarImages(image(640, 480, (u, v) => (u < 0.1 && v > 0.3 && v < 0.4 ? scene(u * 10, 1 - (v - 0.3) * 10) : [0, 0, 0, 0])), small)).toBe(false);
  });
});
