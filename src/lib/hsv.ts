/** sRGB hex colours ↔ RGB (0–255) ↔ HSV/HSB (h 0–360, s and v 0–1), for colour pickers. */

export type RGB = { r: number; g: number; b: number };
export type HSV = { h: number; s: number; v: number };

export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** "#abc", "abc", "#aabbcc" or "aabbcc" → "#aabbcc" (lower case), or null. */
export function normalizeHex(v: string): string | null {
  const s = v.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${[...s].map((c) => c + c).join("")}`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  return null;
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1, 7), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const h2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
export const rgbToHex = ({ r, g, b }: RGB) => `#${h2(r)}${h2(g)}${h2(b)}`;

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r1, g1, b1] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

export const hexToHsv = (hex: string) => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: HSV) => rgbToHex(hsvToRgb(hsv));

/** Relative luminance (WCAG), 0 black … 1 white. */
export function luminance(hex: string) {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
