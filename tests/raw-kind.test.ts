import { describe, expect, it } from "vitest";
import { rawImageInfo } from "@/core/image/raw-kind";
import { testDng } from "./fixtures/dng";

describe("telling linear RAWs (ProRAW) from sensor RAWs", () => {
  it("reads the main image's size and kind from the tags alone", () => {
    expect(rawImageInfo(new Uint8Array(testDng(40, 20)))).toEqual({ linear: false, width: 40, height: 20 });
    expect(rawImageInfo(new Uint8Array(testDng(40, 20, { linear: true })))).toEqual({ linear: true, width: 40, height: 20 });
    // A 48-megapixel ProRAW's tags, without its pixels.
    expect(rawImageInfo(new Uint8Array(testDng(8064, 6048, { linear: true, pixels: false })))).toEqual({ linear: true, width: 8064, height: 6048 });
  });

  it("reads it from the start of the file alone", () => {
    const dng = new Uint8Array(testDng(2000, 1500, { linear: true }));
    expect(rawImageInfo(dng.subarray(0, 4096))).toEqual({ linear: true, width: 2000, height: 1500 });
  });

  it("goes by the full-resolution image, not a preview of the same size", () => {
    expect(rawImageInfo(new Uint8Array(testDng(4032, 3024, { linear: true, pixels: false, previewIfd: true })))).toEqual({ linear: true, width: 4032, height: 3024 });
  });

  it("answers null for files that aren't TIFF-based", () => {
    expect(rawImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBeNull();
    expect(rawImageInfo(new Uint8Array(4))).toBeNull();
  });
});
