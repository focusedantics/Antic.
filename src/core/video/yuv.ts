/**
 * Exact pixel shuffles on decoded YUV frames: cropping to the visible area,
 * NV12 → I420 and quarter-turn rotations. No arithmetic touches a sample
 * value, so a frame passed through here and a lossless encoder is still
 * bit-identical to the source.
 */

export type Plane = { readonly data: Uint8Array; readonly width: number; readonly height: number };
export type I420 = { readonly width: number; readonly height: number; readonly planes: readonly [Plane, Plane, Plane] };

type Rect = { x: number; y: number; width: number; height: number };

/** Extracts the visible I420 planes of a copied frame (I420 or NV12); null for other formats. */
export function visibleI420(data: Uint8Array, format: string, layout: readonly PlaneLayout[], rect: Rect): I420 | null {
  const { x, y, width, height } = rect;
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const cx = x >> 1;
  const cy = y >> 1;
  const plane = (index: number, px: number, py: number, w: number, h: number, step = 1, offset = 0): Plane => {
    const { offset: base, stride } = layout[index];
    const out = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const row = base + (py + r) * stride + px * step + offset;
      if (step === 1) out.set(data.subarray(row, row + w), r * w);
      else for (let c = 0; c < w; c++) out[r * w + c] = data[row + c * step];
    }
    return { data: out, width: w, height: h };
  };
  if (format === "I420") return { width, height, planes: [plane(0, x, y, width, height), plane(1, cx, cy, cw, ch), plane(2, cx, cy, cw, ch)] };
  if (format === "NV12") return { width, height, planes: [plane(0, x, y, width, height), plane(1, cx, cy, cw, ch, 2, 0), plane(1, cx, cy, cw, ch, 2, 1)] };
  return null;
}

/** Rotates a plane clockwise by `rotation` degrees (0/90/180/270). */
export function rotatePlane(p: Plane, rotation: number): Plane {
  const { data, width: w, height: h } = p;
  if (rotation === 0) return p;
  const out = new Uint8Array(w * h);
  if (rotation === 180) {
    for (let i = 0, n = w * h; i < n; i++) out[n - 1 - i] = data[i];
    return { data: out, width: w, height: h };
  }
  // 90: source (x, y) → (h−1−y, x); 270: source (x, y) → (y, w−1−x). Output is h × w.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      if (rotation === 90) out[x * h + (h - 1 - y)] = v;
      else out[(w - 1 - x) * h + y] = v;
    }
  }
  return { data: out, width: h, height: w };
}

export function rotateI420(f: I420, rotation: number): I420 {
  if (!rotation) return f;
  const planes = f.planes.map((p) => rotatePlane(p, rotation)) as [Plane, Plane, Plane];
  return { width: planes[0].width, height: planes[0].height, planes };
}

/** A tightly packed I420 VideoFrame (the caller closes it). */
export function i420Frame(f: I420, timestamp: number, duration: number, colorSpace?: VideoColorSpaceInit): VideoFrame {
  const [y, u, v] = f.planes;
  const data = new Uint8Array(y.data.length + u.data.length + v.data.length);
  data.set(y.data, 0);
  data.set(u.data, y.data.length);
  data.set(v.data, y.data.length + u.data.length);
  return new VideoFrame(data, {
    format: "I420",
    codedWidth: f.width,
    codedHeight: f.height,
    timestamp,
    duration,
    layout: [
      { offset: 0, stride: y.width },
      { offset: y.data.length, stride: u.width },
      { offset: y.data.length + u.data.length, stride: v.width },
    ],
    ...(colorSpace ? { colorSpace } : {}),
  });
}
