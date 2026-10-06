import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { exportBundle } from "@/core/design/bundle";
import { createDocument, pathLayer, textLayer } from "@/core/document/operations";
import { smartShape } from "@/core/document/shapes";
import { familyFromFile } from "@/core/text/custom-fonts";
import { extractPalette } from "@/features/color/extract";
import { readAse, readGpl, readHexList, readJson, writeAse, writeGpl, writeHexList, writeJson } from "@/features/color/formats";
import { documentColors } from "@/features/color/palettes";
import { hexToHsv, hexToRgb, hsvToHex, luminance, normalizeHex, rgbToHex } from "@/lib/hsv";

describe("colour maths", () => {
  it("round-trips hex, RGB and HSV", () => {
    for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#d9a441", "#123456", "#808080"]) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00ffff").h).toBeCloseTo(180);
    expect(normalizeHex("ABC")).toBe("#aabbcc");
    expect(normalizeHex("#12345g")).toBeNull();
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("#000000")).toBe(0);
  });
});

describe("palette files", () => {
  const p = { name: "Test", colors: ["#ff0000", "#00ff00", "#0000ff", "#d9a441"] };
  it("GIMP, JSON and hex lists round-trip", () => {
    expect(readGpl(writeGpl(p))).toEqual(p);
    expect(readJson(writeJson(p))).toEqual(p);
    expect(readHexList(writeHexList(p), "Test")).toEqual(p);
    expect(readJson('["#fff", {"hex": "000000"}, "nope"]', "X")).toEqual({ name: "X", colors: ["#ffffff", "#000000"] });
    expect(() => readGpl("GIMP Palette\nName: empty\n")).toThrow();
  });
  it("Adobe swatch exchange round-trips", () => {
    const back = readAse(writeAse(p));
    expect(back.name).toBe("Test");
    expect(back.colors).toEqual(p.colors);
    expect(() => readAse(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("palette from a photo", () => {
  it("finds the main colours, largest first", () => {
    const w = 60;
    const h = 40;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // Two thirds blue, one third orange, a little noise.
        const [r, g, b] = x < 40 ? [30, 80, 200] : [240, 140, 40];
        const n = ((x * 7 + y * 13) % 9) - 4;
        px.set([r + n, g + n, b + n, 255], i);
      }
    const palette = extractPalette(px, 4);
    expect(palette.length).toBeGreaterThanOrEqual(2);
    const [first, second] = palette.map(hexToRgb);
    expect(first.b).toBeGreaterThan(170);
    expect(second.r).toBeGreaterThan(210);
    // Same input, same answer.
    expect(extractPalette(px, 4)).toEqual(palette);
  });
});

describe("design colours and kits", () => {
  it("lists a design's colours, most used first", () => {
    const doc = createDocument(100, 100, "x", "#ffffff");
    const star = pathLayer(doc, smartShape("star"), { fill: "#e8343a", stroke: "#111111", strokeWidth: 2 });
    const text = textLayer(doc, { color: "#e8343a" });
    const colors = documentColors({ ...doc, layers: [star, { ...text, fx: { glow: { color: "#ffd34d", opacity: 1, blur: 4, spread: 0 } } }] });
    expect(colors[0]).toBe("#e8343a");
    expect(colors).toEqual(expect.arrayContaining(["#ffffff", "#111111", "#ffd34d"]));
  });

  it("names imported fonts from their files without clashes", () => {
    expect(familyFromFile("Lato-Bold_Italic.ttf", [])).toBe("Lato Bold Italic");
    expect(familyFromFile("Inter.otf", ["Inter"])).toBe("Inter 2");
    expect(familyFromFile("!!!.woff2", [])).toBe("My font");
  });

  it("packs assets and their files in a kit", async () => {
    const tip = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const kit = await exportBundle([
      { id: "a", kind: "palette", name: "P", folder: "Brand", createdAt: 1, updatedAt: 1, data: { colors: ["#ff0000"] } },
      { id: "b", kind: "brush", name: "B", folder: "", createdAt: 1, updatedAt: 1, data: { tip, spacing: 0.3 } },
    ]);
    const files = unzipSync(new Uint8Array(await kit.arrayBuffer()));
    const json = JSON.parse(strFromU8(files["kit.json"]));
    expect(json.format).toBe("focused-kit/1");
    expect(json.assets[0]).toEqual({ kind: "palette", name: "P", folder: "Brand", data: { colors: ["#ff0000"] } });
    expect(json.assets[1].data.tip).toEqual({ $file: "files/b/tip", type: "image/png" });
    expect([...files["files/b/tip"]]).toEqual([1, 2, 3]);
  });
});
