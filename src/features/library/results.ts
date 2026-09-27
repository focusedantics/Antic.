import { useMemo } from "react";
import { useStore } from "@/app/hooks";
import { ui } from "@/app/state";
import { runQuery } from "@/core/catalog/query";
import { catalog } from "@/core/catalog/store";

/** Ids of the photos matching the current Library query, in display order. */
export function useResults() {
  const assets = useStore(catalog, (s) => s.assets);
  const collections = useStore(catalog, (s) => s.collections);
  const query = useStore(ui, (s) => s.query);
  return useMemo(() => runQuery(assets.values(), query, collections), [assets, collections, query]);
}

let lastResults: string[] = [];
/** Latest results for non-React callers (keyboard navigation). */
export const currentOrder = () => lastResults;
export function rememberOrder(ids: string[]) {
  lastResults = ids;
}
