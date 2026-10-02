import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStore } from "@/app/hooks";
import { prefs } from "@/app/prefs";
import { ui } from "@/app/state";
import { LOOKS } from "./looks";
import { RibbonGlow } from "./ribbon";

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (cb: () => void) => {
  const m = window.matchMedia(REDUCE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const reducedMotion = () => window.matchMedia(REDUCE).matches;

/**
 * The animated glow behind every viewer. It sits under the whole app; panels
 * are opaque, so it shows only where a viewer is transparent around the photo.
 * Each workspace has its own look and the glow blends between them.
 */
export function Backdrop() {
  const on = useStore(prefs, (s) => s.backdrop);
  return on ? <Glow /> : null;
}

function Glow() {
  const ref = useRef<HTMLDivElement>(null);
  const glow = useRef<RibbonGlow | null>(null);
  const workspace = useStore(ui, (s) => s.workspace);
  const still = useSyncExternalStore(subscribeMotion, reducedMotion);

  useEffect(() => {
    const g = new RibbonGlow(ref.current!, LOOKS[ui.getState().workspace], { reducedMotion: reducedMotion() });
    glow.current = g;
    return () => {
      g.dispose();
      glow.current = null;
    };
  }, []);
  useEffect(() => glow.current?.setLook(LOOKS[workspace]), [workspace]);
  useEffect(() => glow.current?.setOptions({ reducedMotion: still }), [still]);

  return <div ref={ref} className="backdrop" data-testid="backdrop" data-look={workspace} aria-hidden="true" />;
}
