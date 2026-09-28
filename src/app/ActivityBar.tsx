import { useEffect, useRef, useState } from "react";
import { useStore } from "./hooks";
import { importProgress } from "@/core/catalog/import";
import { activity } from "@/lib/activity";

/** Shortest time the line stays up, so even instant changes leave a trace. */
const MIN_VISIBLE = 320;

/**
 * A 2px line along the top edge. It creeps forward while work runs (renders,
 * decoding, AI, imports, exports), then finishes and fades out.
 */
export function ActivityBar() {
  const running = useStore(activity, (s) => s.running);
  const pulses = useStore(activity, (s) => s.pulses);
  const importing = useStore(importProgress, (s) => s.active);
  const busy = running > 0 || importing;
  const [phase, setPhase] = useState<"idle" | "run" | "done">("idle");
  const [run, setRun] = useState(0);
  const phaseRef = useRef(phase);
  const started = useRef(0);
  const lastPulse = useRef(pulses);
  phaseRef.current = phase;

  useEffect(() => {
    const pulsed = pulses !== lastPulse.current;
    lastPulse.current = pulses;
    if ((busy || pulsed) && phaseRef.current !== "run") {
      started.current = performance.now();
      setRun((r) => r + 1);
      setPhase("run");
      phaseRef.current = "run";
    }
    if (busy || phaseRef.current !== "run") return;
    const t = setTimeout(() => setPhase((p) => (p === "run" ? "done" : p)), Math.max(0, started.current + MIN_VISIBLE - performance.now()));
    return () => clearTimeout(t);
  }, [busy, pulses]);

  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => setPhase((p) => (p === "done" ? "idle" : p)), 650);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div className="activity-line" data-phase={phase} aria-hidden="true">
      <span key={run} />
    </div>
  );
}
