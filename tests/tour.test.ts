import { describe, expect, it } from "vitest";
import { sanitizePrefs } from "@/app/prefs";
import { approach, LOOKS, mixLook } from "@/features/backdrop/looks";
import { CHAPTERS, chapterStart, nextChapterStart, parseBody, STEPS } from "@/features/tour/steps";

describe("tour steps", () => {
  it("covers every chapter in order, starting with the welcome card", () => {
    expect(STEPS[0].chapter).toBe(0);
    const chapters = STEPS.map((s) => s.chapter);
    expect(chapters).toEqual([...chapters].sort((a, b) => a - b));
    expect(new Set(chapters).size).toBe(CHAPTERS.length);
  });

  it("skips to the next chapter and past the end", () => {
    const develop = chapterStart(2);
    expect(STEPS[develop].chapter).toBe(2);
    expect(STEPS[develop - 1].chapter).toBe(1);
    expect(nextChapterStart(chapterStart(1))).toBe(develop);
    expect(nextChapterStart(chapterStart(1) + 1)).toBe(develop);
    expect(nextChapterStart(STEPS.length - 1)).toBe(STEPS.length);
  });

  it("renders [[key]] markup as key caps, including bracket keys", () => {
    expect(parseBody("Press [[D]] now")).toEqual([
      { text: "Press ", key: false },
      { text: "D", key: true },
      { text: " now", key: false },
    ]);
    expect(parseBody("[[[]] [[]]]").filter((p) => p.key).map((p) => p.text)).toEqual(["[", "]"]);
    for (const s of STEPS) expect(parseBody(s.body).map((p) => p.text).join("")).not.toMatch(/\[\[|\]\]\]/);
  });
});

describe("glow looks", () => {
  it("has a distinct look per workspace", () => {
    const colours = Object.values(LOOKS).map((l) => l.color1.join());
    expect(new Set(colours).size).toBe(4);
    // Develop stays dim so the surround does not skew colour judgement.
    expect(LOOKS.develop.intensity).toBeLessThan(LOOKS.library.intensity);
  });

  it("blends smoothly and turns the short way round", () => {
    const { library, composite } = LOOKS;
    expect(mixLook(library, composite, 0)).toEqual(library);
    const end = mixLook(library, composite, 1);
    expect(end.color1.map((v, i) => v - composite.color1[i]).every((d) => Math.abs(d) < 1e-9)).toBe(true);
    // -180° → 150° is 30° the short way.
    expect(mixLook(library, composite, 0.5).angle).toBeCloseTo(-195);
    // Frame-rate independent: two half steps equal one whole step.
    const once = approach(library, composite, 0.2);
    const twice = approach(approach(library, composite, 0.1), composite, 0.1);
    expect(twice.size).toBeCloseTo(once.size, 9);
    expect(approach(library, composite, 0).size).toBe(library.size);
  });
});

describe("prefs", () => {
  it("falls back to defaults for anything that is not a boolean", () => {
    expect(sanitizePrefs(null)).toEqual({ backdrop: true, tourDone: false });
    expect(sanitizePrefs({ backdrop: false, tourDone: "yes" })).toEqual({ backdrop: false, tourDone: false });
  });
});

describe("motion holds", () => {
  it("holds until every hold is released, and a release counts once", async () => {
    const { holdMotion, motion } = await import("@/lib/motion");
    const a = holdMotion();
    const b = holdMotion();
    expect(motion.getState().holds).toBe(2);
    a();
    a();
    expect(motion.getState().holds).toBe(1);
    b();
    expect(motion.getState().holds).toBe(0);
  });
});
