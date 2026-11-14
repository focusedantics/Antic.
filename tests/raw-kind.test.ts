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

  it("answers null for files that aren't TIFF-based", () => {
    expect(rawImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBeNull();
    expect(rawImageInfo(new Uint8Array(4))).toBeNull();
  });
});
