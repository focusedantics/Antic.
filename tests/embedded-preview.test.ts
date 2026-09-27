import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findEmbeddedJpegs, largestEmbeddedJpeg } from "@/core/image/embedded-preview";

describe("embedded preview extraction", () => {
  it("finds the JPEG preview inside a DNG", () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/lossy.dng", import.meta.url)));
    const found = findEmbeddedJpegs(bytes);
    expect(found.length).toBeGreaterThan(0);
    const best = largestEmbeddedJpeg(bytes)!;
    expect(best.width).toBe(256);
    expect(best.height).toBe(168);
    expect(bytes[best.offset]).toBe(0xff);
    expect(bytes[best.offset + 1]).toBe(0xd8);
    expect(bytes[best.offset + best.length - 2]).toBe(0xff);
    expect(bytes[best.offset + best.length - 1]).toBe(0xd9);
  });

  it("ignores data without JPEG streams", () => {
    expect(findEmbeddedJpegs(new Uint8Array(4096).fill(0xff))).toEqual([]);
  });
});
