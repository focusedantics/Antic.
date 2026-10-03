import { createDefaultRecipe, type SourceColorInfo } from "@/core/develop/defaults";
import { outputToSource, outputSize, type Size } from "@/core/develop/geometry";
import type { DevelopRecipe } from "@/core/develop/recipe";
import { whiteBalanceFor } from "@/core/develop/white-balance";
import { device } from "@/lib/device";
import { type Mat3, mul3, toGlMat3 } from "@/lib/math";
import { bakeCurves, isToneCurveActive, LUT_SIZE, toHalfArray } from "./curves";
import type { Gpu, Target, Texture, TextureFormat } from "./gl";
import { gradingUniforms, isGradingActive, isMixerActive, mixerUniform } from "./mixer";
import * as S from "./shaders/passes";
import { retouch as retouchShader } from "./shaders/retouch";

/** Decoded pixels ready for upload. */
export type SourceData = (
  | { readonly kind: "rgb16-linear"; readonly width: number; readonly height: number; readonly data: Uint16Array; readonly white: number }
  | { readonly kind: "image"; readonly image: ImageBitmap | OffscreenCanvas | ImageData; readonly width: number; readonly height: number }
) & {
  /** Full-resolution size when the pixels were decoded smaller (see `loadSource`); absent: width × height. */
  readonly fullWidth?: number;
  readonly fullHeight?: number;
};

/** The photo's full-resolution size, whatever size its pixels were decoded at. */
export const fullSizeOf = (data: SourceData): Size => ({ width: data.fullWidth ?? data.width, height: data.fullHeight ?? data.height });

/**
 * A photo on the GPU, mipmapped: linear Rec.2020 RGBA16F (RAW, 16-bit files), or for
 * 8-bit files (JPEG, HEIC, PNG…) the file's own sRGB 8-bit pixels, half the memory,
 * which the geometry pass converts to linear Rec.2020 as it samples (`srgb`).
 */
export type GpuSource = {
  readonly id: string;
  readonly base: Texture;
  /** The base is 8-bit sRGB (linear sRGB primaries once sampled), not linear Rec.2020. */
  readonly srgb?: boolean;
  readonly size: Size;
  readonly info: SourceColorInfo;
  /** Full-resolution pixels per base texel when the photo was larger than the GPU allows. */
  readonly downscale: number;
};

export type RenderOptions = {
  /** Working (output) size in pixels; the crop is rendered to exactly this size. */
  readonly width: number;
  readonly height: number;
  /** Skip masks and expensive detail passes (while dragging). */
  readonly draft?: boolean;
  /** Mask renderer hook (Stage 3). */
  readonly masks?: MaskStage;
  /**
   * Render only part of the output: `width × height` px at (x, y), top-left, of a render
   * that would be `fullWidth × fullHeight`. Zoomed-in views render what is on screen
   * (plus a margin for blurs) instead of the whole photo at full size.
   */
  readonly window?: RenderWindow;
};

export type RenderWindow = { readonly x: number; readonly y: number; readonly fullWidth: number; readonly fullHeight: number };

export type MaskStage = (input: Target, context: MaskContext) => Target;
export type MaskContext = {
  readonly pipeline: DevelopPipeline;
  readonly source: GpuSource;
  readonly recipe: DevelopRecipe;
  readonly outToSrc: Float32Array;
  readonly fullScale: number;
  readonly blurSmall: Texture;
  readonly blurLarge: Texture;
  readonly width: number;
  readonly height: number;
  /** The part of the output rendered, in output uv (x, y, width, height); absent: all of it. */
  readonly window?: readonly [number, number, number, number];
};

/** Most GPU memory idle pooled targets may hold (about three 4K float targets; less on phones). */
const POOL_BUDGET = device.poolBudget;
const BYTES: Record<string, number> = { rgba16f: 8, rgba8: 4, srgba8: 4, r16f: 2, r8: 1, rgb16ui: 6, rgba16ui: 8 };
const bytesOf = (t: Target) => t.width * t.height * (BYTES[t.format] ?? 8) * (t.mipmaps ? 1.34 : 1);

/**
 * Develops a photo according to a recipe. Stateless apart from caches: the same
 * source and recipe always produce the same pixels at a given size.
 */
export class DevelopPipeline {
  private pool = new Map<string, Target[]>();
  private pooledBytes = 0;
  private leased = new Set<Target>();
  private curveCache: { key: DevelopRecipe["toneCurve"]; texture: Texture } | null = null;
  private atmosphereCache = new Map<string, [number, number, number]>();
  /** Retouched sources, one per photo (compositions can hold several). */
  private retouchCache = new Map<string, { source: GpuSource; spots: DevelopRecipe["retouch"]; target: Target }>();

  constructor(readonly gpu: Gpu) {}

  // ─── Targets ─────────────────────────────────────────────────────────────

  acquire(width: number, height: number, format: TextureFormat = "rgba16f"): Target {
    const key = `${Math.round(width)}x${Math.round(height)}:${format}`;
    const list = this.pool.get(key);
    const pooled = list?.pop();
    if (pooled) this.pooledBytes -= bytesOf(pooled);
    const target = pooled ?? this.gpu.target(width, height, format);
    this.leased.add(target);
    return target;
  }

  release(target: Target | null | undefined) {
    if (!target || !this.leased.has(target)) return;
    this.leased.delete(target);
    // Idle targets are kept for reuse only within a memory budget: full-resolution
    // exports would otherwise pin gigabytes of GPU memory, and drivers that run out
    // fail silently (renders come back blank or with stale pixels).
    const bytes = bytesOf(target);
    if (this.pooledBytes + bytes > POOL_BUDGET) {
      this.gpu.dispose(target);
      return;
    }
    const key = `${target.width}x${target.height}:${target.format}`;
    const list = this.pool.get(key) ?? [];
    list.push(target);
    this.pool.set(key, list);
    this.pooledBytes += bytes;
  }

  /** Frees every idle pooled target. */
  trim() {
    for (const list of this.pool.values()) for (const t of list) this.gpu.dispose(t);
    this.pool.clear();
    this.pooledBytes = 0;
  }

  // ─── Sources ─────────────────────────────────────────────────────────────

  /** Uploads a photo, at most `maxSide` px on the long side (phones keep a smaller working copy; see lib/device). */
  upload(id: string, data: SourceData, info: SourceColorInfo, maxSide = device.maxSide): GpuSource {
    const { gpu } = this;
    const max = Math.min(gpu.maxTextureSize, maxSide);
    let width = data.width;
    let height = data.height;
    let downscale = 1;
    if (width > max || height > max) {
      downscale = Math.max(width, height) / max;
      width = Math.floor(width / downscale);
      height = Math.floor(height / downscale);
    }
    if (data.kind === "rgb16-linear") {
      const base = gpu.target(width, height, "rgba16f", { mipmaps: true });
      const staging = gpu.texture(data.width, data.height, "rgb16ui", data.data);
      if (downscale === 1) gpu.pass("source-rgb16", S.sourceRgb16, { target: base, textures: { uSource: staging }, uniforms: { uWhite: data.white } });
      else
        gpu.pass("source-rgb16-box", S.sourceRgb16Box, {
          target: base,
          textures: { uSource: staging },
          uniforms: { uWhite: data.white, uScale: [data.width / width, data.height / height] },
        });
      gpu.dispose(staging);
      gpu.generateMipmaps(base);
      const size = fullSizeOf(data);
      return { id, base, size, info, downscale: size.width / width };
    } else {
      let image: TexImageSource | ImageData = data.image;
      if (downscale !== 1) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        if (image instanceof ImageData) {
          const tmp = new OffscreenCanvas(image.width, image.height);
          tmp.getContext("2d")!.putImageData(image, 0, 0);
          image = tmp;
        }
        ctx.drawImage(image as CanvasImageSource, 0, 0, width, height);
        image = canvas;
      }
      if (this.srgbSourcesWork()) {
        // Kept as the file's 8-bit sRGB: no staging copy, half the memory of RGBA16F.
        const base8 = gpu.texture(width, height, "srgba8", image as TexImageSource, { mipmaps: true });
        gpu.generateMipmaps(base8);
        const size = fullSizeOf(data);
        return { id, base: base8, srgb: true, size, info, downscale: size.width / width };
      }
      const base = gpu.target(width, height, "rgba16f", { mipmaps: true });
      const staging = gpu.texture(width, height, "srgba8", image as TexImageSource);
      gpu.pass("source-srgb", S.sourceSrgb, { target: base, textures: { uSource: staging } });
      gpu.dispose(staging);
      gpu.generateMipmaps(base);
      const size = fullSizeOf(data);
      return { id, base, size, info, downscale: size.width / width };
    }
  }

  private srgbProbe: boolean | null = null;

  /**
   * Whether this GPU samples 8-bit sRGB textures as linear values and builds their
   * mipmaps in linear light (WebGL2 requires both; a driver that gets it wrong would
   * darken fine detail when zoomed out). Checked once; RGBA16F sources otherwise.
   */
  srgbSourcesWork(): boolean {
    if (this.srgbProbe !== null) return this.srgbProbe;
    const { gpu } = this;
    let ok = false;
    const checker = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) checker.set([...Array(3).fill(((i % 4) + (i >> 2)) % 2 ? 255 : 0), 255], i * 4);
    let a: Texture | null = null;
    let b: Texture | null = null;
    let out: Target | null = null;
    try {
      a = gpu.texture(4, 4, "srgba8", checker, { mipmaps: true });
      gpu.generateMipmaps(a);
      b = gpu.texture(1, 1, "srgba8", new Uint8Array([128, 128, 128, 255]));
      out = gpu.target(2, 1, "rgba16f");
      gpu.pass("srgb-probe", S.srgbProbe, { target: out, textures: { uChecker: a, uGray: b } });
      const v = gpu.readFloat(out);
      // Black/white averaged in linear light is 0.5 (in encoded values it would be 0.21); sRGB 128 is 0.216 linear.
      ok = Math.abs(v[0] - 0.5) < 0.08 && Math.abs(v[4] - 0.2158) < 0.02;
      if (!ok) console.warn("[gpu] 8-bit sRGB textures misbehave on this GPU; photos are kept as RGBA16F.", v[0], v[4]);
    } catch (error) {
      console.warn("[gpu] sRGB texture check failed:", error);
    } finally {
      gpu.dispose(a);
      gpu.dispose(b);
      gpu.dispose(out);
    }
    this.srgbProbe = ok;
    return ok;
  }

  disposeSource(source: GpuSource | null | undefined) {
    if (!source) return;
    this.gpu.dispose(source.base);
    const retouched = this.retouchCache.get(source.id);
    if (retouched?.source === source) {
      this.gpu.dispose(retouched.target);
      this.retouchCache.delete(source.id);
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  /** The source with spot repairs applied (full resolution, mipmapped), cached per spot list. */
  private retouched(source: GpuSource, spots: DevelopRecipe["retouch"]): Texture {
    const hit = this.retouchCache.get(source.id);
    if (!spots.length) {
      if (hit) {
        this.gpu.dispose(hit.target);
        this.retouchCache.delete(source.id);
      }
      return source.base;
    }
    if (hit && hit.source === source && hit.spots === spots) return hit.target;
    const { width, height } = source.base;
    const long = Math.max(width, height);
    let input: Texture = source.base;
    let output: Target | null = null;
    for (let start = 0; start < spots.length; start += 32) {
      const chunk = spots.slice(start, start + 32);
      // Spot repairs keep the source's format (8-bit sRGB sources stay 8-bit).
      const target = this.gpu.target(width, height, source.srgb ? "srgba8" : "rgba16f", { mipmaps: true });
      const pos = new Float32Array(128);
      const params = new Float32Array(128);
      chunk.forEach((s, i) => {
        pos.set([s.x * width, s.y * height, s.sourceX * width, s.sourceY * height], i * 4);
        params.set([s.radius * long, s.feather / 100, s.opacity, s.mode === "clone" ? 1 : 0], i * 4);
      });
      this.gpu.pass("retouch", retouchShader, {
        target,
        textures: { uBase: input },
        uniforms: { uSize: [width, height], uCount: chunk.length, uSpots: pos, uParams: params },
      });
      this.gpu.generateMipmaps(target);
      if (output) this.gpu.dispose(output);
      output = target;
      input = target;
    }
    if (hit) this.gpu.dispose(hit.target);
    this.retouchCache.set(source.id, { source, spots, target: output! });
    // Bound GPU memory: keep the most recent few.
    while (this.retouchCache.size > 4) {
      const [id, oldest] = this.retouchCache.entries().next().value!;
      this.gpu.dispose(oldest.target);
      this.retouchCache.delete(id);
    }
    return output!;
  }

  private curves(recipe: DevelopRecipe): Texture {
    if (this.curveCache?.key === recipe.toneCurve) return this.curveCache.texture;
    if (this.curveCache) this.gpu.dispose(this.curveCache.texture);
    const texture = this.gpu.texture(LUT_SIZE, 1, "rgba16f", toHalfArray(bakeCurves(recipe.toneCurve)));
    this.curveCache = { key: recipe.toneCurve, texture };
    return texture;
  }

  /** Blurs `input` (RGBA) with a Gaussian of `sigma` input texels, downsampling first when sigma is large. */
  blur(input: Texture, sigma: number): Target {
    let current: Texture = input;
    let owned: Target | null = null;
    let s = sigma;
    while (s > 6 && current.width > 8 && current.height > 8) {
      const next = this.acquire(Math.ceil(current.width / 2), Math.ceil(current.height / 2));
      this.gpu.pass("downsample", S.downsample, {
        target: next,
        textures: { uInput: current },
        uniforms: { uTexel: [1 / current.width, 1 / current.height] },
      });
      if (owned) this.release(owned);
      owned = next;
      current = next;
      s /= 2;
    }
    const horizontal = this.acquire(current.width, current.height);
    this.gpu.pass("blur", S.blur, {
      target: horizontal,
      textures: { uInput: current },
      uniforms: { uDirection: [1 / current.width, 0], uSigma: s },
    });
    if (owned) this.release(owned);
    const vertical = this.acquire(current.width, current.height);
    this.gpu.pass("blur", S.blur, {
      target: vertical,
      textures: { uInput: horizontal },
      uniforms: { uDirection: [0, 1 / current.height], uSigma: s },
    });
    this.release(horizontal);
    return vertical;
  }

  private atmosphere(key: string, pyramid: Target): [number, number, number] {
    const hit = this.atmosphereCache.get(key);
    if (hit) return hit;
    // Read back a small level and take a high percentile of the dark channel as the haze color.
    let level: Texture = pyramid;
    const owned: Target[] = [];
    while (level.width > 64 || level.height > 64) {
      const next = this.acquire(Math.ceil(level.width / 2), Math.ceil(level.height / 2));
      this.gpu.pass("downsample", S.downsample, { target: next, textures: { uInput: level }, uniforms: { uTexel: [1 / level.width, 1 / level.height] } });
      owned.push(next);
      level = next;
    }
    const pixels = this.gpu.readFloat(level as Target);
    owned.forEach((t) => this.release(t));
    const dark: number[] = [];
    for (let i = 1; i < pixels.length; i += 4) dark.push(pixels[i]);
    dark.sort((a, b) => a - b);
    const a = Math.min(1.5, Math.max(0.35, dark[Math.floor(dark.length * 0.995)] ?? 1) * 1.05);
    const result: [number, number, number] = [a, a, a];
    if (this.atmosphereCache.size > 16) this.atmosphereCache.clear();
    this.atmosphereCache.set(key, result);
    return result;
  }

  /** The dehaze estimate from a small render of the whole photo (for windowed renders). */
  private wholeAtmosphere(key: string, source: GpuSource, recipe: DevelopRecipe, base: Texture, toSource: Mat3): [number, number, number] {
    const full = outputSize(source.size, recipe.geometry);
    const scale = Math.min(1, 512 / Math.max(full.width, full.height));
    const w = Math.max(8, Math.round(full.width * scale));
    const h = Math.max(8, Math.round(full.height * scale));
    const geometry = this.acquire(w, h);
    this.gpu.pass("geometry", S.geometry, {
      target: geometry,
      textures: { uBase: base },
      uniforms: {
        uOutToSrc: toGlMat3(toSource),
        uSrcSize: [source.size.width, source.size.height],
        uOutSize: [w, h],
        uDistortion: (recipe.optics.distortion / 100) * 0.12,
        uVignetting: (recipe.optics.vignetting / 100) * 1.5,
        uVignettingMid: 1 + ((100 - recipe.optics.vignettingMidpoint) / 100) * 4,
        uLodBias: Math.log2(1 / source.downscale),
        uBaseSrgb: source.srgb ? 1 : 0,
      },
    });
    const prepared = this.acquire(w, h);
    this.gpu.pass("prepare", S.prepare, {
      target: prepared,
      textures: { uInput: geometry },
      uniforms: { uWhiteBalance: toGlMat3(whiteBalanceFor(recipe.whiteBalance, source.info)), uExposure: recipe.basic.exposure },
    });
    this.release(geometry);
    const half = this.acquire(Math.ceil(w / 2), Math.ceil(h / 2));
    this.gpu.pass("lightness", S.lightness, { target: half, textures: { uInput: prepared } });
    this.release(prepared);
    const result = this.atmosphere(key, half);
    this.release(half);
    return result;
  }

  /**
   * Renders `recipe` applied to `source` into a new target of `options.width ×
   * options.height`. The caller releases the returned target.
   */
  render(source: GpuSource, recipe: DevelopRecipe, options: RenderOptions): Target {
    const { gpu } = this;
    const width = Math.max(1, Math.round(options.width));
    const height = Math.max(1, Math.round(options.height));
    const full = outputSize(source.size, recipe.geometry);
    const win = options.window;
    const fullWidth = win?.fullWidth ?? width;
    const fullHeight = win?.fullHeight ?? height;
    // Full-resolution output pixels per working pixel: radii are specified at full resolution.
    const fullScale = full.width / fullWidth;
    // A window maps this render's uv to its part of the whole output.
    const windowUv: [number, number, number, number] | undefined = win ? [win.x / fullWidth, win.y / fullHeight, width / fullWidth, height / fullHeight] : undefined;
    const toSource = outputToSource(source.size, recipe.geometry);
    const outToSrc = toGlMat3(windowUv ? mul3(toSource, [windowUv[2], 0, windowUv[0], 0, windowUv[3], windowUv[1], 0, 0, 1]) : toSource);

    // 1. Spot repairs (cached), then geometry + lens corrections.
    const base = this.retouched(source, recipe.retouch);
    let current = this.acquire(width, height);
    const optics = recipe.optics;
    gpu.pass("geometry", S.geometry, {
      target: current,
      textures: { uBase: base },
      uniforms: {
        uOutToSrc: outToSrc,
        uSrcSize: [source.size.width, source.size.height],
        uOutSize: [width, height],
        uDistortion: (optics.distortion / 100) * 0.12,
        uVignetting: (optics.vignetting / 100) * 1.5,
        uVignettingMid: 1 + ((100 - optics.vignettingMidpoint) / 100) * 4,
        uLodBias: Math.log2(1 / source.downscale),
        uBaseSrgb: source.srgb ? 1 : 0,
      },
    });

    // 2. White balance and exposure.
    const prepared = this.acquire(width, height);
    gpu.pass("prepare", S.prepare, {
      target: prepared,
      textures: { uInput: current },
      uniforms: {
        uWhiteBalance: toGlMat3(whiteBalanceFor(recipe.whiteBalance, source.info)),
        uExposure: recipe.basic.exposure,
      },
    });
    this.release(current);
    current = prepared;

    // 3. Local contrast pyramid: lightness + dark channel at half resolution, blurred at two scales.
    const b = recipe.basic;
    const localContrast = b.texture !== 0 || b.clarity !== 0 || b.dehaze !== 0 || recipe.masks.some((m) => m.visible && (m.adjustments.texture || m.adjustments.clarity || m.adjustments.dehaze));
    let blurSmall: Target | null = null;
    let blurLarge: Target | null = null;
    let atmosphere: [number, number, number] = [1, 1, 1];
    if (localContrast) {
      const half = this.acquire(Math.ceil(width / 2), Math.ceil(height / 2));
      gpu.pass("lightness", S.lightness, { target: half, textures: { uInput: current } });
      const longSide = Math.max(full.width, full.height);
      // Sigmas in full-resolution pixels, converted to half-resolution working texels.
      blurSmall = this.blur(half, Math.max(0.5, (longSide * 0.0025) / fullScale / 2));
      blurLarge = this.blur(half, Math.max(1, (longSide * 0.02) / fullScale / 2));
      if (b.dehaze !== 0 || recipe.masks.some((m) => m.adjustments.dehaze)) {
        const key = `${source.id}:${recipe.whiteBalance.temperature}:${recipe.whiteBalance.tint}:${b.exposure}`;
        // The haze colour is a property of the whole photo: a window estimates it from a small full render.
        atmosphere = this.atmosphereCache.get(key) ?? (win ? this.wholeAtmosphere(key, source, recipe, base, toSource) : this.atmosphere(key, half));
      }
      this.release(half);
    }
    const blank = blurSmall ?? current;

    // 4. Tone and color.
    const toned = this.acquire(width, height);
    const curvesActive = isToneCurveActive(recipe.toneCurve);
    gpu.pass("tone", S.toneAndColor, {
      target: toned,
      textures: {
        uInput: current,
        uBlurSmall: blurSmall ?? blank,
        uBlurLarge: blurLarge ?? blank,
        uCurves: curvesActive ? this.curves(recipe) : null,
      },
      uniforms: {
        uHighlights: b.highlights,
        uShadows: b.shadows,
        uWhites: b.whites,
        uBlacks: b.blacks,
        uContrast: b.contrast,
        uTexture: b.texture / 100,
        uClarity: b.clarity / 100,
        uDehaze: b.dehaze / 100,
        uAtmosphere: atmosphere,
        uVibrance: b.vibrance,
        uSaturation: b.saturation,
        uProfileCurve: source.info.raw ? 1 : 0,
        uMonochrome: recipe.profile === "monochrome" ? 1 : 0,
        uCurvesActive: curvesActive ? 1 : 0,
        uMixerActive: isMixerActive(recipe.colorMixer) ? 1 : 0,
        uMixer: mixerUniform(recipe.colorMixer),
        uGradingActive: isGradingActive(recipe.colorGrading) ? 1 : 0,
        ...gradingUniforms(recipe.colorGrading),
      },
    });
    this.release(current);
    current = toned;

    // 5. Masks with local adjustments.
    if (options.masks && recipe.masks.some((m) => m.components.length)) {
      const next = options.masks(current, {
        pipeline: this,
        source,
        recipe,
        outToSrc,
        fullScale,
        window: windowUv,
        blurSmall: blurSmall ?? current,
        blurLarge: blurLarge ?? current,
        width,
        height,
      });
      if (next !== current) {
        this.release(current);
        current = next;
      }
    }
    this.release(blurSmall);
    this.release(blurLarge);

    // 6. Detail: noise reduction, then sharpening. Radii are in full-resolution pixels.
    const d = recipe.detail;
    if (!options.draft && (d.noiseLuminance > 0 || d.noiseColor > 0)) {
      const next = this.acquire(width, height);
      gpu.pass("denoise", S.denoise, {
        target: next,
        textures: { uInput: current },
        uniforms: {
          uLuma: d.noiseLuminance / 100,
          uLumaDetail: d.noiseDetail / 100,
          uChroma: d.noiseColor / 100,
          uStride: Math.max(0.5, 1.5 / fullScale),
        },
      });
      this.release(current);
      current = next;
    }
    const sigma = d.sharpenRadius / fullScale;
    if (!options.draft && d.sharpenAmount > 0 && sigma >= 0.25) {
      const next = this.acquire(width, height);
      gpu.pass("sharpen", S.sharpen, {
        target: next,
        textures: { uInput: current },
        uniforms: {
          uAmount: (d.sharpenAmount / 100) * 1.6,
          uSigma: Math.max(0.5, sigma),
          uDetail: d.sharpenDetail / 100,
          uMasking: d.sharpenMasking / 100,
        },
      });
      this.release(current);
      current = next;
    }

    // 7. Effects.
    const e = recipe.effects;
    if (e.vignetteAmount !== 0 || e.grainAmount > 0) {
      const next = this.acquire(width, height);
      gpu.pass("effects", S.effects, {
        target: next,
        textures: { uInput: current },
        uniforms: {
          uOutSize: [fullWidth, fullHeight],
          uOrigin: [win?.x ?? 0, win?.y ?? 0],
          uFullScale: fullScale,
          uVignette: e.vignetteAmount / 100,
          uVigMid: e.vignetteMidpoint / 100,
          uVigRound: e.vignetteRoundness / 100,
          uVigFeather: e.vignetteFeather / 100,
          uGrain: e.grainAmount / 100,
          uGrainSize: e.grainSize / 100,
          uGrainRough: e.grainRoughness / 100,
        },
      });
      this.release(current);
      current = next;
    }
    return current;
  }

  /**
   * Linear pixels of the source (before any adjustment) resampled to a small
   * grid, for white balance estimation. `region` is in source uv.
   */
  sampleSource(source: GpuSource, width: number, height: number, region = { x: 0, y: 0, width: 1, height: 1 }): Float32Array {
    const target = this.acquire(width, height);
    const m = toGlMat3([region.width, 0, region.x, 0, region.height, region.y, 0, 0, 1]);
    this.gpu.pass("geometry", S.geometry, {
      target,
      textures: { uBase: source.base },
      uniforms: {
        uOutToSrc: m,
        uSrcSize: [source.size.width, source.size.height],
        uOutSize: [width, height],
        uDistortion: 0,
        uVignetting: 0,
        uVignettingMid: 1,
        uLodBias: 0,
        uBaseSrgb: source.srgb ? 1 : 0,
      },
    });
    const pixels = this.gpu.readFloat(target);
    this.release(target);
    return pixels;
  }

  /**
   * Applies a look (tone, curves, color) to a linear Rec.2020 image: used by
   * composite adjustment layers. Local-contrast controls are not part of looks.
   */
  applyLook(input: Target, look: Pick<DevelopRecipe, "basic" | "toneCurve" | "colorMixer" | "colorGrading" | "profile">): Target {
    const { gpu } = this;
    const prepared = this.acquire(input.width, input.height);
    gpu.pass("prepare", S.prepare, {
      target: prepared,
      textures: { uInput: input },
      uniforms: { uWhiteBalance: toGlMat3([1, 0, 0, 0, 1, 0, 0, 0, 1]), uExposure: look.basic.exposure },
    });
    const out = this.acquire(input.width, input.height);
    const b = look.basic;
    const curvesActive = isToneCurveActive(look.toneCurve);
    gpu.pass("tone", S.toneAndColor, {
      target: out,
      textures: { uInput: prepared, uBlurSmall: prepared, uBlurLarge: prepared, uCurves: curvesActive ? this.curves(look as DevelopRecipe) : null },
      uniforms: {
        uHighlights: b.highlights,
        uShadows: b.shadows,
        uWhites: b.whites,
        uBlacks: b.blacks,
        uContrast: b.contrast,
        uTexture: 0,
        uClarity: 0,
        uDehaze: 0,
        uAtmosphere: [1, 1, 1],
        uVibrance: b.vibrance,
        uSaturation: b.saturation,
        uProfileCurve: 0,
        uMonochrome: look.profile === "monochrome" ? 1 : 0,
        uCurvesActive: curvesActive ? 1 : 0,
        uMixerActive: isMixerActive(look.colorMixer) ? 1 : 0,
        uMixer: mixerUniform(look.colorMixer),
        uGradingActive: isGradingActive(look.colorGrading) ? 1 : 0,
        ...gradingUniforms(look.colorGrading),
      },
    });
    this.release(prepared);
    return out;
  }

  /** The recipe as it would be for an unedited photo, keeping the geometry (for Before views). */
  static beforeRecipe(recipe: DevelopRecipe, info: SourceColorInfo): DevelopRecipe {
    return { ...createDefaultRecipe(info), geometry: recipe.geometry };
  }

  /** Display-encoded RGBA8 pixels of a rendered target, rows top-first. */
  /** Working-space image → display-encoded RGBA pixels (top row first). */
  encode(input: Texture, width = input.width, height = input.height): Uint8ClampedArray {
    const target = this.acquire(width, height, "rgba8");
    this.gpu.pass("encode", S.encode, { target, textures: { uImage: input } });
    const pixels = this.gpu.readImage(target).data;
    this.release(target);
    return pixels;
  }

}
