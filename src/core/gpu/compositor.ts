import { device } from "@/lib/device";
import { recipeFor } from "@/core/develop/session";
import { outputSize } from "@/core/develop/geometry";
import type { DevelopRecipe, Mask } from "@/core/develop/recipe";
import { canvasToContent, layerPaths } from "@/core/document/operations";
import { tracePaths, shapePaths } from "@/core/document/shapes";
import { drawOps } from "@/core/document/paint";
import { tipLoads } from "@/core/document/brush-tips";
import { DEFAULT_ANIMATION, docAnimation } from "@/core/document/animation";
import type { AdjustmentLayer, BlendMode, CompositeDocument, EffectLayer, GradientLayer, Layer, LayerFx, PaintLayer, PaintOp, PathLayer, ShapeLayer, SlotLayer, TextLayer } from "@/core/document/model";
import { EffectRunner } from "@/core/effects/runtime";
import { canvasGradient, drawText, fontShorthand } from "@/core/text/draw";
import { ensureFont, fontLoads } from "@/core/text/fonts";
import { BLEND_MODES } from "@/core/document/model";
import { type Mat3, mul3, toGlMat3 } from "@/lib/math";
import type { Gpu, Target, Texture } from "./gl";
import type { MaskRenderer } from "./masks";
import type { DevelopPipeline, GpuSource } from "./pipeline";
import * as C from "./shaders/composite";

const recipeIds = new WeakMap<object, number>();
let nextRecipeId = 1;
/** A number per recipe object (recipes are immutable, so the same object is the same recipe). */
function recipeKey(recipe: object): number {
  let id = recipeIds.get(recipe);
  if (!id) recipeIds.set(recipe, (id = nextRecipeId++));
  return id;
}

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
  /**
   * Paint layers drawn so far, per layer: a canvas with every op but the newest (the one
   * still being drawn), so a stroke in progress redraws only itself.
   */
  private paints = new Map<string, { width: number; height: number; ops: readonly PaintOp[]; tips: string; base: OffscreenCanvas; out: OffscreenCanvas; scratch: OffscreenCanvas; used: number }>();
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
      const styled = hasFx(layer.fx);
      let content = this.layerContent(layer, current.width, current.height, scale, doc, styled);
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
      if (styled) content = this.styles(content, layer, scale);
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
  private layerContent(layer: Layer, width: number, height: number, scale: number, doc: CompositeDocument, fullFill = false): Target | null {
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
      case "path":
        texture = this.rasterContent(layer, scale);
        break;
      case "slot":
        texture = this.slotContent(layer, scale);
        if (!texture) return null;
        break;
      case "paint":
        texture = this.paintContent(layer, scale);
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
          // Styled layers take their fill opacity in the style pass (styles don't fade with it).
          uFill: SPECIAL.has(layer.blend) || fullFill ? 1 : layer.fillOpacity,
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
    for (const [id, p] of this.paints) if (this.frame - p.used > 30) this.paints.delete(id);
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
    return this.developed(layer.id, source, recipe, want);
  }

  /** A photo developed with `recipe` at `want` pixels, display-encoded, cached under `id`. */
  private developed(id: string, source: GpuSource, recipe: DevelopRecipe, want: { width: number; height: number }): Texture {
    // Recipes are immutable: their identity names their content (serialising one every frame cost
    // milliseconds with long brush strokes).
    const key = `${source.id}:${recipeKey(recipe)}:${want.width}x${want.height}:${source.base.width}`;
    return this.cache(key, id, () => {
      const developed = this.pipeline.render(source, recipe, { width: want.width, height: want.height, masks: (input, ctx) => this.masks.stage(input, ctx, null, "offscreen") });
      // Display-encoded and clipped to 0–1: phones keep it in 8 bits (half the memory), as a JPEG would.
      const out = this.gpu.target(want.width, want.height, device.lite ? "rgba8" : "rgba16f", { mipmaps: true });
      this.gpu.pass("to-display-straight", C.toDisplayStraight, { target: out, textures: { uInput: developed } });
      this.gpu.generateMipmaps(out);
      this.pipeline.release(developed);
      return out;
    });
  }

  /**
   * A photo frame: its photo covering the frame shape (zoomed and panned), or a
   * placeholder while it is empty. Null while the photo loads.
   */
  private slotContent(layer: SlotLayer, scale: number): Texture | null {
    const size = this.contentSize(layer, scale);
    const frameKey = `${JSON.stringify(layer.frame)}:${layer.transform.width}x${layer.transform.height}:${size.width}x${size.height}`;
    const shape = this.cache(`${frameKey}:${layer.assetId ? "mask" : `ph${layer.placeholder}`}`, `${layer.id}:frame`, () => {
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(size.width / layer.transform.width, size.height / layer.transform.height);
      drawSlotFrame(ctx, layer, layer.transform.width, layer.transform.height, !layer.assetId);
      const texture = this.gpu.texture(size.width, size.height, "rgba8", canvas, { mipmaps: true });
      this.gpu.generateMipmaps(texture);
      return texture;
    });
    if (!layer.assetId) return shape;
    const source = this.sources(layer.assetId);
    const recipe = recipeFor(layer.assetId);
    if (!source || !recipe) return null;
    const full = outputSize(source.size, recipe.geometry);
    // The photo covers the frame, times the zoom; it is developed at the size it shows at.
    const boxW = layer.transform.width * scale;
    const boxH = layer.transform.height * scale;
    const cover = Math.max(boxW / full.width, boxH / full.height) * layer.fit.zoom;
    const quantize = (v: number) => Math.max(8, Math.min(4096, Math.max(full.width, full.height), Math.round(2 ** (Math.ceil(Math.log2(Math.max(1, v)) * 4) / 4))));
    const want = { width: quantize(full.width * cover), height: quantize(full.height * cover) };
    const photo = this.developed(`${layer.id}:photo`, source, recipe, want);
    // Photo size in frame widths/heights, and its centre (pan within the room left).
    const pw = (full.width * cover) / boxW;
    const ph = (full.height * cover) / boxH;
    const map = [0.5 + (layer.fit.x * (pw - 1)) / 2, 0.5 + (layer.fit.y * (ph - 1)) / 2, pw, ph];
    const key = `${frameKey}:${layer.assetId}:${recipeKey(recipe)}:${map.map((v) => v.toFixed(5)).join(",")}:${want.width}`;
    return this.cache(key, `${layer.id}:fill`, () => {
      const out = this.gpu.target(size.width, size.height, device.lite ? "rgba8" : "rgba16f", { mipmaps: true });
      this.gpu.pass("slot-fill", C.slotFill, { target: out, textures: { uPhoto: photo, uShape: shape }, uniforms: { uMap: map } });
      this.gpu.generateMipmaps(out);
      return out;
    });
  }

  /**
   * Shadow, glow and outline under a layer's placed content (canvas-sized, premultiplied),
   * made from its alpha. Sizes are document pixels, so they scale with the view.
   */
  private styles(content: Target, layer: Layer, scale: number): Target {
    const fx = layer.fx!;
    const { width, height } = content;
    const blurred = (blur: number) => (blur * scale >= 0.5 ? this.pipeline.blur(content, (blur * scale) / 2) : null);
    const shadow = fx.shadow && fx.shadow.opacity > 0 ? blurred(fx.shadow.blur) : null;
    const glow = fx.glow && fx.glow.opacity > 0 ? blurred(fx.glow.blur) : null;
    let outline: Target | null = null;
    if (fx.outline && fx.outline.opacity > 0 && fx.outline.width * scale >= 0.25) {
      // Halving radii that add up to the width; the first step reads the layer's alpha.
      let remaining = fx.outline.width * scale;
      let input: Texture = content;
      while (remaining > 0.25) {
        const r = remaining > 1.5 ? Math.ceil(remaining / 2) : remaining;
        remaining -= r;
        const next = this.pipeline.acquire(width, height);
        this.gpu.pass("dilate", C.dilate, { target: next, textures: { uInput: input }, uniforms: { uTexel: [1 / width, 1 / height], uRadius: r, uChannel: input === content ? 3 : 0 } });
        if (outline) this.pipeline.release(outline);
        outline = next;
        input = next;
      }
    }
    const rad = ((fx.shadow?.angle ?? 90) * Math.PI) / 180;
    const distance = (fx.shadow?.distance ?? 0) * scale;
    const rgba = (hex: string, a: number) => [...hexToRgb(hex), a];
    const out = this.pipeline.acquire(width, height);
    this.gpu.pass("layer-style", C.layerStyle, {
      target: out,
      textures: { uContent: content, uShadow: shadow ?? content, uGlow: glow ?? content, uOutline: outline ?? content },
      uniforms: {
        // Groups have no fill opacity (as before styles existed).
        uFill: SPECIAL.has(layer.blend) || layer.kind === "group" ? 1 : layer.fillOpacity,
        uShadowOn: fx.shadow && fx.shadow.opacity > 0 ? 1 : 0,
        uShadowColor: rgba(fx.shadow?.color ?? "#000000", fx.shadow?.opacity ?? 0),
        uShadowOffset: [(Math.cos(rad) * distance) / width, (Math.sin(rad) * distance) / height],
        uShadowSpread: fx.shadow?.spread ?? 0,
        uGlowOn: fx.glow && fx.glow.opacity > 0 ? 1 : 0,
        uGlowColor: rgba(fx.glow?.color ?? "#ffffff", fx.glow?.opacity ?? 0),
        uGlowSpread: fx.glow?.spread ?? 0,
        uOutlineOn: outline ? 1 : 0,
        uOutlineColor: rgba(fx.outline?.color ?? "#ffffff", fx.outline?.opacity ?? 0),
      },
    });
    for (const t of [shadow, glow, outline]) if (t) this.pipeline.release(t);
    this.pipeline.release(content);
    return out;
  }

  private rasterContent(layer: TextLayer | ShapeLayer | PathLayer, scale: number): Texture {
    const size = this.contentSize(layer, scale);
    let key = `${JSON.stringify(layer.style)}:${layer.transform.width}x${layer.transform.height}:${size.width}x${size.height}`;
    // Paths are immutable: a drawing's identity names it (it can have thousands of nodes).
    if (layer.kind === "path") key += layer.shape ? `:${JSON.stringify(layer.shape)}` : `:p${recipeKey(layer.paths)}`;
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
      else if (layer.kind === "path") drawPath(ctx, layer, layer.transform.width, layer.transform.height);
      else drawShape(ctx, layer, layer.transform.width, layer.transform.height);
      const texture = this.gpu.texture(size.width, size.height, "rgba8", canvas, { mipmaps: true });
      this.gpu.generateMipmaps(texture);
      return texture;
    });
  }

  private paintContent(layer: PaintLayer, scale: number): Texture {
    const size = this.contentSize(layer, scale);
    const ops = layer.ops;
    // Custom tips draw as round dabs until they load; then the drawing is made again.
    const tips = ops.some((op) => op.type === "stroke" && op.tip) ? `:t${tipLoads.getState().generation}` : "";
    return this.cache(`${size.width}x${size.height}:${recipeKey(ops)}${tips}`, layer.id, () => {
      let entry = this.paints.get(layer.id);
      if (!entry || entry.width !== size.width || entry.height !== size.height) {
        const make = () => new OffscreenCanvas(size.width, size.height);
        entry = { width: size.width, height: size.height, ops: [], tips, base: make(), out: make(), scratch: make(), used: this.frame };
        this.paints.set(layer.id, entry);
      }
      entry.used = this.frame;
      const base = entry.base.getContext("2d", { willReadFrequently: true })!;
      const scratch = entry.scratch.getContext("2d")!;
      // The base holds a prefix of the ops: keep it when the ops still start with it.
      const committed = Math.max(0, ops.length - 1);
      const prefix = entry.ops.length <= committed && entry.ops.every((op, i) => ops[i] === op) && entry.tips === tips;
      entry.tips = tips;
      if (!prefix) {
        base.clearRect(0, 0, size.width, size.height);
        entry.ops = [];
      }
      drawOps(base, scratch, ops.slice(entry.ops.length, committed), size.width, size.height);
      entry.ops = ops.slice(0, committed);
      const out = entry.out.getContext("2d", { willReadFrequently: true })!;
      out.clearRect(0, 0, size.width, size.height);
      out.drawImage(entry.base, 0, 0);
      if (ops.length) drawOps(out, scratch, ops.slice(committed), size.width, size.height);
      const texture = this.gpu.texture(size.width, size.height, "rgba8", entry.out, { mipmaps: true });
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
    this.paints.clear();
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

const hasFx = (fx: LayerFx | undefined): fx is LayerFx => !!fx && ((fx.shadow?.opacity ?? 0) > 0 || (fx.glow?.opacity ?? 0) > 0 || ((fx.outline?.opacity ?? 0) > 0 && (fx.outline?.width ?? 0) > 0));

/** A path layer's fill, then its stroke (kept inside the box: the drawing is inset by half the stroke). */
export function drawPath(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, layer: PathLayer, w: number, h: number) {
  const s = layer.style;
  const stroked = s.stroke !== null && s.strokeWidth > 0;
  const path = new Path2D();
  tracePaths(path, layerPaths(layer), w, h, stroked ? s.strokeWidth / 2 : 0);
  ctx.save();
  if (s.fill !== null && s.fillOpacity > 0) {
    ctx.globalAlpha = s.fillOpacity;
    ctx.fillStyle = s.fillGradient ? canvasGradient(ctx, s.fillGradient, w, h) : s.fill;
    ctx.fill(path, s.fillRule);
  }
  if (stroked && s.strokeOpacity > 0) {
    ctx.globalAlpha = s.strokeOpacity;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineCap = s.cap;
    ctx.lineJoin = s.join;
    ctx.setLineDash(s.dash.map((d) => d * s.strokeWidth));
    ctx.strokeStyle = s.strokeGradient ? canvasGradient(ctx, s.strokeGradient, w, h) : s.stroke!;
    ctx.stroke(path);
  }
  ctx.restore();
}

/** A frame's shape: filled white (the photo's alpha), or as the empty placeholder with a photo sign. */
function drawSlotFrame(ctx: OffscreenCanvasRenderingContext2D, layer: SlotLayer, w: number, h: number, placeholder: boolean) {
  const path = new Path2D();
  tracePaths(path, shapePaths(layer.frame, w / Math.max(1e-6, h)), w, h);
  ctx.fillStyle = placeholder ? layer.placeholder : "#ffffff";
  ctx.fill(path);
  if (!placeholder) return;
  // A small landscape sign in the middle: a sun and two hills.
  const s = Math.min(w, h) * 0.22;
  const n = parseInt(layer.placeholder.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  ctx.save();
  ctx.clip(path);
  ctx.translate(w / 2, h / 2);
  ctx.fillStyle = lum > 128 ? "rgb(0 0 0 / 0.28)" : "rgb(255 255 255 / 0.35)";
  ctx.beginPath();
  ctx.arc(s * 0.28, -s * 0.22, s * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, s * 0.32);
  ctx.lineTo(-s * 0.16, -s * 0.08);
  ctx.lineTo(s * 0.08, s * 0.16);
  ctx.lineTo(s * 0.22, s * 0.04);
  ctx.lineTo(s * 0.5, s * 0.32);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.strokeStyle = ctx.fillStyle;
  ctx.strokeRect(-s * 0.62, -s * 0.5, s * 1.24, s * 0.98);
  ctx.restore();
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

