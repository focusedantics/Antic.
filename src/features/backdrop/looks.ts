import type { Workspace } from "@/app/state";

export type RGB = readonly [number, number, number];

/** What the glow looks like in one workspace. Every field blends smoothly into the next. */
export type GlowLook = {
  readonly color1: RGB;
  readonly color2: RGB;
  /** Rotation of the ribbon, in degrees. */
  readonly angle: number;
  /** 1 = the ribbon's natural scale. */
  readonly size: number;
  /** Animation speed multiplier. */
  readonly speed: number;
  /** Brightness of the glow over the backdrop (0–1). Kept low where colour judgement matters. */
  readonly intensity: number;
};

export function hex(h: string): RGB {
  const n = parseInt(h.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The surround colour of every viewer (`--bg-canvas`). The glow adds light on top of it. */
export const BACKDROP_BASE = hex("#0d0d0d");

export const LOOKS: Record<Workspace, GlowLook> = {
  // Warm amber and coral: the brand accent, for browsing.
  library: { color1: hex("#f0b84c"), color2: hex("#ff6a3d"), angle: -180, size: 1, speed: 1, intensity: 0.6 },
  // Cool teal and blue, and dim: a coloured surround shifts how a photo's colour reads.
  develop: { color1: hex("#2ec4b6"), color2: hex("#3d7fff"), angle: -140, size: 1.15, speed: 0.7, intensity: 0.4 },
  // Violet and pink: layers and play.
  composite: { color1: hex("#9b5cff"), color2: hex("#ff3d9a"), angle: 150, size: 0.95, speed: 1, intensity: 0.6 },
  // Lime and cyan: making things.
  design: { color1: hex("#b8f03d"), color2: hex("#3dd6ff"), angle: 120, size: 1, speed: 1.1, intensity: 0.55 },
  // Hot red and yellow, faster: the YTP editor.
  video: { color1: hex("#ff3d5a"), color2: hex("#ffb23d"), angle: -100, size: 1.05, speed: 1.5, intensity: 0.5 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Shortest-way angle blend, so -180 → 150 turns 30°, not 330°. */
function lerpAngle(a: number, b: number, t: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

export function mixLook(a: GlowLook, b: GlowLook, t: number): GlowLook {
  return {
    color1: lerp3(a.color1, b.color1, t),
    color2: lerp3(a.color2, b.color2, t),
    angle: lerpAngle(a.angle, b.angle, t),
    size: lerp(a.size, b.size, t),
    speed: lerp(a.speed, b.speed, t),
    intensity: lerp(a.intensity, b.intensity, t),
  };
}

/** Frame-rate independent ease toward a target: about 95% of the way after `seconds`. */
export function approach(current: GlowLook, target: GlowLook, dt: number, seconds = 1.2): GlowLook {
  return mixLook(current, target, 1 - Math.exp((-3 * dt) / seconds));
}
