import { createStore } from "zustand/vanilla";

/**
 * Asks decorative motion (the glow backdrop) to hold still, e.g. while a video
 * plays: playback gets the GPU to itself and nothing moves behind the picture.
 * Each `holdMotion()` returns its release; motion resumes when all are released.
 */
export const motion = createStore<{ holds: number }>(() => ({ holds: 0 }));

export function holdMotion(): () => void {
  motion.setState((s) => ({ holds: s.holds + 1 }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    motion.setState((s) => ({ holds: Math.max(0, s.holds - 1) }));
  };
}
