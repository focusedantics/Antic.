import type { RasterRecord } from "@/core/catalog/db";
import type { BrushStroke, LocalAdjustments, Mask, MaskComponent } from "@/core/develop/recipe";
import { illuminantXy, whiteBalanceMatrix } from "@/lib/colorimetry";
import { toGlMat3 } from "@/lib/math";
import type { Gpu, Target, Texture } from "./gl";
import type { MaskContext } from "./pipeline";
import * as M from "./shaders/masks";

/** Dabs every quarter diameter along a stroke, from its first point; a fixed walk keeps replays identical. */
export function strokeDabs(stroke: BrushStroke, width: number, height: number): Float32Array {
  const longSide = Math.max(width, height);
  const radius = (stroke.size / 2) * longSide;
  const spacing = Math.max(0.75, radius / 2);
  const out: number[] = [];
  const pts = stroke.points;
  if (!pts.length) return new Float32Array();
  const push = (x: number, y: number, pressure: number) => out.push(x * width, y * height, radius, stroke.flow * pressure);
  push(pts[0][0], pts[0][1], pts[0][2]);
  let travelled = 0;
  let next = spacing;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0] * width;
    const ay = pts[i - 1][1] * height;
    const bx = pts[i][0] * width;
    const by = pts[i][1] * height;
    const length = Math.hypot(bx - ax, by - ay);
    while (length > 0 && next <= travelled + length) {
      const t = (next - travelled) / length;
      const p = pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, radius, stroke.flow * p);
      next += spacing;
    }
    travelled += length;
  }
  return new Float32Array(out);
}

type BrushCache = { strokes: readonly BrushStroke[]; base: Target; baseCount: number; texture: Target };

/**
 * Renders develop masks: builds each mask's coverage from its components and
 * applies the mask's local adjustments through it. Brush coverage is rasterized
 * once in source space and cached; while painting only the newest stroke is redrawn.
 */
export class MaskRenderer {
  private brushes = new Map<string, BrushCache>();
  private rasters = new Map<string, Texture>();
  private pendingRasters = new Set<string>();
  /** Coverage of the mask being edited, kept for the overlay. */
  overlay: { maskId: string; target: Target } | null = null;
  /** Small copy of the image entering the mask stage, for color and luminance picking. */
  private sampleImage: Target | null = null;
  onRasterLoaded: (() => void) | null = null;

  constructor(
    private readonly gpu: Gpu,
    private readonly loadRaster: (id: string) => Promise<RasterRecord | undefined>,
  ) {}

  private brushSize(size: { width: number; height: number }) {
    const long = Math.min(4096, this.gpu.maxTextureSize, Math.max(size.width, size.height));
    const scale = long / Math.max(size.width, size.height);
    return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
  }

  private drawStroke(target: Target, scratch: Target, stroke: BrushStroke) {
    this.gpu.clear(scratch, 0);
    this.gpu.drawDabs(scratch, strokeDabs(stroke, scratch.width, scratch.height), stroke.feather);
    this.gpu.pass("mask-density", M.density, {
      target,
      textures: { uInput: scratch },
      uniforms: { uDensity: stroke.density },
      blend: stroke.mode === "paint" ? "screen" : "multiply-inverse",
    });
  }

  private brush(component: MaskComponent, strokes: readonly BrushStroke[], source: { width: number; height: number }): Texture {
    const size = this.brushSize(source);
    let cache = this.brushes.get(component.id);
    if (cache && (cache.texture.width !== size.width || cache.texture.height !== size.height)) {
      this.gpu.dispose(cache.base);
      this.gpu.dispose(cache.texture);
      this.brushes.delete(component.id);
      cache = undefined;
    }
    if (cache && cache.strokes === strokes) return cache.texture;
    if (!cache) {
      cache = {
        strokes: [],
        base: this.gpu.target(size.width, size.height, "r16f"),
        baseCount: 0,
        texture: this.gpu.target(size.width, size.height, "r16f"),
      };
      this.gpu.clear(cache.base, 0);
      this.brushes.set(component.id, cache);
    }
    const scratch = this.gpu.target(size.width, size.height, "r16f");
    // `base` holds every stroke except the newest; it is valid while those strokes are unchanged.
    const baseValid = cache.baseCount <= strokes.length - 1 && cache.strokes.slice(0, cache.baseCount).every((s, i) => s === strokes[i]);
    if (!baseValid) {
      this.gpu.clear(cache.base, 0);
      cache.baseCount = 0;
    }
    for (let i = cache.baseCount; i < strokes.length - 1; i++) this.drawStroke(cache.base, scratch, strokes[i]);
    cache.baseCount = Math.max(0, strokes.length - 1);
    this.gpu.pass("mask-copy", M.copy, { target: cache.texture, textures: { uInput: cache.base } });
    if (strokes.length) this.drawStroke(cache.texture, scratch, strokes[strokes.length - 1]);
    this.gpu.dispose(scratch);
    cache.strokes = strokes;
    return cache.texture;
  }

  private raster(id: string): Texture | null {
    const hit = this.rasters.get(id);
    if (hit) return hit;
    if (!this.pendingRasters.has(id)) {
      this.pendingRasters.add(id);
      void this.loadRaster(id).then((record) => {
        this.pendingRasters.delete(id);
        if (!record) return;
        this.rasters.set(id, this.gpu.texture(record.width, record.height, "r8", record.data));
        this.onRasterLoaded?.();
      });
    }
    return null;
  }

  /** Registers a raster that was just created, so it renders without a round trip to IndexedDB. */
  putRaster(record: RasterRecord) {
    this.gpu.dispose(this.rasters.get(record.id));
    this.rasters.set(record.id, this.gpu.texture(record.width, record.height, "r8", record.data));
  }

  /** Coverage of one mask at the working resolution. The caller releases it. */
  coverage(mask: Mask, image: Texture, ctx: MaskContext): Target {
    const { pipeline } = ctx;
    let current: Target | null = null;
    const components = mask.components;
    components.forEach((component, index) => {
      const next = pipeline.acquire(ctx.width, ctx.height, "r16f");
      const shape = component.shape;
      const uniforms: Record<string, number | number[] | Float32Array> = {
        uOutToSrc: ctx.outToSrc,
        uSrcSize: [ctx.source.size.width, ctx.source.size.height],
        uOperation: component.operation === "add" ? 0 : component.operation === "subtract" ? 1 : 2,
        uFirst: index === 0 ? 1 : 0,
        uInvert: component.invert ? 1 : 0,
        uOpacity: component.opacity,
      };
      let raster: Texture | null = null;
      switch (shape.kind) {
        case "linear":
          Object.assign(uniforms, { uKind: 0, uA: [shape.start.x, shape.start.y], uB: [shape.end.x, shape.end.y] });
          break;
        case "radial":
          Object.assign(uniforms, { uKind: 1, uA: [shape.center.x, shape.center.y], uB: [shape.radiusX, shape.radiusY], uAngle: shape.angle, uFeather: shape.feather / 100 });
          break;
        case "brush":
          raster = this.brush(component, shape.strokes, ctx.source.size);
          uniforms.uKind = 2;
          break;
        case "ai":
          raster = this.raster(shape.rasterId);
          uniforms.uKind = 2;
          break;
        case "luminance":
          Object.assign(uniforms, { uKind: 3, uRange: [shape.low, shape.high, shape.smoothness] });
          break;
        case "color": {
          const samples = new Float32Array(15);
          shape.samples.slice(0, 5).forEach((s, i) => samples.set(s, i * 3));
          Object.assign(uniforms, { uKind: 4, uSamples: samples, uSampleCount: shape.samples.length, uRefine: shape.refine / 100 });
          break;
        }
      }
      if ((shape.kind === "ai" || shape.kind === "brush") && !raster) {
        // Raster not loaded yet: treat as empty coverage for this frame.
        uniforms.uKind = 0;
        uniforms.uA = [0, -10];
        uniforms.uB = [0, -9];
      }
      pipelinePass(this.gpu, next, current ?? next, image, raster, uniforms);
      if (current) pipeline.release(current);
      current = next;
    });
    if (!current) {
      current = pipeline.acquire(ctx.width, ctx.height, "r16f");
      this.gpu.clear(current, 0);
    }
    return current;
  }

  /** The pipeline's mask stage: every visible mask, in order. */
  readonly stage = (input: Target, ctx: MaskContext, activeMaskId: string | null, render: "view" | "view-overlay" | "offscreen"): Target => {
    const { pipeline } = ctx;
    let current = input;
    const keepOverlay = render === "view-overlay";
    // Only the on-screen render owns the overlay; thumbnails and exports leave it alone.
    if (render !== "offscreen" && this.overlay) {
      pipeline.release(this.overlay.target);
      this.overlay = null;
    }
    if (render !== "offscreen") {
      const scale = Math.min(1, 512 / Math.max(input.width, input.height));
      const w = Math.max(1, Math.round(input.width * scale));
      const h = Math.max(1, Math.round(input.height * scale));
      if (!this.sampleImage || this.sampleImage.width !== w || this.sampleImage.height !== h) {
        this.gpu.dispose(this.sampleImage);
        this.sampleImage = this.gpu.target(w, h);
      }
      this.gpu.pass("mask-sample-copy", M.resample, { target: this.sampleImage, textures: { uInput: input } });
    }
    for (const mask of ctx.recipe.masks) {
      if (!mask.components.length) continue;
      const isActive = mask.id === activeMaskId;
      if (!mask.visible && !isActive) continue;
      const coverage = this.coverage(mask, input, ctx);
      if (mask.visible && hasAdjustments(mask.adjustments)) {
        const next = pipeline.acquire(ctx.width, ctx.height);
        this.gpu.pass("mask-adjust", M.localAdjust, {
          target: next,
          textures: { uInput: current, uCoverage: coverage, uBlurSmall: ctx.blurSmall, uBlurLarge: ctx.blurLarge },
          uniforms: localUniforms(mask),
        });
        if (current !== input) pipeline.release(current);
        current = next;
      }
      if (isActive && keepOverlay) this.overlay = { maskId: mask.id, target: coverage };
      else pipeline.release(coverage);
    }
    return current;
  };

  /** Linear Rec.2020 color of the pre-mask image at output uv (u, v). */
  sample(u: number, v: number): [number, number, number] | null {
    const t = this.sampleImage;
    if (!t) return null;
    const [r, g, b] = this.gpu.readPixelFloat(t, u * t.width, v * t.height);
    return [r, g, b];
  }

  dispose() {
    this.gpu.dispose(this.sampleImage);
    for (const c of this.brushes.values()) {
      this.gpu.dispose(c.base);
      this.gpu.dispose(c.texture);
    }
    for (const r of this.rasters.values()) this.gpu.dispose(r);
    this.brushes.clear();
    this.rasters.clear();
  }
}

function pipelinePass(gpu: Gpu, target: Target, previous: Texture, image: Texture, raster: Texture | null, uniforms: Record<string, number | number[] | Float32Array>) {
  gpu.pass("mask-component", M.maskComponent, {
    target,
    textures: { uPrevious: previous === target ? null : previous, uImage: image, uRaster: raster },
    uniforms,
  });
}

export function hasAdjustments(a: LocalAdjustments) {
  return Object.values(a).some((v) => v !== 0);
}

function localUniforms(mask: Mask) {
  const a = mask.adjustments;
  const mired = 1e6 / 6500;
  const wb =
    a.temperature || a.tint
      ? whiteBalanceMatrix(illuminantXy(6500, 0), illuminantXy(1e6 / Math.max(40, mired - a.temperature * 0.8), a.tint))
      : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as const);
  return {
    uAmount: mask.amount,
    uInvertMask: mask.invert ? 1 : 0,
    uWhiteBalance: toGlMat3(wb),
    uExposure: a.exposure,
    uContrast: a.contrast,
    uHighlights: a.highlights,
    uShadows: a.shadows,
    uWhites: a.whites,
    uBlacks: a.blacks,
    uTexture: a.texture / 100,
    uClarity: a.clarity / 100,
    uDehaze: a.dehaze / 100,
    uHue: a.hue,
    uSaturation: a.saturation,
    uAtmosphere: [1, 1, 1],
  };
}
