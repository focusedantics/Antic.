import { describe, expect, it } from "vitest";
import { emptyFilter, type LibraryQuery, matchesSmart, runQuery } from "@/core/catalog/query";
import type { Asset } from "@/core/catalog/types";

let n = 0;
const asset = (patch: Partial<Asset>): Asset => ({
  id: `a${n++}`,
  fileName: "IMG.JPG",
  kind: "jpeg",
  mime: "image/jpeg",
  byteSize: 1,
  fileModified: 0,
  importedAt: 1000,
  folder: "",
  original: { kind: "stored" },
  fingerprint: String(n),
  exif: {},
  rating: 0,
  flag: null,
  label: null,
  keywords: [],
  collectionIds: [],
  developRevision: 0,
  thumbRevision: -1,
  thumbState: "ready",
  ...patch,
});

const query = (patch: Partial<LibraryQuery> = {}): LibraryQuery => ({
  source: { kind: "all" },
  filter: emptyFilter,
  sort: "fileName",
  descending: false,
  collapseStacks: true,
  expandedStacks: [],
  ...patch,
});

describe("library query", () => {
  const photos = [
    asset({ id: "raw", fileName: "DSC0002.ARW", kind: "raw", rating: 4, flag: "pick", keywords: ["Portrait", "Studio"], exif: { make: "SONY", model: "ILCE-7M4", iso: 100 } }),
    asset({ id: "jpg", fileName: "DSC0010.JPG", rating: 2, flag: "reject", label: "red", exif: { make: "Canon", iso: 3200 } }),
    asset({ id: "png", fileName: "dsc0001.png", kind: "png", keywords: ["studio"] }),
  ];

  it("sorts file names naturally and case-insensitively", () => {
    expect(runQuery(photos, query(), new Map()).ids).toEqual(["png", "raw", "jpg"]);
  });

  it("filters by rating, flag, label, kind and text", () => {
    const f = (patch: Partial<typeof emptyFilter>) => runQuery(photos, query({ filter: { ...emptyFilter, ...patch } }), new Map()).ids;
    expect(f({ minRating: 3 })).toEqual(["raw"]);
    expect(f({ flag: "not-rejected" })).toEqual(["png", "raw"]);
    expect(f({ labels: ["red"] })).toEqual(["jpg"]);
    expect(f({ kinds: ["raw"] })).toEqual(["raw"]);
    expect(f({ text: "studio" })).toEqual(["png", "raw"]);
    expect(f({ text: "sony portrait" })).toEqual(["raw"]);
  });

  it("evaluates smart collection rules", () => {
    const rules = { match: "all" as const, rules: [{ field: "iso" as const, op: ">=" as const, value: 1600 }] };
    expect(photos.filter((p) => matchesSmart(p, rules)).map((p) => p.id)).toEqual(["jpg"]);
    const any = { match: "any" as const, rules: [{ field: "flag" as const, op: "=" as const, value: "pick" as const }, { field: "kind" as const, op: "=" as const, value: "png" as const }] };
    expect(photos.filter((p) => matchesSmart(p, any)).map((p) => p.id)).toEqual(["raw", "png"]);
  });

  it("collapses stacks to their top photo unless expanded", () => {
    const stacked = [
      asset({ id: "s1", fileName: "a1.jpg", stackId: "S", stackIndex: 1 }),
      asset({ id: "s0", fileName: "a2.jpg", stackId: "S", stackIndex: 0 }),
      asset({ id: "x", fileName: "b.jpg" }),
    ];
    const collapsed = runQuery(stacked, query(), new Map());
    expect(collapsed.ids).toEqual(["s0", "x"]);
    expect(collapsed.stacks.get("S")?.count).toBe(2);
    expect(runQuery(stacked, query({ expandedStacks: ["S"] }), new Map()).ids).toEqual(["s1", "s0", "x"]);
  });
});
