import { afterEach, describe, expect, it, vi } from "vitest";
import { holdAtLeast, nextPaint, PACE } from "@/lib/pacing";

afterEach(() => vi.useRealTimers());

describe("pacing", () => {
  it("holds a quick run up to the minimum, and does not delay a long one", async () => {
    vi.useFakeTimers();
    const now = performance.now();
    let done = false;
    void holdAtLeast(now, PACE.minWorking).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(PACE.minWorking - 50);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(done).toBe(true);
    let late = false;
    void holdAtLeast(now - 5000).then(() => (late = true));
    await vi.advanceTimersByTimeAsync(1);
    expect(late).toBe(true);
  });

  it("resolves nextPaint even when frames never come (a hidden tab)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    let painted = false;
    void nextPaint().then(() => (painted = true));
    await vi.advanceTimersByTimeAsync(120);
    expect(painted).toBe(true);
    vi.unstubAllGlobals();
  });
});
