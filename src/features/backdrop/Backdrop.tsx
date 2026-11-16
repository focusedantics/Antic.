import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "@/app/hooks";
import { prefs } from "@/app/prefs";
import { ui } from "@/app/state";
import { motion } from "@/lib/motion";
import { LOOKS } from "./looks";
import { RibbonGlow } from "./ribbon";

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (cb: () => void) => {
  const m = window.matchMedia(REDUCE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const reducedMotion = () => window.matchMedia(REDUCE).matches;

/** The glow rests after this long without a pointer move, key or scroll. */
const AWAY_MS = 20_000;

/**
 * True once nobody has touched the page for a while: an animation nobody is watching
 * keeps the GPU (and a laptop's fan) busy for nothing. The first move brings it back.
 */
function useAway() {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer = 0;
    let gone = false;
    const set = (v: boolean) => {
      gone = v;
      setAway(v);
    };
    const here = () => {
      if (gone) set(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => set(true), AWAY_MS);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const e of events) window.addEventListener(e, here, { passive: true, capture: true });
    here();
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, here, { capture: true });
    };
  }, []);
  return away;
}

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
  const held = useStore(motion, (s) => s.holds > 0);
  const away = useAway();

  useEffect(() => {
    const g = new RibbonGlow(ref.current!, LOOKS[ui.getState().workspace], { reducedMotion: reducedMotion() });
    glow.current = g;
    return () => {
      g.dispose();
      glow.current = null;
    };
  }, []);
  useEffect(() => glow.current?.setLook(LOOKS[workspace]), [workspace]);
  useEffect(() => glow.current?.setOptions({ reducedMotion: still, held: held || away }), [still, held, away]);

  return <div ref={ref} className="backdrop" data-testid="backdrop" data-look={workspace} aria-hidden="true" />;
}
