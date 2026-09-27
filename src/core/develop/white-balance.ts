import { IDENTITY3, illuminantXy, REC2020_TO_XYZ, whiteBalanceMatrix, type Xy, XYZToXy, xyToTemperatureTint } from "@/lib/colorimetry";
import { type Mat3, mulVec3 } from "@/lib/math";
import type { SourceColorInfo } from "./defaults";
import type { WhiteBalance } from "./recipe";

/** Rendered files are D65; the relative scale maps -100..100 to ±100 mired around it. */
const RENDERED_WHITE = 6500;
const renderedTarget = (wb: WhiteBalance) => {
  const mired = 1e6 / RENDERED_WHITE - wb.temperature;
  return illuminantXy(1e6 / Math.max(mired, 40), wb.tint);
};

export function whiteBalanceFor(wb: WhiteBalance, info: SourceColorInfo): Mat3 {
  let from: Xy;
  let to: Xy;
  if (info.raw) {
    const shot = info.asShot ?? { temperature: 5500, tint: 0 };
    if (wb.temperature === shot.temperature && wb.tint === shot.tint) return IDENTITY3;
    from = illuminantXy(shot.temperature, shot.tint);
    to = illuminantXy(wb.temperature, wb.tint);
  } else {
    if (wb.temperature === 0 && wb.tint === 0) return IDENTITY3;
    from = illuminantXy(RENDERED_WHITE, 0);
    to = renderedTarget(wb);
  }
  return whiteBalanceMatrix(from, to);
}


/**
 * White balance that makes `color` (linear Rec.2020, sampled from the source
 * before any adjustment) neutral. Under von Kries adaptation the illuminant to
 * assume is the as-shot white shifted by the color's own cast.
 */
export function neutralize(color: readonly [number, number, number], info: SourceColorInfo): { temperature: number; tint: number } {
  const XYZ = mulVec3(REC2020_TO_XYZ, [Math.max(color[0], 1e-6), Math.max(color[1], 1e-6), Math.max(color[2], 1e-6)]);
  const cast = XYZToXy(XYZ);
  const base = info.raw ? (info.asShot ?? { temperature: 5500, tint: 0 }) : { temperature: RENDERED_WHITE, tint: 0 };
  const from = illuminantXy(base.temperature, base.tint);
  // Compose shifts in uv: illuminant = from + (cast - D65).
  const D65xy = { x: 0.31271, y: 0.32902 };
  const target = { x: from.x + (cast.x - D65xy.x), y: from.y + (cast.y - D65xy.y) };
  const kt = xyToTemperatureTint(target);
  if (info.raw) {
    return { temperature: Math.round(Math.min(50000, Math.max(2000, kt.temperature)) / 50) * 50, tint: Math.max(-150, Math.min(150, kt.tint)) };
  }
  const relative = 1e6 / RENDERED_WHITE - 1e6 / kt.temperature;
  return { temperature: Math.round(Math.max(-100, Math.min(100, relative))), tint: Math.max(-100, Math.min(100, kt.tint)) };
}

/** Gray-world average with clipped and near-black pixels excluded. */
export function averageNeutral(pixels: Float32Array): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const y = 0.2627 * pixels[i] + 0.678 * pixels[i + 1] + 0.0593 * pixels[i + 2];
    if (pixels[i + 3] < 0.5 || y < 0.01 || Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 0.97) continue;
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : [1, 1, 1];
}
