import { useDeferredValue, useMemo } from "react";
import { useStore } from "@/app/hooks";
import { ui } from "@/app/state";
import { runQuery } from "@/core/catalog/query";
import { catalog } from "@/core/catalog/store";

/**
 * Ids of the photos matching the current Library query, in display order. Catalog
 * changes arrive in bursts (an import updates each photo as it is analysed): the query
 * runs on a deferred copy, so React can skip intermediate results while it is busy.
 * Query changes (sorting, filtering) apply at once.
 */
export function useResults() {
  const assets = useDeferredValue(useStore(catalog, (s) => s.assets));
  const collections = useStore(catalog, (s) => s.collections);
  const query = useStore(ui, (s) => s.query);
  return useMemo(() => sharedQuery(assets, query, collections), [assets, collections, query]);
}

/**
 * The grid, the filmstrip and Develop's view each ask for the same results: the query
 * (a filter and a sort of every photo) runs once for them all.
 */
type Query = ReturnType<typeof ui.getState>["query"];
type Catalog = ReturnType<typeof catalog.getState>;
let shared: { assets: Catalog["assets"]; query: Query; collections: Catalog["collections"]; results: ReturnType<typeof runQuery> } | null = null;
function sharedQuery(assets: Catalog["assets"], query: Query, collections: Catalog["collections"]) {
  if (shared?.assets !== assets || shared.query !== query || shared.collections !== collections) shared = { assets, query, collections, results: runQuery(assets.values(), query, collections) };
  return shared.results;
}

let lastResults: string[] = [];
/** Latest results for non-React callers (keyboard navigation). */
export const currentOrder = () => lastResults;
export function rememberOrder(ids: string[]) {
  lastResults = ids;
}
