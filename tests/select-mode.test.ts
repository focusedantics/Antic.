import { describe, expect, it } from "vitest";
import { isSelecting, type SelectScope, selectMode, startSelecting, stopSelecting, toggleSelected } from "@/app/select-mode";

function scope(id = "things"): SelectScope & { ids: string[] } {
  const s = {
    id,
    noun: ["thing", "things"] as const,
    ids: ["b"],
    all: () => ["a", "b", "c"],
    get: () => s.ids,
    set: (ids: string[]) => {
      s.ids = ids;
    },
    subscribe: () => () => {},
    actions: () => {},
  };
  return s;
}

describe("select mode", () => {
  it("starts from a held item, from nothing (Select), or keeps the selection", () => {
    const s = scope();
    startSelecting(s, "c");
    expect(s.ids).toEqual(["c"]);
    expect(isSelecting(s)).toBe(true);
    expect(isSelecting("other")).toBe(false);
    startSelecting(s, null);
    expect(s.ids).toEqual([]);
    s.ids = ["a"];
    startSelecting(s);
    expect(s.ids).toEqual(["a"]);
    stopSelecting();
    expect(selectMode.getState().scope).toBe(null);
    expect(s.ids).toEqual(["a"]); // leaving keeps what was picked
  });

  it("toggles one item and keeps the others", () => {
    const s = scope();
    s.ids = ["a", "b"];
    toggleSelected(s, "c");
    expect(s.ids).toEqual(["a", "b", "c"]);
    toggleSelected(s, "a");
    expect(s.ids).toEqual(["b", "c"]);
  });
});
