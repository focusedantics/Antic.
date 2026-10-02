import { describe, expect, it } from "vitest";
import { boxFrom, mergeCaught, touches } from "@/components/sweep";

describe("sweep selection", () => {
  it("normalizes a box dragged in any direction", () => {
    expect(boxFrom(50, 40, 10, 90)).toEqual({ left: 10, top: 40, right: 50, bottom: 90 });
  });

  it("catches items the box touches, edges included", () => {
    const box = boxFrom(0, 0, 10, 10);
    expect(touches(box, { left: 10, top: 10, right: 20, bottom: 20 })).toBe(true);
    expect(touches(box, { left: 11, top: 0, right: 20, bottom: 5 })).toBe(false);
  });

  it("keeps the state of items it could not evaluate (scrolled out of a virtual list)", () => {
    let caught = mergeCaught(new Set(), [["a", true], ["b", true]]);
    // "a" scrolled away (not rendered, not evaluated); "b" left the box; "c" entered.
    caught = mergeCaught(caught, [["b", false], ["c", true]]);
    expect([...caught].sort()).toEqual(["a", "c"]);
  });
});
