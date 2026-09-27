import { describe, expect, it } from "vitest";
import { createHistory } from "@/core/history/history";

describe("history", () => {
  it("records, undoes and redoes", () => {
    const h = createHistory(0);
    h.set(1, "one");
    h.set(2, "two");
    expect(h.get()).toBe(2);
    h.undo();
    expect(h.get()).toBe(1);
    h.undo();
    expect(h.get()).toBe(0);
    h.undo();
    expect(h.get()).toBe(0);
    h.redo();
    expect(h.get()).toBe(1);
    h.set(5, "five");
    expect(h.status().canRedo).toBe(false);
  });

  it("groups a gesture into one step and can cancel it", () => {
    const h = createHistory(0);
    h.begin("drag");
    h.set(1);
    h.set(2);
    h.set(3, "Exposure");
    h.commit();
    expect(h.status().entries.length).toBe(2);
    expect(h.status().entries[1].label).toBe("Exposure");
    h.begin();
    h.set(9);
    h.cancel();
    expect(h.get()).toBe(3);
    h.undo();
    expect(h.get()).toBe(0);
  });

  it("drops no-op groups and jumps to entries", () => {
    const h = createHistory("a");
    h.begin();
    h.commit();
    expect(h.status().entries.length).toBe(1);
    h.set("b");
    h.set("c");
    h.goTo(0);
    expect(h.get()).toBe("a");
    h.goTo(2);
    expect(h.get()).toBe("c");
  });
});

describe("history merging", () => {
  it("merges rapid repeats of the same control", () => {
    const h = createHistory(0);
    h.set(1, "Exposure");
    h.set(2, "Exposure");
    h.set(3, "Contrast");
    expect(h.status().entries.map((e) => e.label)).toEqual(["Open", "Exposure", "Contrast"]);
    h.undo();
    expect(h.get()).toBe(2);
  });
});
