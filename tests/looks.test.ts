import { describe, expect, it } from "vitest";
import { createDefaultRecipe } from "@/core/develop/defaults";
import { createDocument, effectLayer, imageLayer, insertLayer, textLayer } from "@/core/document/operations";
import { uniqueName } from "@/core/export/destination";
import { authUrl } from "@/core/export/drive";
import { drawWatermark, sanitizeWatermark } from "@/core/export/watermark";
import { describeLook, fitLayers, lookFromRecipe, lookLayers, newLook, readLookFile, lookToFile, sanitizeLook } from "@/core/looks/look";

function sampleDoc() {
  let doc = createDocument(4000, 3000, "Source");
  doc = insertLayer(doc, imageLayer(doc, "asset-1", "Photo", 4000, 3000, true));
  doc = insertLayer(doc, effectLayer(doc, "vhs")!);
  doc = insertLayer(doc, textLayer(doc, { text: "Hello", size: 300 }));
  return doc;
}

describe("looks", () => {
  it("keeps everything but the photos from a composition", () => {
    const layers = lookLayers(sampleDoc())!;
    expect(layers.items.map((l) => l.kind)).toEqual(["effect", "text"]);
    expect(layers.width).toBe(4000);
  });

  it("fits layers to another canvas: canvas-wide layers cover it, text scales uniformly", () => {
    const look = lookLayers(sampleDoc())!;
    const [fx, text] = fitLayers(look, 2000, 3000);
    expect(fx.transform).toMatchObject({ x: 1000, y: 1500, width: 2000, height: 3000 });
    expect(text.kind === "text" && text.style.size).toBe(150);
    expect(text.transform.x).toBe(1000);
    expect(fx.id).not.toBe(look.items[0].id);
  });

  it("captures develop groups including masks, and describes itself", () => {
    const recipe = { ...createDefaultRecipe({ raw: false }), masks: [] };
    const look = newLook("Warm", { develop: lookFromRecipe(recipe, ["basic", "masks", "geometry"], false), layers: lookLayers(sampleDoc()), video: null });
    expect(look.develop?.groups).toEqual(["basic", "masks", "geometry"]);
    expect(describeLook(look).join(" ")).toContain("2 layers (1 effect)");
  });

  it("sanitizes untrusted looks", () => {
    const l = sanitizeLook({ name: 42, develop: { groups: ["basic", "evil"], values: { basic: {}, evil: 1 } }, video: { effect: { id: "ascii", params: { cell: 9999 } }, effectMix: 5 }, layers: { width: 100, height: 100, items: [{ kind: "image", assetId: "x" }] } });
    expect(l.name).toBe("Untitled look");
    expect(l.develop?.groups).toEqual(["basic"]);
    expect(l.video?.effect.params.cell).toBe(60);
    expect(l.video?.effectMix).toBe(1);
    expect(l.layers).toBeNull();
  });

  it("round-trips through a .focused file", async () => {
    const look = newLook("Round trip", { develop: null, layers: lookLayers(sampleDoc()), video: { effect: { id: "glitch", params: {} }, effectMix: 0.5 } });
    const back = await readLookFile(await lookToFile(look));
    expect(back?.name).toBe("Round trip");
    expect(back?.layers?.items).toHaveLength(2);
    expect(back?.video?.effectMix).toBe(0.5);
    expect(back?.id).not.toBe(look.id);
  });
});

describe("export helpers", () => {
  it("never reuses a file name within one export", () => {
    const used = new Set<string>();
    expect(uniqueName("a.jpg", used)).toBe("a.jpg");
    expect(uniqueName("A.jpg", used)).toBe("A (2).jpg");
    expect(uniqueName("a.jpg", used)).toBe("a (3).jpg");
  });

  it("builds a Drive sign-in URL with the narrow file scope", () => {
    const url = new URL(authUrl("client-1", "https://example.app/oauth-callback.html", "s1"));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(url.searchParams.get("state")).toBe("s1");
  });

  it("sanitizes watermark settings and places text by position", () => {
    const w = sanitizeWatermark({ enabled: true, text: "© Me", size: 99, opacity: -1, position: "bottom-right", margin: 5, font: "nope" });
    expect(w).toMatchObject({ size: 30, opacity: 0, font: "sans" });
    const calls: { text: string; x: number; y: number; align: string; baseline: string }[] = [];
    const ctx = {
      textAlign: "",
      textBaseline: "",
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      measureText: () => ({ width: 100 }),
      fillText(this: { textAlign: string; textBaseline: string }, text: string, x: number, y: number) {
        calls.push({ text, x, y, align: this.textAlign, baseline: this.textBaseline });
      },
    } as unknown as CanvasRenderingContext2D & { textAlign: string; textBaseline: string };
    drawWatermark(ctx, 2000, 1000, { ...w, opacity: 0.5 });
    expect(calls).toEqual([{ text: "© Me", x: 1950, y: 950, align: "right", baseline: "bottom" }]);
    calls.length = 0;
    drawWatermark(ctx, 2000, 1000, { ...w, opacity: 0.5, position: "tile" });
    expect(calls.length).toBeGreaterThan(10);
  });
});
