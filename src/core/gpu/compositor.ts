import { recipeFor } from "@/core/develop/session";
import { outputSize } from "@/core/develop/geometry";
import type { DevelopRecipe, Mask } from "@/core/develop/recipe";
import { canvasToContent } from "@/core/document/operations";
import { DEFAULT_ANIMATION, docAnimation } from "@/core/document/animation";
import type { AdjustmentLayer, BlendMode, CompositeDocument, EffectLayer, GradientLayer, Layer, ShapeLayer, TextLayer } from "@/core/document/model";
import { EffectRunner } from "@/core/effects/runtime";
import { drawText, fontShorthand } from "@/core/text/draw";
import { ensureFont, fontLoads } from "@/core/text/fonts";
import { BLEND_MODES } from "@/core/document/model";
import { type Mat3, mul3, toGlMat3 } from "@/lib/math";
import type { Gpu, Target, Texture } from "./gl";
import type { MaskRenderer } from "./masks";
import type { DevelopPipeline, GpuSource } from "./pipeline";
import * as C from "./shaders/composite";

const blendIndex = new Map<BlendMode, number>(BLEND_MODES.map((b, i) => [b.id, i]));
/** Photoshop's "special eight": fill opacity fades the blend effect instead of the layer. */
const SPECIAL = new Set<BlendMode>(["color-burn", "linear-burn", "color-dodge", "linear-dodge", "linear-light", "hard-mix", "difference", "vivid-light"]);

const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

type Cached = { key: string; texture: Texture; used: number };

/** Provides decoded photos; returns null while one is still loading. */
export type SourceProvider = (assetId: string) => GpuSource | null;

/**
 * Renders a composite document. Layers are placed and blended on the GPU in
 * paint order; groups render in isolation; clipped layers only show where
 * their base layer is; adjustment layers re-grade everything below them.
 */
export class Compositor {
  private contents = new Map<string, Cached>();
  private frame = 0;
  /** Seconds into the document's animation loop for the render in progress. */
  private time = 0;
  private loop = DEFAULT_ANIMATION.duration;
  private readonly effects: EffectRunner;

  constructor(
    private readonly gpu: Gpu,
    private readonly pipeline: DevelopPipeline,
    private readonly masks: MaskRenderer,
    private readonly sources: SourceProvider,
  ) {
    this.effects = new EffectRunner(gpu, pipeline);
  }

  /**
   * Renders `doc` at `scale` working pixels per document pixel, with animated
   * effects at `time` seconds into the loop. The caller releases the result.
   */
  render(doc: CompositeDocument, scale: number, time = 0): Target {
    this.frame++;
    this.loop = docAnimation(doc).duration;
    this.time = time;
    const width = Math.max(1, Math.round(doc.width * scale));
    const height = Math.max(1, Math.round(doc.height * scale));
    const backdrop = this.pipeline.acquire(width, height);
    const bg = doc.background ? [...hexToRgb(doc.background), 1] : [0, 0, 0, 0];
    this.gpu.pass("solid", C.solid, { target: backdrop, uniforms: { uColor: bg } });
    const result = this.renderList(doc.layers, backdrop, scale, doc);
    this.evict();
    return result;
  }

  private renderList(layers: readonly Layer[], backdrop: Target, scale: number, doc: CompositeDocument): Target {
    let current = backdrop;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.clip && i > 0) continue; // drawn with its base
      // Clipped layers directly above this one.
      const clipped: Layer[] = [];
      for (let j = i + 1; j < layers.length && layers[j].clip; j++) clipped.push(layers[j]);
      if (!layer.visible) continue;
      if (layer.kind === "adjustment") {
        current = this.adjust(current, layer, scale);
        continue;
      }
      if (layer.kind === "effect") {
        current = this.effect(current, layer, scale, doc, false);
        continue;
      }
      let content = this.layerContent(layer, current.width, current.height, scale, doc);
      if (!content) continue;
      for (const c of clipped) {
        if (!c.visible) continue;
        if (c.kind === "adjustment") {
          content = this.adjust(content, c, scale);
          continue;
        }
        if (c.kind === "effect") {
          content = this.effect(content, c, scale, doc, true);
          continue;
        }
        const cc = this.layerContent(c, current.width, current.height, scale, doc);
        if (!cc) continue;
        content = this.blend(content, cc, c, true);
      }
      current = this.blend(current, content, layer, false);
    }
    return current;
  }

  /** Blends `source` onto `backdrop` (both premultiplied), releasing both inputs. */
  private blend(backdrop: Target, source: Target, layer: Layer, atop: boolean): Target {
    const out = this.pipeline.acquire(backdrop.width, backdrop.height);
    const special = SPECIAL.has(layer.blend);
    this.gpu.pass("blend", C.blend, {
      target: out,
      textures: { uBackdrop: backdrop, uSource: source },
      uniforms: {
        uMode: blendIndex.get(layer.blend) ?? 0,
        uOpacity: layer.opacity,
        uSpecialFill: special ? layer.fillOpacity : 1,
        uAtop: atop ? 1 : 0,
      },
    });
    this.pipeline.release(backdrop);
    this.pipeline.release(source);
    return out;
  }

  /** Working px → document px → content uv. */
  private toContent(layer: Layer, scale: number): Mat3 {
    return mul3(canvasToContent(layer.transform), [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1]);
  }

  /** Content pixel size needed to show `layer` at `scale` without upscaling. */
  private contentSize(layer: Layer, scale: number, max = 4096) {
    const quantize = (v: number) => Math.max(8, Math.min(max, Math.round(2 ** (Math.ceil(Math.log2(Math.max(1, v)) * 4) / 4))));
    return { width: quantize(layer.transform.width * scale), height: quantize(layer.transform.height * scale) };
  }

  /** One layer rendered into a canvas-sized premultiplied target, or null while loading. */
  private layerContent(layer: Layer, width: number, height: number, scale: number, doc: CompositeDocument): Target | null {
    const toContent = this.toContent(layer, scale);
    let texture: Texture | null = null;
    let kind = 0;
    let groupTarget: Target | null = null;
    const uniforms: Record<string, number | number[] | Float32Array> = {};
    switch (layer.kind) {
      case "image":
        texture = this.imageContent(layer, scale);
        if (!texture) return null;
        break;
      case "text":
        texture = this.rasterContent(layer, scale);
        break;
      case "shape":
        texture = this.rasterContent(layer, scale);
        break;
      case "gradient":
        kind = 1;
        Object.assign(uniforms, gradientUniforms(layer));
        break;
      case "fill":
        kind = 2;
        uniforms.uColor = [...hexToRgb(layer.color), 1];
        break;
      case "group": {
        const empty = this.pipeline.acquire(width, height);
        this.gpu.pass("solid", C.solid, { target: empty, uniforms: { uColor: [0, 0, 0, 0] } });
        groupTarget = this.renderList(layer.children, empty, scale, doc);
        break;
      }
      case "adjustment":
      case "effect":
        return null;
    }
    const mask = layer.mask?.enabled && layer.mask.components.length ? this.layerMask(layer, texture, scale) : null;
    const out = this.pipeline.acquire(width, height);
    if (groupTarget) {
      // Groups: the group's mask applies in canvas space (its content box is the canvas).
      this.gpu.pass("place", C.place, {
        target: out,
        textures: { uContent: groupTarget, uMask: mask },
        uniforms: {
          uToContent: toGlMat3([1 / width, 0, 0, 0, 1 / height, 0, 0, 0, 1]),
          uCrop: [0, 0, 1, 1],
          uKind: 0,
          uMaskOn: mask ? 1 : 0,
          uMaskInvert: layer.mask?.invert ? 1 : 0,
          uMaskDensity: layer.mask?.density ?? 1,
          uFill: 1,
        },
      });
      this.pipeline.release(groupTarget);
    } else {
      this.gpu.pass("place", C.place, {
        target: out,
        textures: { uContent: texture, uMask: mask },
        uniforms: {
          uToContent: toGlMat3(toContent),
          uCrop: [layer.crop.left, layer.crop.top, layer.crop.right, layer.crop.bottom],
          uKind: kind,
          uMaskOn: mask ? 1 : 0,
          uMaskInvert: layer.mask?.invert ? 1 : 0,
          uMaskDensity: layer.mask?.density ?? 1,
          uFill: SPECIAL.has(layer.blend) ? 1 : layer.fillOpacity,
          ...uniforms,
        },
      });
    }
    if (mask) this.pipeline.release(mask as Target);
    return out;
  }

  private cache(key: string, id: string, make: () => Texture): Texture {
    const hit = this.contents.get(id);
    if (hit && hit.key === key) {
      hit.used = this.frame;
      return hit.texture;
    }
    if (hit) this.gpu.dispose(hit.texture);
    const texture = make();
    this.contents.set(id, { key, texture, used: this.frame });
    return texture;
  }

  /** Drops cached content no longer used by recent frames. */
  private evict() {
    for (const [id, c] of this.contents) {
      if (this.frame - c.used > 30) {
        this.gpu.dispose(c.texture);
        this.contents.delete(id);
      }
    }
  }

  private recipeOf(layer: Extract<Layer, { kind: "image" }>): DevelopRecipe | null {
    return layer.develop === "asset" ? recipeFor(layer.assetId) : layer.develop;
  }

  private imageContent(layer: Extract<Layer, { kind: "image" }>, scale: number): Texture | null {
    const source = this.sources(layer.assetId);
    const recipe = this.recipeOf(layer);
    if (!source || !recipe) return null;
    const full = outputSize(source.size, recipe.geometry);
    const want = this.contentSize(layer, scale, Math.min(4096, Math.max(full.width, full.height)));
    const key = `${source.id}:${JSON.stringify(recipe)}:${want.width}x${want.height}:${source.base.width}`;
    return this.cache(key, layer.id, () => {
      const developed = this.pipeline.render(source, recipe, { width: want.width, height: want.height, masks: (input, ctx) => this.masks.stage(input, ctx, null, "offscreen") });
      const out = this.gpu.target(want.width, want.height, "rgba16f", { mipmaps: true });
      this.gpu.pass("to-display-straight", C.toDisplayStraight, { target: out, textures: { uInput: developed } });
      this.gpu.generateMipmaps(out);
      this.pipeline.release(developed);
      return out;
    });
  }

  private rasterContent(layer: TextLayer | ShapeLayer, scale: number): Texture {
    const size = this.contentSize(layer, scale);
    let key = `${JSON.stringify(layer.style)}:${layer.transform.width}x${layer.transform.height}:${size.width}x${size.height}`;
    let phase = 0;
    if (layer.kind === "text") {
      // Redraw once a font finishes loading, and every frame while the text moves.
      ensureFont(fontShorthand(layer.style));
      key += `:f${fontLoads.getState().generation}`;
      if (layer.style.motion && layer.style.motion.kind !== "none") {
        phase = (((this.time / this.loop) % 1) + 1) % 1;
        key += `:t${phase.toFixed(4)}`;
      }
    }
    return this.cache(key, layer.id, () => {
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext("2d")!;
      const sx = size.width / layer.transform.width;
      const sy = size.height / layer.transform.height;
      ctx.scale(sx, sy);
      if (layer.kind === "text") drawText(ctx, layer.style, layer.transform.width, layer.transform.height, phase, this.loop);
      else drawShape(ctx, layer, layer.transform.width, layer.transform.height);
      const texture = this.gpu.texture(size.width, size.height, "rgba8", canvas, { mipmaps: true });
      this.gpu.generateMipmaps(texture);
      return texture;
    });
  }

  /** Layer mask coverage at the content's resolution (content uv space). */
  private layerMask(layer: Layer, content: Texture | null, scale: number): Texture {
    const size = layer.kind === "group" ? { width: 1024, height: 1024 } : this.contentSize(layer, scale, 2048);
    const mask = { id: layer.id, components: layer.mask!.components } as unknown as Mask;
    const identity = toGlMat3([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const image = content ?? this.pipeline.acquire(8, 8);
    const coverage = this.masks.coverage(mask, image, {
      pipeline: this.pipeline,
      source: { id: layer.id, base: image, size: { width: layer.transform.width, height: layer.transform.height }, info: { raw: false }, downscale: 1 },
      recipe: null as never,
      outToSrc: identity,
      fullScale: 1,
      blurSmall: image,
      blurLarge: image,
      width: size.width,
      height: size.height,
    });
    if (!content) this.pipeline.release(image as Target);
    return coverage;
  }

  /** Re-grades `input` (premultiplied display) with an adjustment layer; alpha is preserved. */
  private adjust(input: Target, layer: AdjustmentLayer, scale: number): Target {
    const linear = this.pipeline.acquire(input.width, input.height);
    this.gpu.pass("display-to-linear", C.displayToLinear, { target: linear, textures: { uInput: input } });
    const adjusted = this.pipeline.applyLook(linear, layer.adjustment);
    this.pipeline.release(linear);
    const mask = layer.mask?.enabled && layer.mask.components.length ? this.layerMask(layer, null, scale) : null;
    const out = this.pipeline.acquire(input.width, input.height);
    this.gpu.pass("linear-to-display-mix", C.linearToDisplayMix, {
      target: out,
      textures: { uAdjusted: adjusted, uOriginal: input, uMask: mask },
      uniforms: {
        uToContent: toGlMat3(this.toContent(layer, scale)),
        uMaskOn: mask ? 1 : 0,
        uMaskInvert: layer.mask?.invert ? 1 : 0,
        uMaskDensity: layer.mask?.density ?? 1,
        uOpacity: layer.opacity,
      },
    });
    if (mask) this.pipeline.release(mask as Target);
    this.pipeline.release(adjusted);
    this.pipeline.release(input);
    return out;
  }

  /**
   * Runs an effect layer on `input` (everything below it, or its clipping base)
   * and blends the result back with the layer's mode, opacity and mask.
   */
  private effect(input: Target, layer: EffectLayer, scale: number, doc: CompositeDocument, atop: boolean): Target {
    const unit = (Math.max(doc.width, doc.height) * scale) / 1000;
    let result = this.effects.apply(input, layer.effect, unit, this.time, this.loop);
    const mask = layer.mask?.enabled && layer.mask.components.length ? this.layerMask(layer, null, scale) : null;
    const fill = SPECIAL.has(layer.blend) ? 1 : layer.fillOpacity;
    if (mask || fill < 1) {
      const masked = this.pipeline.acquire(input.width, input.height);
      this.gpu.pass("mask-content", C.maskContent, {
        target: masked,
        textures: { uInput: result, uMask: mask },
        uniforms: {
          uToContent: toGlMat3(this.toContent(layer, scale)),
          uMaskOn: mask ? 1 : 0,
          uMaskInvert: layer.mask?.invert ? 1 : 0,
          uMaskDensity: layer.mask?.density ?? 1,
          uFill: fill,
        },
      });
      this.pipeline.release(result);
      if (mask) this.pipeline.release(mask as Target);
      result = masked;
    }
    return this.blend(input, result, layer, atop);
  }

  /** Forgets cached layer content, e.g. when a mask raster finished loading. */
  dispose() {
    for (const c of this.contents.values()) this.gpu.dispose(c.texture);
    this.contents.clear();
    this.effects.dispose();
  }
}

function gradientUniforms(layer: GradientLayer) {
  const g = layer.gradient;
  const rad = (g.angle * Math.PI) / 180;
  const offsets = new Float32Array(16);
  const colors = new Float32Array(64);
  g.stops.slice(0, 16).forEach((s, i) => {
    offsets[i] = s.offset;
    const [r, gg, b] = hexToRgb(s.color);
    colors.set([r, gg, b, s.opacity], i * 4);
  });
  return {
    uGradType: g.type === "radial" ? 1 : 0,
    uGradDir: [Math.cos(rad), Math.sin(rad)],
    uGradScale: g.scale,
    uGradOffset: [g.offsetX, g.offsetY],
    uGradAspect: layer.transform.width / layer.transform.height,
    uGradReverse: g.reverse ? 1 : 0,
    uStopCount: Math.min(16, g.stops.length),
    uStopOffsets: offsets,
    uStopColors: colors,
  };
}

function drawShape(ctx: OffscreenCanvasRenderingContext2D, layer: ShapeLayer, w: number, h: number) {
  const s = layer.style;
  const inset = s.strokeWidth / 2;
  ctx.beginPath();
  if (s.shape === "ellipse") ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
  else ctx.roundRect(inset, inset, Math.max(0, w - s.strokeWidth), Math.max(0, h - s.strokeWidth), Math.min(s.radius, w / 2, h / 2));
  ctx.globalAlpha = s.fillOpacity;
  ctx.fillStyle = s.fill;
  ctx.fill();
  if (s.strokeWidth > 0) {
    ctx.globalAlpha = 1;
    ctx.lineWidth = s.strokeWidth;
    ctx.strokeStyle = s.stroke;
    ctx.stroke();
  }
}

