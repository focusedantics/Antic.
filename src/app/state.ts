import { createStore } from "zustand/vanilla";
import { emptyFilter, type LibraryQuery } from "@/core/catalog/query";
import type { AssetId } from "@/core/catalog/types";

export type Workspace = "library" | "develop" | "composite" | "design" | "video";
export type LibraryView = "grid" | "loupe" | "compare" | "survey";

export type UiState = {
  readonly workspace: Workspace;
  readonly libraryView: LibraryView;
  readonly query: LibraryQuery;
  /** The photo shown in Loupe/Develop and highlighted in the filmstrip. */
  readonly activeId: AssetId | null;
  readonly selection: ReadonlySet<AssetId>;
  /** Second photo in Compare view. */
  readonly compareId: AssetId | null;
  readonly thumbSize: number;
  readonly toast: { readonly id: number; readonly text: string; readonly kind: "info" | "error"; readonly action?: ToastAction } | null;
};

export const ui = createStore<UiState>(() => ({
  workspace: "library",
  libraryView: "grid",
  query: {
    source: { kind: "all" },
    filter: emptyFilter,
    sort: "captureTime",
    descending: false,
    collapseStacks: true,
    expandedStacks: [],
  },
  activeId: null,
  selection: new Set(),
  compareId: null,
  thumbSize: 180,
  toast: null,
}));

let toastId = 0;
/** A button in a toast (it stays up longer, and goes once pressed). */
export type ToastAction = { readonly label: string; readonly run: () => void };

export function toast(text: string, kind: "info" | "error" = "info", action?: ToastAction) {
  const id = ++toastId;
  ui.setState({ toast: { id, text, kind, ...(action ? { action } : {}) } });
  setTimeout(
    () => {
      if (ui.getState().toast?.id === id) ui.setState({ toast: null });
    },
    action ? 60_000 : kind === "error" ? 6000 : 2800,
  );
}

export const setWorkspace = (workspace: Workspace) => ui.setState({ workspace });

export function setQuery(patch: Partial<LibraryQuery>) {
  ui.setState((s) => ({ query: { ...s.query, ...patch } }));
}

export function setFilter(patch: Partial<LibraryQuery["filter"]>) {
  ui.setState((s) => ({ query: { ...s.query, filter: { ...s.query.filter, ...patch } } }));
}

/** Makes `id` active; plain clicks also make it the whole selection. */
export function selectAsset(id: AssetId, mode: "replace" | "toggle" | "range" = "replace", order?: readonly AssetId[]) {
  ui.setState((s) => {
    if (mode === "toggle") {
      const selection = new Set(s.selection);
      if (selection.has(id) && selection.size > 1) selection.delete(id);
      else selection.add(id);
      return { selection, activeId: id };
    }
    if (mode === "range" && order && s.activeId) {
      const a = order.indexOf(s.activeId);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return { selection: new Set(order.slice(lo, hi + 1)), activeId: id };
      }
    }
    return { selection: new Set([id]), activeId: id };
  });
}

/** Selection the metadata commands act on: the selection, or the active photo alone. */
export function targetIds(): AssetId[] {
  const { selection, activeId } = ui.getState();
  if (selection.size) return [...selection];
  return activeId ? [activeId] : [];
}
