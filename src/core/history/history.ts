/**
 * Undo history over immutable states. Because states share structure, each
 * step costs only the objects that changed — never a bitmap. A continuous
 * gesture (a slider drag, a brush stroke) opens a group with `begin()` and
 * becomes one labelled step on `commit()`; `cancel()` restores the start.
 */
export type HistoryEntry<T> = { readonly label: string; readonly state: T; readonly time: number };

export type HistoryStatus = {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly editing: boolean;
  /** Oldest first; the last entry is the current state. */
  readonly entries: readonly HistoryEntry<unknown>[];
  readonly index: number;
};

export type History<T> = ReturnType<typeof createHistory<T>>;

export function createHistory<T>(
  initial: T,
  options: { limit?: number; equal?: (a: T, b: T) => boolean; label?: string } = {},
) {
  const limit = options.limit ?? 200;
  const equal = options.equal ?? Object.is;
  let entries: HistoryEntry<T>[] = [{ label: options.label ?? "Open", state: initial, time: Date.now() }];
  let index = 0;
  let group: { start: T; label: string } | null = null;
  let current = initial;
  const listeners = new Set<() => void>();
  let status: HistoryStatus = computeStatus();

  function computeStatus(): HistoryStatus {
    return {
      canUndo: index > 0 || group !== null,
      canRedo: index < entries.length - 1,
      editing: group !== null,
      entries,
      index,
    };
  }
  function emit() {
    status = computeStatus();
    for (const l of listeners) l();
  }
  function push(label: string, state: T, merge = false) {
    entries = entries.slice(0, index + 1);
    const last = entries[entries.length - 1];
    const now = Date.now();
    // Quick repeats of the same control (arrow keys on a slider) become one step.
    if (merge && label !== "Edit" && index > 0 && last.label === label && now - last.time < 1000) {
      entries[entries.length - 1] = { label, state, time: now };
      return;
    }
    entries.push({ label, state, time: now });
    if (entries.length > limit) entries = entries.slice(entries.length - limit);
    index = entries.length - 1;
  }

  return {
    get: () => current,
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Sets the state; outside a group it records a step labelled `label`. */
    set(next: T, label = "Edit") {
      if (equal(current, next)) return;
      current = next;
      if (!group) push(label, next, true);
      else group.label = label;
      emit();
    },
    /** Opens a gesture group. Returns false when one is already open (nested callers). */
    begin(label = "Edit") {
      if (group) return false;
      group = { start: current, label };
      emit();
      return true;
    },
    commit() {
      if (!group) return;
      const { start, label } = group;
      group = null;
      if (!equal(start, current)) push(label, current);
      emit();
    },
    cancel() {
      if (!group) return;
      current = group.start;
      group = null;
      emit();
    },
    undo() {
      if (group) {
        this.commit();
      }
      if (index === 0) return;
      index--;
      current = entries[index].state;
      emit();
    },
    redo() {
      if (group || index >= entries.length - 1) return;
      index++;
      current = entries[index].state;
      emit();
    },
    /** Jumps to a history entry, as clicking in a History panel does. */
    goTo(target: number) {
      if (group) this.commit();
      if (target < 0 || target >= entries.length) return;
      index = target;
      current = entries[index].state;
      emit();
    },
    /** Replaces the whole history, e.g. when another photo is opened. */
    reset(state: T, label = "Open") {
      group = null;
      current = state;
      entries = [{ label, state, time: Date.now() }];
      index = 0;
      emit();
    },
  };
}
