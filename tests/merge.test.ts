import { describe, expect, it } from "vitest";
import { mergeChanged, mergePatch } from "@/lib/merge";

describe("edits shown for one layer, applied to several", () => {
  it("takes only the changed fields onto each layer's own object", () => {
    const shown = { color: "#000000", opacity: 0.5, blur: 20 };
    const own = { color: "#ff0000", opacity: 0.9, blur: 4 };
    expect(mergeChanged(shown, { ...shown, blur: 40 }, own)).toEqual({ color: "#ff0000", opacity: 0.9, blur: 40 });
    // The shown layer itself ends up exactly as edited.
    expect(mergeChanged(shown, { ...shown, blur: 40 }, shown)).toEqual({ ...shown, blur: 40 });
    // A field the edit removed goes from the others too.
    const { blur: _gone, ...rest } = shown;
    expect(mergeChanged(shown, rest, own)).toEqual({ color: "#ff0000", opacity: 0.9 });
  });

  it("merges a style patch: plain values set, objects merged, turned on or off", () => {
    type S = { size: number; color: string; highlight?: { color: string; padding: number } };
    const shown: S = { size: 40, color: "#111111", highlight: { color: "#ffff00", padding: 0.2 } };
    const withOwn: S = { size: 90, color: "#222222", highlight: { color: "#00ffff", padding: 0.5 } };
    const without: S = { size: 90, color: "#222222" };
    // Plain values go to everyone.
    expect(mergePatch(shown, { color: "#ff0000" }, without)).toEqual({ size: 90, color: "#ff0000" });
    // A tweak of an object changes only that field where the layer has one, and adds none.
    expect(mergePatch(shown, { highlight: { color: "#ffff00", padding: 0.3 } }, withOwn).highlight).toEqual({ color: "#00ffff", padding: 0.3 });
    expect(mergePatch(shown, { highlight: { color: "#ffff00", padding: 0.3 } }, without).highlight).toBeUndefined();
    // Turning it on (the shown layer had none) keeps a layer's own, or gives the new one.
    const off: S = { size: 40, color: "#111111" };
    expect(mergePatch(off, { highlight: { color: "#ffffff", padding: 0.1 } }, withOwn).highlight).toEqual(withOwn.highlight);
    expect(mergePatch(off, { highlight: { color: "#ffffff", padding: 0.1 } }, without).highlight).toEqual({ color: "#ffffff", padding: 0.1 });
    // Turning it off reaches everyone.
    expect(mergePatch(shown, { highlight: undefined }, withOwn).highlight).toBeUndefined();
  });
});
