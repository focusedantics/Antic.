import type { Gpu, Target, Texture } from "@/core/gpu/gl";
import type { DevelopPipeline } from "@/core/gpu/pipeline";
import { effectById } from "./registry";
import { type EffectContext, type EffectInstance, paramUniforms, sanitizeParams } from "./types";

const copy = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
void main() { outColor = texture(uInput, vUv); }`;

const GLYPH_W = 40;
const GLYPH_H = 64;
const GRID = 16;

type Atlas = { texture: Texture; uniforms: { uGlyphGrid: number[]; uGlyphCount: number } };

/**
 * Runs effects on the GPU. The input is copied into a mipmapped texture so
 * effects can average whole cells with a single lookup; glyph atlases for the
 * text effects are drawn once with the platform's monospace font and cached.
 */
export class EffectRunner {
  private mip: Target | null = null;
  private atlases = new Map<string, Atlas>();

  constructor(
    private readonly gpu: Gpu,
    private readonly pipeline: DevelopPipeline,
  ) {}

  /**
   * Applies `effect` to `input` (premultiplied display color). `unit` is the
   * number of working pixels per effect unit (1/1000 of the document's long side).
   * Returns a new pooled target the caller releases.
   */
  apply(input: Texture, effect: EffectInstance, unit: number): Target {
    const { width, height } = input;
    const def = effectById(effect.id);
    if (!this.mip || this.mip.width !== width || this.mip.height !== height) {
      this.gpu.dispose(this.mip);
      this.mip = this.gpu.target(width, height, "rgba16f", { mipmaps: true });
    }
    const mip = this.mip;
    this.gpu.pass("fx-copy", copy, { target: mip, textures: { uInput: input } });
    if (!def) {
      const out = this.pipeline.acquire(width, height);
      this.gpu.pass("fx-copy", copy, { target: out, textures: { uInput: mip } });
      return out;
    }
    this.gpu.generateMipmaps(mip);
    const params = sanitizeParams(def, effect.params);
    const base = {
      uSize: [width, height],
      uUnit: Math.max(unit, 0.05),
      uSeed: typeof params.seed === "number" ? params.seed : 0,
      uMaxLod: Math.floor(Math.log2(Math.max(width, height))),
    };
    const ctx: EffectContext = {
      input: mip,
      width,
      height,
      unit: base.uUnit,
      pass: (key, fragment, uniforms, textures) => {
        const out = this.pipeline.acquire(width, height);
        this.gpu.pass(key, fragment, { target: out, uniforms: { ...base, ...uniforms }, textures: { uInput: mip, ...textures } });
        return out;
      },
      blur: (texture, sigma) => this.pipeline.blur(texture, sigma),
      glyphs: (charset, sort) => this.atlas(charset, sort),
      release: (target) => this.pipeline.release(target),
    };
    return def.render(ctx, paramUniforms(def, params), params);
  }

  private atlas(charset: string, sort: boolean): Atlas {
    const key = `${sort ? 1 : 0}:${charset}`;
    const hit = this.atlases.get(key);
    if (hit) {
      // Keep recently used atlases at the end of the map.
      this.atlases.delete(key);
      this.atlases.set(key, hit);
      return hit;
    }
    const chars = [...charset].slice(0, 256);
    const rows = Math.max(1, Math.ceil(chars.length / GRID));
    const canvas = new OffscreenCanvas(GLYPH_W * GRID, GLYPH_H * rows);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const cell = new OffscreenCanvas(GLYPH_W, GLYPH_H);
    const cctx = cell.getContext("2d", { willReadFrequently: true })!;
    const font = (size: number) => `700 ${size}px "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", ui-monospace, monospace`;
    const drawn = chars.map((ch) => {
      cctx.clearRect(0, 0, GLYPH_W, GLYPH_H);
      let size = 54;
      cctx.font = font(size);
      const w = cctx.measureText(ch).width;
      if (w > GLYPH_W - 4) size = Math.max(12, Math.floor((size * (GLYPH_W - 4)) / w));
      cctx.font = font(size);
      cctx.fillStyle = "#fff";
      cctx.textAlign = "center";
      cctx.textBaseline = "middle";
      cctx.fillText(ch, GLYPH_W / 2, GLYPH_H * 0.54);
      const data = cctx.getImageData(0, 0, GLYPH_W, GLYPH_H).data;
      let ink = 0;
      for (let i = 3; i < data.length; i += 4) ink += data[i];
      return { image: cctx.getImageData(0, 0, GLYPH_W, GLYPH_H), ink };
    });
    // Density ramps go from the emptiest glyph to the fullest.
    const order = sort ? drawn.map((_, i) => i).sort((a, b) => drawn[a].ink - drawn[b].ink) : drawn.map((_, i) => i);
    order.forEach((from, to) => ctx.putImageData(drawn[from].image, (to % GRID) * GLYPH_W, Math.floor(to / GRID) * GLYPH_H));
    const texture = this.gpu.texture(canvas.width, canvas.height, "rgba8", ctx.getImageData(0, 0, canvas.width, canvas.height), { mipmaps: true });
    this.gpu.generateMipmaps(texture);
    const atlas = { texture, uniforms: { uGlyphGrid: [GRID, rows], uGlyphCount: chars.length } };
    this.atlases.set(key, atlas);
    if (this.atlases.size > 12) {
      const [oldest, value] = this.atlases.entries().next().value!;
      this.gpu.dispose(value.texture);
      this.atlases.delete(oldest);
    }
    return atlas;
  }

  dispose() {
    this.gpu.dispose(this.mip);
    this.mip = null;
    for (const a of this.atlases.values()) this.gpu.dispose(a.texture);
    this.atlases.clear();
  }
}
