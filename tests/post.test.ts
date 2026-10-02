import { describe, expect, it } from "vitest";
import { asciiCharset, CHARSETS } from "@/core/effects/library/type";
import { postActive, POST_PARAMS } from "@/core/effects/post";
import { EFFECTS, effectById, newEffect, sanitizeEffect } from "@/core/effects/registry";
import { paramVisible } from "@/core/effects/types";

describe("post-processing on every effect", () => {
  it("adds bloom and grain controls to every effect, in their own section", () => {
    for (const def of EFFECTS) {
      for (const p of POST_PARAMS) expect(def.params.some((q) => q.key === p.key && q.group === "Post-processing")).toBe(true);
      const keys = def.params.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("leaves documents saved before it exactly as they were (both off)", () => {
    const old = sanitizeEffect({ id: "ascii", params: { cell: 10, charset: "hex" } })!;
    expect(old.params.post_bloom).toBe(false);
    expect(old.params.post_grain).toBe(false);
    expect(old.params.charset).toBe("hex");
    expect(postActive(old.params)).toBe(false);
  });

  it("starts new ASCII layers with glow and grain; other effects start without", () => {
    expect(postActive(newEffect("ascii")!.params)).toBe(true);
    expect(postActive(newEffect("halftone-cmyk")!.params)).toBe(false);
    expect(postActive({ post_grain: true, post_grainAmount: 0 })).toBe(false);
  });

  it("shows bloom and grain settings only while switched on", () => {
    const def = effectById("ascii")!;
    const radius = def.params.find((p) => p.key === "post_radius")!;
    expect(paramVisible(radius, { post_bloom: false }, def.params)).toBe(false);
    expect(paramVisible(radius, { post_bloom: true }, def.params)).toBe(true);
    const chars = def.params.find((p) => p.key === "chars")!;
    expect(paramVisible(chars, { charset: "standard" }, def.params)).toBe(false);
    expect(paramVisible(chars, { charset: "custom" }, def.params)).toBe(true);
  });
});

describe("ASCII character sets", () => {
  it("keeps the original sets and offers the new ones", () => {
    const select = effectById("ascii")!.params.find((p) => p.key === "charset")!;
    if (select.type !== "select") throw new Error("charset is a select");
    const values = select.options.map((o) => o.value);
    for (const v of ["standard", "simple", "binary", "hex", "dots", "blocks", "detailed", "alphabetic", "numeric", "math", "symbols", "custom"]) expect(values).toContain(v);
    // Unchanged from the original ramp, so saved ASCII layers draw the same characters.
    expect(CHARSETS.standard).toBe(" .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$");
  });

  it("builds custom sets with a blank, without duplicates, and falls back when empty", () => {
    expect(asciiCharset("custom", "@@##")).toBe(" @#");
    expect(asciiCharset("custom", " xo")).toBe(" xo");
    expect(asciiCharset("custom", "")).toBe(CHARSETS.standard);
    expect(asciiCharset("nonsense", "")).toBe(CHARSETS.standard);
    expect(asciiCharset("blocks", "")).toBe(CHARSETS.blocks);
  });
});

describe("liquid glass and metal", () => {
  it("are registered, in Light & glass, with post-processing and sensible starting values", () => {
    for (const id of ["liquid-glass", "glass-blobs", "liquid-metal"]) {
      const def = effectById(id)!;
      expect(def.category).toBe("Light & glass");
      expect(def.params.some((p) => p.key === "post_bloom")).toBe(true);
    }
    expect(effectById("glass-blobs")!.animated).toBe(true);
    expect(effectById("liquid-metal")!.animated).toBe(true);
    expect(effectById("liquid-glass")!.animated).toBeFalsy();
    expect(newEffect("liquid-metal")!.params.post_bloom).toBe(true);
  });

  it("shows the metal threshold for bright or dark pours, and the custom color only for Custom", () => {
    const def = effectById("liquid-metal")!;
    const threshold = def.params.find((p) => p.key === "threshold")!;
    expect(paramVisible(threshold, { shape: "all" }, def.params)).toBe(false);
    expect(paramVisible(threshold, { shape: "dark" }, def.params)).toBe(true);
    expect(paramVisible(threshold, {}, def.params)).toBe(false);
    const color = def.params.find((p) => p.key === "color")!;
    expect(paramVisible(color, { metal: "gold" }, def.params)).toBe(false);
    expect(paramVisible(color, { metal: "custom" }, def.params)).toBe(true);
  });
});
