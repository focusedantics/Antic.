import { describe, expect, it } from "vitest";
import { parseClip } from "@/core/develop/clipboard";
import { basicRanges } from "@/core/develop/params";

describe("copied edits read back from storage", () => {
  it("keeps known groups and sanitizes their values", () => {
    const clip = parseClip({ groups: ["basic", "bogus", 7], values: { basic: { exposure: 99, contrast: "lots" } }, raw: false, from: "IMG_1.JPG" })!;
    expect(clip.groups).toEqual(["basic"]);
    expect(clip.values.basic!.exposure).toBe(basicRanges.exposure.max);
    expect(clip.values.basic!.contrast).toBe(0);
    expect(clip.from).toBe("IMG_1.JPG");
    expect(clip.raw).toBe(false);
  });

  it("rejects junk", () => {
    expect(parseClip(null)).toBeNull();
    expect(parseClip("edits")).toBeNull();
    expect(parseClip({ groups: [], values: {} })).toBeNull();
    expect(parseClip({ groups: ["nope"], values: {} })).toBeNull();
    expect(parseClip({ groups: ["basic"] })).toBeNull();
  });
});
