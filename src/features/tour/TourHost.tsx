import { lazy, Suspense, useEffect } from "react";
import { useStore } from "@/app/hooks";
import { prefs, setPrefs } from "@/app/prefs";
import { openMenu } from "@/components/Menu";
import { CHAPTERS } from "./steps";
import { startTour, startTourIfNew, tour } from "./tour";

const Tour = lazy(() => import("./Tour"));

/** Mounts the tour while it runs, and offers it once to someone new. */
export function TourHost() {
  const active = useStore(tour, (s) => s.active);
  useEffect(() => {
    // Let the first workspace lay out before the welcome card measures it.
    const t = setTimeout(startTourIfNew, 600);
    return () => clearTimeout(t);
  }, []);
  if (!active) return null;
  return (
    <Suspense fallback={null}>
      <Tour />
    </Suspense>
  );
}

/** Two small buttons at the end of the top bar: the glow toggle and the tour. */
export function TopbarTools() {
  const backdrop = useStore(prefs, (s) => s.backdrop);
  return (
    <div className="topbar-tools">
      <button
        type="button"
        className="tool-btn"
        aria-pressed={backdrop}
        aria-label="Glow background"
        title={backdrop ? "Glow background: on" : "Glow background: off"}
        onClick={() => setPrefs({ backdrop: !backdrop })}
      >
        ◐
      </button>
      <button
        type="button"
        className="tool-btn"
        aria-label="Tour and help"
        aria-haspopup="menu"
        title="Replay the tour"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.right, r.bottom + 4, [
            { label: "Replay the tour", onSelect: () => startTour(1) },
            "separator",
            ...CHAPTERS.slice(1).map((name, i) => ({ label: `${i + 1} · ${name}`, onSelect: () => startTour(i + 1) })),
          ]);
        }}
      >
        ?
      </button>
    </div>
  );
}
