/**
 * What this device can comfortably do. Desktops get the full profile, which
 * changes nothing. Phones and tablets get limits that keep a tab under the
 * memory a mobile browser allows before it reloads the page (iOS Safari kills
 * tabs at a few hundred MB on many iPhones; a 24 MP photo as an RGBA16F texture
 * with mipmaps is ~260 MB on its own).
 *
 * - `lite`: tight memory. Photos are kept on the GPU and exported at most
 *   `maxSide` px on the long side, the idle render-target pool is small, the
 *   viewer renders at most 2 device pixels per CSS pixel, fewer decode workers.
 * - `phone`: a handheld screen. Decorative animations (the glow, the export
 *   marble's motion, the Remove Background particles) give way to simple fades.
 *
 * `localStorage["focused:device"] = "phone" | "lite" | "full"` overrides the guess.
 */
export type DeviceProfile = {
  readonly phone: boolean;
  readonly lite: boolean;
  /** Longest side a photo is kept on the GPU and exported (Infinity: no limit beyond the GPU's). */
  readonly maxSide: number;
  /** Most bytes idle pooled render targets may hold. */
  readonly poolBudget: number;
  /** Most device pixels per CSS pixel the viewers render. */
  readonly dprCap: number;
  /** Image decode workers. */
  readonly workers: number;
};

export type DeviceInputs = {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
  /** navigator.deviceMemory in GB (Chromium only). */
  readonly memoryGb?: number;
  readonly cores?: number;
  readonly coarse: boolean;
  /** Short side of the screen in CSS px. */
  readonly screenShort: number;
  readonly override?: string | null;
};

export const LITE_MAX_SIDE = 4096;

export function profileFor(i: DeviceInputs): DeviceProfile {
  const ua = i.userAgent;
  const iPhone = /iPhone|iPod/.test(ua);
  const iPad = /iPad/.test(ua) || (i.platform === "MacIntel" && i.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const androidPhone = android && /Mobile/.test(ua);
  let phone = iPhone || androidPhone || (i.coarse && i.screenShort > 0 && i.screenShort <= 600);
  let lite = phone || iPad || android || (i.memoryGb !== undefined && i.memoryGb <= 2);
  if (i.override === "phone") phone = lite = true;
  else if (i.override === "lite") (lite = true), (phone = false);
  else if (i.override === "full") phone = lite = false;
  const cores = Math.max(1, i.cores || 4);
  return lite
    ? { phone, lite, maxSide: LITE_MAX_SIDE, poolBudget: 64 * 1024 * 1024, dprCap: 2, workers: Math.max(1, Math.min(2, cores - 1)) }
    : { phone, lite, maxSide: Number.POSITIVE_INFINITY, poolBudget: 320 * 1024 * 1024, dprCap: Number.POSITIVE_INFINITY, workers: Math.max(1, Math.min(4, cores - 1)) };
}

function detect(): DeviceProfile {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  let override: string | null = null;
  try {
    override = typeof localStorage !== "undefined" ? localStorage.getItem("focused:device") : null;
  } catch {
    // Storage blocked: no override.
  }
  const hasWindow = typeof window !== "undefined";
  return profileFor({
    userAgent: nav?.userAgent ?? "",
    platform: nav?.platform ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    memoryGb: (nav as { deviceMemory?: number } | undefined)?.deviceMemory,
    cores: nav?.hardwareConcurrency,
    coarse: hasWindow && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    screenShort: hasWindow && window.screen ? Math.min(window.screen.width, window.screen.height) : 0,
    override,
  });
}

/** The profile, decided once per page load (it sizes caches and workers). */
export const device: DeviceProfile = detect();

/** Device pixels per CSS pixel for viewer canvases: the screen's, capped on lite devices. */
export const viewDpr = () => Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, device.dprCap);

/** iPhone, iPad or iPod (iPadOS reports a Mac with a touch screen). Every browser there uses WebKit. */
export function appleTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
