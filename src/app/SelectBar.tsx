import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "@/components/icons";
import { useStore } from "./hooks";
import { layout } from "./layout";
import { isSelecting, type SelectScope, selectMode, startSelecting, stopSelecting } from "./select-mode";

/**
 * A list's Select button (phones only; computers select with clicks and the right-click
 * sweep). `icon` makes it a round top-bar button, filled while selecting.
 */
export function SelectButton({ scope, className = "btn small", icon = false }: { scope: SelectScope; className?: string; icon?: boolean }) {
  const compact = useStore(layout, (s) => s.compact);
  const on = useStore(selectMode, (s) => s.scope?.id === scope.id);
  if (!compact) return null;
  const toggle = () => (isSelecting(scope) ? stopSelecting() : startSelecting(scope, null));
  if (icon)
    return (
      <button type="button" className="top-action select-toggle" aria-label="Select" title={on ? "Done selecting" : `Select ${scope.noun[1]}`} aria-pressed={on} onClick={toggle}>
        <Icon name="select" size={22} />
      </button>
    );
  return (
    <button type="button" className={className} aria-pressed={on} onClick={toggle}>
      {on ? "Done" : "Select"}
    </button>
  );
}

/**
 * Takes the dock's place while a phone is in select mode: Done, how many are
 * selected, All/None, and the batch actions (the menu a computer's sweep opens).
 */
export function SelectBar({ scope }: { scope: SelectScope }) {
  const count = useSyncExternalStore(scope.subscribe, () => scope.get().length);
  const total = scope.all().length;
  const all = total > 0 && count >= total;
  const [one, many] = scope.noun;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes an open menu or dialog first; with neither, it leaves select mode.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="menu"], [role="dialog"]')) stopSelecting();
    };
    // Capture: run before an open menu's own Escape handler closes (and unmounts) it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <nav className="select-bar" aria-label="Selection">
      <button type="button" className="select-bar-btn" onClick={stopSelecting}>
        Done
      </button>
      <span className="select-count" aria-live="polite">
        {count ? `${count} ${count === 1 ? one : many} selected` : `Select ${many}`}
      </span>
      <button type="button" className="select-bar-btn" disabled={!total} onClick={() => scope.set(all ? [] : [...scope.all()])}>
        {all ? "None" : "All"}
      </button>
      <button
        type="button"
        className="select-bar-btn primary"
        disabled={!count}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          scope.actions(r.right, r.top - 6);
        }}
      >
        <Icon name="more" size={18} />
        Actions
      </button>
    </nav>
  );
}
