import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TextLayer, TextStyle } from "@/core/document/model";
import { createDocument, flatten, sanitizeDocument, textLayer } from "@/core/document/operations";
import { detailFields, fillDetail, fillField } from "@/features/design/details";
import { templateHash } from "@/features/design/template-hash";
import { TEMPLATE_LOOKS, TEMPLATES } from "@/features/design/templates";

const stylized = TEMPLATES.filter((t) => t.category === "Stylized");
const hashes: Record<string, string> = JSON.parse(readFileSync("src/features/design/template-previews.json", "utf8"));

describe("stylized posters", () => {
  it("five of each look, each layered with effects and filled in from labelled fields", () => {
    for (const look of TEMPLATE_LOOKS) expect(stylized.filter((t) => t.look === look.id), look.id).toHaveLength(5);
    for (const t of stylized) {
      const layers = flatten(t.build({ width: t.width, height: t.height }));
      expect(layers.some((l) => l.kind === "effect"), t.id).toBe(true);
      const fields = detailFields({ layers: t.build({ width: t.width, height: t.height }) });
      expect(fields.length, t.id).toBeGreaterThanOrEqual(4);
      expect(fields.some((f) => /place/i.test(f.label)), t.id).toBe(true);
    }
  });

  it("every poster has a rendered preview made from what it draws now (npm run templates:previews)", () => {
    for (const t of TEMPLATES.filter((x) => x.preview)) {
      expect(existsSync(`public/templates/${t.id}.webp`), `${t.id}: no preview`).toBe(true);
      expect(hashes[t.id], `${t.id}: the preview is out of date; run npm run templates:previews`).toBe(templateHash(t));
    }
    // No previews left over from templates that are gone.
    for (const id of Object.keys(hashes)) expect(TEMPLATES.some((t) => t.id === id && t.preview), id).toBe(true);
  });

  it("lists the details in reading order, a label's copies together", () => {
    const t = TEMPLATES.find((x) => x.id === "sty-club-night")!;
    const fields = detailFields({ layers: t.build({ width: t.width, height: t.height }) });
    expect(fields[0]).toMatchObject({ label: "Title", value: "BASS" });
    expect(fields[0].ids).toHaveLength(6);
    expect(fields.at(-1)!.label).toBe("Place");
  });
});

describe("filling in a detail", () => {
  // Monospaced stand-in: each character is 0.6 of the size wide.
  const measure = (s: TextStyle) => Math.max(...s.text.split("\n").map((l) => l.length)) * s.size * 0.6;
  const doc = createDocument(1000, 1000);
  const base = textLayer(doc, { text: "SAT 14 DEC", size: 50 }) as TextLayer;
  const layer: TextLayer = { ...base, field: "Date", transform: { ...base.transform, width: 400, height: 70 } };

  it("shrinks long words to the box, grows back to the designed size, and shrinks for extra lines", () => {
    const long = fillField(layer, "SATURDAY 14 DECEMBER 2026", measure);
    expect(long.style.text).toBe("SATURDAY 14 DECEMBER 2026");
    expect(long.fieldSize).toBe(50);
    expect(measure(long.style)).toBeLessThanOrEqual(400);
    expect(long.style.size).toBeLessThan(30);
    expect(fillField(long, "FRI 9 JAN", measure).style.size).toBe(50);
    const twoLines = fillField(long, "FRI\n9 JAN", measure);
    expect(twoLines.style.size).toBeLessThan(50);
    expect(twoLines.style.size * (twoLines.style.lineHeight + 1.25)).toBeLessThanOrEqual(70.01);
  });

  it("fills every layer with the label and nothing else; the label and size survive saving", () => {
    const other: TextLayer = { ...layer, id: "other", field: "Place" };
    const copy: TextLayer = { ...layer, id: "copy" };
    const d = fillDetail({ ...doc, layers: [copy, layer, other] }, "Date", "FRI 9 JAN", measure);
    expect(d.layers.map((l) => (l as TextLayer).style.text)).toEqual(["FRI 9 JAN", "FRI 9 JAN", "SAT 14 DEC"]);
    const saved = sanitizeDocument(JSON.parse(JSON.stringify(d)));
    expect(saved.layers[0]).toMatchObject({ field: "Date", fieldSize: 50 });
    const junk = sanitizeDocument(JSON.parse(JSON.stringify({ ...doc, layers: [{ ...layer, field: 7, fieldSize: "big" }, { ...layer, field: "  " }] })));
    for (const l of junk.layers) {
      expect(l).not.toHaveProperty("field");
      expect(l).not.toHaveProperty("fieldSize");
    }
  });
});
