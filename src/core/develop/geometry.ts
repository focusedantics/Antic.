import { degToRad, invert3, type Mat3, mul3 } from "@/lib/math";
import type { Geometry } from "./recipe";

/**
 * Coordinate spaces, in order from what the user sees back to the pixels:
 *
 *   output uv  (0..1 over the cropped result)
 *     → frame   (the rotated/flipped photo, normalized 0..1, before straighten)
 *     → source  (the oriented photo as decoded, normalized 0..1)
 *
 * One homography maps output → source, so the renderer can sample the photo and
 * the UI can map a click back to source coordinates (where masks live).
 * All matrices are row-major and act on column vectors [x, y, 1].
 */

export type Size = { readonly width: number; readonly height: number };

const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const scale = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1];
const rotate = (radians: number): Mat3 => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

/** Size of the frame after quarter turns. */
export function frameSize(source: Size, g: Pick<Geometry, "rotate90">): Size {
  return g.rotate90 % 2 ? { width: source.height, height: source.width } : source;
}

/** Frame pixel → source pixel (undoes rotate90 and flips). */
function frameToSourcePixels(source: Size, g: Geometry): Mat3 {
  const f = frameSize(source, g);
  // Build source→frame, then invert: center, flip, rotate, re-center.
  let m = translate(-source.width / 2, -source.height / 2);
  m = mul3(scale(g.flipHorizontal ? -1 : 1, g.flipVertical ? -1 : 1), m);
  m = mul3(rotate((g.rotate90 * Math.PI) / 2), m);
  m = mul3(translate(f.width / 2, f.height / 2), m);
  return invert3(m);
}

/**
 * Keystone correction as a homography on the frame (pixels). Positive
 * `vertical` narrows the top, correcting converging verticals of a camera
 * tilted upward; `horizontal` does the same across the width.
 */
function keystone(frame: Size, g: Geometry): Mat3 {
  const v = (g.vertical / 100) * 0.35;
  const h = (g.horizontal / 100) * 0.35;
  if (!v && !h) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const w = frame.width;
  const H = frame.height;
  // Map of the corrected (output) rectangle's corners to where they sit in the frame.
  const src = [
    [0 + (v > 0 ? v * w * 0.5 : 0), 0 + (h > 0 ? h * H * 0.5 : 0)],
    [w - (v > 0 ? v * w * 0.5 : 0), 0 + (h < 0 ? -h * H * 0.5 : 0)],
    [w - (v < 0 ? -v * w * 0.5 : 0), H - (h < 0 ? -h * H * 0.5 : 0)],
    [0 + (v < 0 ? -v * w * 0.5 : 0), H - (h > 0 ? h * H * 0.5 : 0)],
  ];
  const dst = [
    [0, 0],
    [w, 0],
    [w, H],
    [0, H],
  ];
  // The output rectangle maps onto the (narrowed) frame quad: dst → src.
  return homography(dst, src);
}

/** Homography mapping four points `from` to `to`. */
export function homography(from: number[][], to: number[][]): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Output uv (0..1 over the crop) → frame pixel, including straighten. */
function outputToFramePixels(frame: Size, g: Geometry): Mat3 {
  const { crop } = g;
  let m = scale(crop.width * frame.width, crop.height * frame.height);
  m = mul3(translate(crop.x * frame.width, crop.y * frame.height), m);
  // Straighten rotates the photo by `angle` about the frame center; sampling undoes it.
  m = mul3(translate(-frame.width / 2, -frame.height / 2), m);
  m = mul3(rotate(-degToRad(g.angle)), m);
  m = mul3(translate(frame.width / 2, frame.height / 2), m);
  return m;
}

/** Output uv → source normalized uv. The renderer's geometry and mask passes use it. */
export function outputToSource(source: Size, g: Geometry): Mat3 {
  const frame = frameSize(source, g);
  let m = outputToFramePixels(frame, g);
  m = mul3(keystone(frame, g), m);
  m = mul3(frameToSourcePixels(source, g), m);
  return mul3(scale(1 / source.width, 1 / source.height), m);
}

export const sourceToOutput = (source: Size, g: Geometry) => invert3(outputToSource(source, g));

export function apply(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Pixel size of the cropped output at full resolution. */
export function outputSize(source: Size, g: Geometry): Size {
  const frame = frameSize(source, g);
  return {
    width: Math.max(1, Math.round(g.crop.width * frame.width)),
    height: Math.max(1, Math.round(g.crop.height * frame.height)),
  };
}

/**
 * The largest crop of aspect `aspect` (frame width/height units) centered on
 * `center` that stays inside the straightened photo, so straightening never
 * shows empty corners. Coordinates are normalized to the frame.
 */
export function constrainCrop(
  frame: Size,
  angleDeg: number,
  crop: Geometry["crop"],
): Geometry["crop"] {
  const a = Math.abs(degToRad(angleDeg));
  if (a < 1e-6) {
    const x = Math.max(0, Math.min(1 - crop.width, crop.x));
    const y = Math.max(0, Math.min(1 - crop.height, crop.y));
    return { x, y, width: Math.min(1, crop.width), height: Math.min(1, crop.height) };
  }
  const W = frame.width;
  const H = frame.height;
  const cw = crop.width * W;
  const ch = crop.height * H;
  const cx = (crop.x + crop.width / 2) * W - W / 2;
  const cy = (crop.y + crop.height / 2) * H - H / 2;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // The crop's corners, rotated into the photo's own axes, must lie within ±W/2, ±H/2.
  // Find the largest uniform scale s ≤ 1 of the crop about its center that fits.
  let s = 1;
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const px = (x: number, y: number) => x * cos + y * sin;
    const py = (x: number, y: number) => -x * sin + y * cos;
    const hx = (dx * cw) / 2;
    const hy = (dy * ch) / 2;
    const ox = px(cx, cy);
    const oy = py(cx, cy);
    const vx = px(hx, hy);
    const vy = py(hx, hy);
    const limX = vx === 0 ? Infinity : ((vx > 0 ? W / 2 : -W / 2) - ox) / vx;
    const limY = vy === 0 ? Infinity : ((vy > 0 ? H / 2 : -H / 2) - oy) / vy;
    s = Math.min(s, Math.max(0, limX), Math.max(0, limY));
  }
  const nw = crop.width * s;
  const nh = crop.height * s;
  return {
    x: crop.x + (crop.width - nw) / 2,
    y: crop.y + (crop.height - nh) / 2,
    width: nw,
    height: nh,
  };
}
