import { describe, expect, it } from "vitest";
import type { Layer } from "@/core/document/model";
import { arrangeLayers, createDocument, fillLayer, groupLayers, moveLayers } from "@/core/document/operations";

const base = createDocument(1000, 500);
// Five layers, bottom first, named by letter.
const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((name) => ({ ...fillLayer(base), name }));
const doc = { ...base, layers: [a, b, c, d, e] };
const names = (layers: readonly Layer[]): string => layers.map((l) => (l.kind === "group" ? `[${names(l.children)}]` : l.name)).join("");

describe("arranging layers", () => {
  it("brings forward, to front, backward and to back, one layer or a block", () => {
    expect(names(arrangeLayers(doc, [b.id], "forward").layers)).toBe("acbde");
    expect(names(arrangeLayers(doc, [b.id], "front").layers)).toBe("acdeb");
    expect(names(arrangeLayers(doc, [d.id], "backward").layers)).toBe("abdce");
    expect(names(arrangeLayers(doc, [d.id], "back").layers)).toBe("dabce");
    // Several selected move as a block and keep their order, even when apart.
    expect(names(arrangeLayers(doc, [a.id, b.id], "forward").layers)).toBe("cabde");
    expect(names(arrangeLayers(doc, [a.id, c.id], "forward").layers)).toBe("badce");
  });

  it("returns the same document when nothing would move", () => {
    expect(arrangeLayers(doc, [e.id], "front")).toBe(doc);
    expect(arrangeLayers(doc, [e.id], "forward")).toBe(doc);
    expect(arrangeLayers(doc, [a.id], "back")).toBe(doc);
    expect(arrangeLayers(doc, [d.id, e.id], "forward")).toBe(doc);
    expect(arrangeLayers(doc, [], "front")).toBe(doc);
  });

  it("arranges inside a group without leaving it", () => {
    const g = groupLayers(doc, [b.id, c.id, d.id]);
    expect(names(g.doc.layers)).toBe("a[bcd]e");
    expect(names(arrangeLayers(g.doc, [b.id], "front").layers)).toBe("a[cdb]e");
    expect(names(arrangeLayers(g.doc, [g.id!], "back").layers)).toBe("[bcd]ae");
  });

  it("drops layers above, below or into another, keeping their order", () => {
    expect(names(moveLayers(doc, [a.id], d.id, "above").layers)).toBe("bcdae");
    expect(names(moveLayers(doc, [e.id], b.id, "below").layers)).toBe("aebcd");
    expect(names(moveLayers(doc, [e.id, a.id], c.id, "above").layers)).toBe("bcaed");
    const g = groupLayers(doc, [b.id, c.id]);
    expect(names(moveLayers(g.doc, [e.id], g.id!, "into").layers)).toBe("a[bce]d");
    // Out of a group, next to a layer outside it.
    expect(names(moveLayers(g.doc, [b.id], d.id, "above").layers)).toBe("a[c]dbe");
  });

  it("refuses moves that make no sense", () => {
    const g = groupLayers(doc, [b.id, c.id]);
    // Next to itself, into itself, into a group it contains, into a layer that isn't a group.
    expect(moveLayers(doc, [c.id], c.id, "above")).toBe(doc);
    expect(moveLayers(g.doc, [g.id!], g.id!, "into")).toBe(g.doc);
    expect(moveLayers(g.doc, [g.id!], b.id, "above")).toBe(g.doc);
    expect(moveLayers(doc, [a.id], b.id, "into")).toBe(doc);
    // Already there.
    expect(moveLayers(doc, [b.id], a.id, "above")).toBe(doc);
  });
});
