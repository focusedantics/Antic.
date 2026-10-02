import { describe, expect, it } from "vitest";
import { sanitizePrefs } from "@/app/prefs";
import { type DeviceInputs, LITE_MAX_SIDE, profileFor } from "@/lib/device";

const desktop: DeviceInputs = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  platform: "Win32",
  maxTouchPoints: 0,
  memoryGb: 8,
  cores: 12,
  coarse: false,
  screenShort: 1080,
};
const iPhone: DeviceInputs = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
  cores: 6,
  coarse: true,
  screenShort: 390,
};

describe("device profile", () => {
  it("leaves a computer unlimited", () => {
    const p = profileFor(desktop);
    expect(p).toMatchObject({ phone: false, lite: false, maxSide: Number.POSITIVE_INFINITY, dprCap: Number.POSITIVE_INFINITY, workers: 4 });
    expect(p.poolBudget).toBe(320 * 1024 * 1024);
  });

  it("gives phones the memory limits and the lighter animations", () => {
    const p = profileFor(iPhone);
    expect(p).toMatchObject({ phone: true, lite: true, maxSide: LITE_MAX_SIDE, dprCap: 2, workers: 2 });
    expect(p.poolBudget).toBeLessThan(100 * 1024 * 1024);
    const android = profileFor({ ...desktop, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", coarse: true, screenShort: 412 });
    expect(android).toMatchObject({ phone: true, lite: true });
  });

  it("treats tablets as tight on memory but not as phones", () => {
    // iPadOS reports a Mac with a touch screen.
    const iPad = profileFor({ ...desktop, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5, coarse: true, screenShort: 820 });
    expect(iPad).toMatchObject({ phone: false, lite: true });
  });

  it("counts a very small memory as lite, and follows an explicit override", () => {
    expect(profileFor({ ...desktop, memoryGb: 2 }).lite).toBe(true);
    expect(profileFor({ ...desktop, memoryGb: 4 }).lite).toBe(false);
    expect(profileFor({ ...iPhone, override: "full" })).toMatchObject({ phone: false, lite: false });
    expect(profileFor({ ...desktop, override: "phone" })).toMatchObject({ phone: true, lite: true });
    expect(profileFor({ ...desktop, override: "lite" })).toMatchObject({ phone: false, lite: true });
  });
});

describe("layout prefs", () => {
  it("defaults to every panel shown at the stylesheet widths", () => {
    expect(sanitizePrefs(null)).toMatchObject({ showLeft: true, showRight: true, showFilmstrip: true, leftWidth: null, rightWidth: null, sheetHeight: 0.36 });
  });

  it("clamps widths and the sheet height, and rejects junk", () => {
    expect(sanitizePrefs({ leftWidth: 40, rightWidth: 9000, sheetHeight: 3, showLeft: "no" })).toMatchObject({ leftWidth: 180, rightWidth: 560, sheetHeight: 0.9, showLeft: true });
    expect(sanitizePrefs({ leftWidth: 300.4, rightWidth: Number.NaN, sheetHeight: 0.1, showRight: false })).toMatchObject({ leftWidth: 300, rightWidth: null, sheetHeight: 0.25, showRight: false });
  });

  it("shows a phone's floating histogram unless it was hidden", () => {
    expect(sanitizePrefs(null).showHistogram).toBe(true);
    expect(sanitizePrefs({ showHistogram: false }).showHistogram).toBe(false);
    expect(sanitizePrefs({ showHistogram: "no" }).showHistogram).toBe(true);
  });
});
