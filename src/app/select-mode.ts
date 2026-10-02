import { createStore } from "zustand/vanilla";

/**
 * Batch selection on touch screens, like the Photos app: a list enters select mode
 * (a press held on an item, or its Select button), taps then toggle items, a sideways
 * swipe sweeps across several, and a bar replaces the dock with the count, All/None,
 * the batch actions (the same menu a computer's right-click sweep opens) and Done.
 *
 * A scope describes one kind of selectable thing. Its selection lives where it always
 * does (the Library's `ui.selection`, the document's layer selection…); select mode
 * only changes how touches edit it.
 */
export type SelectScope = {
  readonly id: string;
  /** "photo", "photos" */
  readonly noun: readonly [one: string, many: string];
  /** Every item in view, in order (Select All). */
  readonly all: () => readonly string[];
  readonly get: () => readonly string[];
  readonly set: (ids: string[]) => void;
  /** Calls back when the selection may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Opens the batch actions for the selection at a screen point. */
  readonly actions: (x: number, y: number) => void;
};

export const selectMode = createStore<{ scope: SelectScope | null }>(() => ({ scope: null }));

/**
 * Enters select mode for `scope`: from one item (a held press), from nothing (`null`:
 * the Select button, as in Photos), or keeping the current selection (no argument).
 */
export function startSelecting(scope: SelectScope, first?: string | null) {
  if (first !== undefined) scope.set(first === null ? [] : [first]);
  selectMode.setState({ scope });
}

export const stopSelecting = () => selectMode.setState({ scope: null });

export const isSelecting = (scope: SelectScope | string) => selectMode.getState().scope?.id === (typeof scope === "string" ? scope : scope.id);

/** Adds or removes one item, keeping the others. */
export function toggleSelected(scope: SelectScope, id: string) {
  const ids = scope.get();
  scope.set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
}
