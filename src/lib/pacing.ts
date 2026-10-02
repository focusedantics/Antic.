/**
 * Pacing for work of unknown length (exports, AI, decoding). The rules every
 * animation in Focused follows:
 *
 * 1. Answer within a frame: call `nextPaint()` after showing a working state and
 *    before heavy synchronous work, so the click visibly lands.
 * 2. Short runs still read: keep the working state up for at least `PACE.minWorking`
 *    (`holdAtLeast`), then play a short completion beat (`PACE.doneBeat`).
 * 3. Long runs loop and report: animations loop seamlessly and show a stage or a
 *    percentage, never a frozen frame.
 * 4. prefers-reduced-motion: skip flourishes, keep the state changes.
 */
export const PACE = {
  /** Shortest time a working animation stays up. */
  minWorking: 900,
  /** The "done" moment before a dialog closes or an overlay leaves. */
  doneBeat: 650,
} as const;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Resolves once the browser has painted (two animation frames), or after 100 ms in a hidden tab. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      }),
    );
  });
}

/** Waits until at least `ms` have passed since `start` (a `performance.now()` time). */
export function holdAtLeast(start: number, ms: number = PACE.minWorking): Promise<void> {
  return sleep(start + ms - performance.now());
}

export const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
