import exifr from "exifr";
import { describe, expect, it } from "vitest";
import { buildExif, insertExif } from "@/core/export/exif";

describe("EXIF writer", () => {
  it("writes metadata exifr can read back", async () => {
    const payload = buildExif(
      { make: "SONY", model: "ILME-FX30", lens: "E 18-135mm F3.5-5.6 OSS", iso: 800, exposureTime: 1 / 125, fNumber: 5, focalLength: 29, copyright: "© Me", artist: "Me" },
      { captureTime: Date.UTC(2023, 3, 29, 12, 0, 0), width: 6000, height: 4000 },
    );
    const jpeg = insertExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), payload);
    const tags = await exifr.parse(jpeg, { tiff: true, exif: true, translateValues: false, reviveValues: false });
    expect(tags.Make).toBe("SONY");
    expect(tags.Model).toBe("ILME-FX30");
    expect(tags.ISO).toBe(800);
    expect(tags.ExposureTime).toBeCloseTo(1 / 125, 6);
    expect(tags.FNumber).toBe(5);
    expect(tags.FocalLength).toBe(29);
    expect(tags.LensModel).toBe("E 18-135mm F3.5-5.6 OSS");
    expect(tags.Copyright).toBe("© Me");
    expect(tags.Orientation).toBe(1);
    expect(tags.ExifImageWidth).toBe(6000);
  });
});
