import type { Asset, ColorLabel, Collection, FileKind, SmartRule, SmartRules } from "./types";

export type LibrarySource =
  | { readonly kind: "all" }
  | { readonly kind: "recent" }
  | { readonly kind: "collection"; readonly id: string }
  | { readonly kind: "folder"; readonly path: string };

export type SortKey = "captureTime" | "importedAt" | "fileName" | "rating" | "byteSize" | "camera" | "edited";

export type LibraryFilter = {
  readonly text: string;
  readonly minRating: number;
  readonly ratingOp: ">=" | "=" | "<=";
  readonly flag: "all" | "pick" | "reject" | "unflagged" | "not-rejected";
  readonly labels: readonly Exclude<ColorLabel, null>[];
  readonly kinds: readonly FileKind[];
  readonly edited: "all" | "edited" | "unedited";
};

export const emptyFilter: LibraryFilter = {
  text: "",
  minRating: 0,
  ratingOp: ">=",
  flag: "all",
  labels: [],
  kinds: [],
  edited: "all",
};

export type LibraryQuery = {
  readonly source: LibrarySource;
  readonly filter: LibraryFilter;
  readonly sort: SortKey;
  readonly descending: boolean;
  readonly collapseStacks: boolean;
  readonly expandedStacks: readonly string[];
};

const cameraOf = (a: Asset) => [a.exif.make, a.exif.model].filter(Boolean).join(" ");

export const isEdited = (a: Asset) => a.develop !== undefined && a.developRevision > 0;

function matchesText(a: Asset, text: string) {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    a.fileName,
    a.folder,
    a.title,
    a.caption,
    cameraOf(a),
    a.exif.lens,
    ...a.keywords,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function matchesFilter(a: Asset, f: LibraryFilter): boolean {
  if (f.minRating > 0 || f.ratingOp !== ">=") {
    if (f.ratingOp === ">=" && a.rating < f.minRating) return false;
    if (f.ratingOp === "=" && a.rating !== f.minRating) return false;
    if (f.ratingOp === "<=" && a.rating > f.minRating) return false;
  }
  switch (f.flag) {
    case "pick":
      if (a.flag !== "pick") return false;
      break;
    case "reject":
      if (a.flag !== "reject") return false;
      break;
    case "unflagged":
      if (a.flag !== null) return false;
      break;
    case "not-rejected":
      if (a.flag === "reject") return false;
      break;
  }
  if (f.labels.length && (!a.label || !f.labels.includes(a.label))) return false;
  if (f.kinds.length && !f.kinds.includes(a.kind)) return false;
  if (f.edited === "edited" && !isEdited(a)) return false;
  if (f.edited === "unedited" && isEdited(a)) return false;
  return matchesText(a, f.text);
}

function compareNumber(value: number | undefined, op: string, target: number) {
  if (value === undefined) return false;
  if (op === ">=") return value >= target;
  if (op === "<=") return value <= target;
  return value === target;
}

export function matchesRule(a: Asset, rule: SmartRule): boolean {
  switch (rule.field) {
    case "rating":
      return compareNumber(a.rating, rule.op, rule.value);
    case "flag":
      return rule.value === "none" ? a.flag === null : a.flag === rule.value;
    case "label":
      return rule.value === "none" ? a.label === null : a.label === rule.value;
    case "kind":
      return a.kind === rule.value;
    case "keyword":
      return a.keywords.some((k) => k.toLowerCase().includes(rule.value.toLowerCase()));
    case "camera":
      return cameraOf(a).toLowerCase().includes(rule.value.toLowerCase());
    case "lens":
      return (a.exif.lens ?? "").toLowerCase().includes(rule.value.toLowerCase());
    case "fileName":
      return a.fileName.toLowerCase().includes(rule.value.toLowerCase());
    case "folder":
      return a.folder.toLowerCase().includes(rule.value.toLowerCase());
    case "iso":
      return compareNumber(a.exif.iso, rule.op, rule.value);
    case "focalLength":
      return compareNumber(a.exif.focalLength, rule.op, rule.value);
    case "fNumber":
      return compareNumber(a.exif.fNumber, rule.op, rule.value);
    case "captureTime":
      return compareNumber(a.captureTime, rule.op, rule.value);
    case "edited":
      return isEdited(a) === rule.value;
  }
}

export function matchesSmart(a: Asset, rules: SmartRules): boolean {
  if (!rules.rules.length) return true;
  return rules.match === "all" ? rules.rules.every((r) => matchesRule(a, r)) : rules.rules.some((r) => matchesRule(a, r));
}

const RECENT_WINDOW = 1000 * 60 * 60 * 24;

export function inSource(a: Asset, source: LibrarySource, collections: ReadonlyMap<string, Collection>, latestImport: number) {
  switch (source.kind) {
    case "all":
      return true;
    case "recent":
      return a.importedAt >= latestImport - RECENT_WINDOW;
    case "folder":
      return a.folder === source.path || a.folder.startsWith(`${source.path}/`);
    case "collection": {
      const c = collections.get(source.id);
      if (!c) return false;
      if (c.kind === "smart") return matchesSmart(a, c.rules ?? { match: "all", rules: [] });
      return a.collectionIds.includes(source.id);
    }
  }
}

function sortValue(a: Asset, key: SortKey): number | string {
  switch (key) {
    case "captureTime":
      return a.captureTime ?? a.fileModified;
    case "importedAt":
      return a.importedAt;
    case "fileName":
      return a.fileName.toLowerCase();
    case "rating":
      return a.rating;
    case "byteSize":
      return a.byteSize;
    case "camera":
      return cameraOf(a).toLowerCase();
    case "edited":
      return isEdited(a) ? 1 : 0;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareAssets(key: SortKey, descending: boolean) {
  const dir = descending ? -1 : 1;
  return (a: Asset, b: Asset) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    let c = typeof va === "string" ? collator.compare(va, vb as string) : va - (vb as number);
    // Stable, human tie-break: file name, then id.
    if (c === 0) c = collator.compare(a.fileName, b.fileName) || a.id.localeCompare(b.id);
    return c * dir;
  };
}

/**
 * Ranks of strings in collator order (strings the collator finds equal share a rank),
 * so a sort compares integers instead of calling the collator N log N times (80 ms for
 * 20,000 file names, several times that on a phone, on every catalog change).
 */
function collationRanks(values: Iterable<string>): Map<string, number> {
  const unique = [...new Set(values)].sort(collator.compare);
  const ranks = new Map<string, number>();
  let rank = 0;
  unique.forEach((v, i) => {
    if (i > 0 && collator.compare(unique[i - 1], v) !== 0) rank++;
    ranks.set(v, rank);
  });
  return ranks;
}

/** File-name ranks of the whole catalog, kept until a name appears that it lacks (ratings, flags and edits keep it). */
let nameRanks: Map<string, number> | null = null;

function fileNameRanks(all: readonly Asset[]): Map<string, number> {
  if (!nameRanks || all.some((a) => !nameRanks!.has(a.fileName))) nameRanks = collationRanks(all.map((a) => a.fileName));
  return nameRanks;
}

/** Sorts like `compareAssets`, with each value worked out once and strings compared by rank. */
export function sortAssets(list: Asset[], key: SortKey, descending: boolean, all: readonly Asset[] = list): Asset[] {
  const dir = descending ? -1 : 1;
  const names = fileNameRanks(all);
  const values = list.map((a) => sortValue(a, key));
  const strings = typeof values[0] === "string" ? (key === "fileName" ? null : collationRanks(values as string[])) : null;
  const rows = list.map((a, i) => {
    const name = names.get(a.fileName) ?? 0;
    const v = values[i];
    return { a, primary: typeof v === "number" ? v : key === "fileName" ? name : strings!.get(v)!, name };
  });
  rows.sort((x, y) => (x.primary - y.primary || x.name - y.name || x.a.id.localeCompare(y.a.id)) * dir);
  return rows.map((r) => r.a);
}

export type StackInfo = { readonly count: number; readonly expanded: boolean };

/**
 * Runs a library query. With collapsed stacks only each stack's top photo
 * (lowest stackIndex) is returned unless that stack is expanded.
 */
export function runQuery(
  assets: Iterable<Asset>,
  query: LibraryQuery,
  collections: ReadonlyMap<string, Collection>,
): { ids: string[]; stacks: Map<string, StackInfo> } {
  let latestImport = 0;
  const all: Asset[] = [];
  for (const a of assets) {
    all.push(a);
    if (a.importedAt > latestImport) latestImport = a.importedAt;
  }
  const matched = sortAssets(
    all.filter((a) => inSource(a, query.source, collections, latestImport) && matchesFilter(a, query.filter)),
    query.sort,
    query.descending,
    all,
  );
  const stacks = new Map<string, StackInfo>();
  if (!query.collapseStacks) return { ids: matched.map((a) => a.id), stacks };
  const counts = new Map<string, number>();
  const tops = new Map<string, Asset>();
  for (const a of matched) {
    if (!a.stackId) continue;
    counts.set(a.stackId, (counts.get(a.stackId) ?? 0) + 1);
    const top = tops.get(a.stackId);
    if (!top || (a.stackIndex ?? 0) < (top.stackIndex ?? 0)) tops.set(a.stackId, a);
  }
  for (const [id, count] of counts) stacks.set(id, { count, expanded: query.expandedStacks.includes(id) });
  const ids = matched
    .filter((a) => !a.stackId || stacks.get(a.stackId)?.expanded || tops.get(a.stackId) === a)
    .map((a) => a.id);
  return { ids, stacks };
}

/** Folder tree built from imported folder paths, for the Folders panel. */
export function folderTree(assets: Iterable<Asset>) {
  const counts = new Map<string, number>();
  for (const a of assets) {
    if (!a.folder) continue;
    const parts = a.folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count, depth: path.split("/").length - 1, name: path.split("/").pop() ?? path }))
    .sort((a, b) => collator.compare(a.path, b.path));
}
