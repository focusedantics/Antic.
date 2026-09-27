import { createDefaultRecipe, type SourceColorInfo } from "@/core/develop/defaults";
import { outputToSource, outputSize, type Size } from "@/core/develop/geometry";
import type { DevelopRecipe } from "@/core/develop/recipe";
import { whiteBalanceFor } from "@/core/develop/white-balance";
import { toGlMat3 } from "@/lib/math";
import { bakeCurves, isToneCurveActive, LUT_SIZE, toHalfArray } from "./curves";
import type { Gpu, Target, Texture, TextureFormat } from "./gl";
import { gradingUniforms, isGradingActive, isMixerActive, mixerUniform } from "./mixer";
import * as S from "./shaders/passes";

/** Decoded pixels ready for upload. */
export type SourceData =
  | { readonly kind: "rgb16-linear"; readonly width: number; readonly height: number; readonly data: Uint16Array; readonly white: number }
  | { readonly kind: "image"; readonly image: ImageBitmap | OffscreenCanvas | ImageData; readonly width: number; readonly height: number };

/** A photo on the GPU: linear Rec.2020 RGBA16F with mipmaps. */
export type GpuSource = {
  readonly id: string;
  readonly base: Texture;
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
};

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
};

/**
 * Develops a photo according to a recipe. Stateless apart from caches: the same
 * source and recipe always produce the same pixels at a given size.
 */
export class DevelopPipeline {
  private pool = new Map<string, Target[]>();
  private leased = new Set<Target>();
  private curveCache: { key: DevelopRecipe["toneCurve"]; texture: Texture } | null = null;
  private atmosphereCache = new Map<string, [number, number, number]>();

  constructor(readonly gpu: Gpu) {}

  // ─── Targets ─────────────────────────────────────────────────────────────

  acquire(width: number, height: number, format: TextureFormat = "rgba16f"): Target {
    const key = `${Math.round(width)}x${Math.round(height)}:${format}`;
    const list = this.pool.get(key);
    const target = list?.pop() ?? this.gpu.target(width, height, format);
    this.leased.add(target);
    return target;
  }

  release(target: Target | null | undefined) {
    if (!target || !this.leased.has(target)) return;
    this.leased.delete(target);
    const key = `${target.width}x${target.height}:${target.format}`;
    const list = this.pool.get(key) ?? [];
    list.push(target);
    this.pool.set(key, list);
  }

  /** Frees pooled targets of sizes no longer in use. */
  trim() {
    for (const list of this.pool.values()) for (const t of list) this.gpu.dispose(t);
    this.pool.clear();
  }

  // ─── Sources ─────────────────────────────────────────────────────────────

  upload(id: string, data: SourceData, info: SourceColorInfo): GpuSource {
    const { gpu } = this;
    const max = gpu.maxTextureSize;
    let width = data.width;
    let height = data.height;
    let downscale = 1;
    if (width > max || height > max) {
      downscale = Math.max(width, height) / max;
      width = Math.floor(width / downscale);
      height = Math.floor(height / downscale);
    }
    const base = gpu.target(width, height, "rgba16f", { mipmaps: true });
    if (data.kind === "rgb16-linear") {
      if (downscale !== 1) throw new Error("RAW larger than the GPU texture limit");
      const staging = gpu.texture(data.width, data.height, "rgb16ui", data.data);
      gpu.pass("source-rgb16", S.sourceRgb16, { target: base, textures: { uSource: staging }, uniforms: { uWhite: data.white } });
      gpu.dispose(staging);
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
      const staging = gpu.texture(width, height, "srgba8", image as TexImageSource);
      gpu.pass("source-srgb", S.sourceSrgb, { target: base, textures: { uSource: staging } });
      gpu.dispose(staging);
    }
    gpu.generateMipmaps(base);
    return { id, base, size: { width: data.width, height: data.height }, info, downscale };
  }

  disposeSource(source: GpuSource | null | undefined) {
    if (source) this.gpu.dispose(source.base);
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

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

  /**
   * Renders `recipe` applied to `source` into a new target of `options.width ×
   * options.height`. The caller releases the returned target.
   */
  render(source: GpuSource, recipe: DevelopRecipe, options: RenderOptions): Target {
    const { gpu } = this;
    const width = Math.max(1, Math.round(options.width));
    const height = Math.max(1, Math.round(options.height));
    const full = outputSize(source.size, recipe.geometry);
    // Full-resolution output pixels per working pixel: radii are specified at full resolution.
    const fullScale = full.width / width;
    const outToSrc = toGlMat3(outputToSource(source.size, recipe.geometry));

    // 1. Geometry + lens corrections.
    let current = this.acquire(width, height);
    const optics = recipe.optics;
    gpu.pass("geometry", S.geometry, {
      target: current,
      textures: { uBase: source.base },
      uniforms: {
        uOutToSrc: outToSrc,
        uSrcSize: [source.size.width, source.size.height],
        uOutSize: [width, height],
        uDistortion: (optics.distortion / 100) * 0.12,
        uVignetting: (optics.vignetting / 100) * 1.5,
        uVignettingMid: 1 + ((100 - optics.vignettingMidpoint) / 100) * 4,
        uLodBias: Math.log2(1 / source.downscale),
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
        atmosphere = this.atmosphere(key, half);
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
          uOutSize: [width, height],
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
      },
    });
    const pixels = this.gpu.readFloat(target);
    this.release(target);
    return pixels;
  }

  /** The recipe as it would be for an unedited photo, keeping the geometry (for Before views). */
  static beforeRecipe(recipe: DevelopRecipe, info: SourceColorInfo): DevelopRecipe {
    return { ...createDefaultRecipe(info), geometry: recipe.geometry };
  }

  /** Display-encoded RGBA8 pixels of a rendered target, rows top-first. */
  encode(input: Texture, width = input.width, height = input.height): Uint8Array {
    const target = this.acquire(width, height, "rgba8");
    this.gpu.pass("encode", S.encode, { target, textures: { uImage: input } });
    const pixels = this.gpu.readRgba8(target);
    this.release(target);
    return pixels;
  }
}
