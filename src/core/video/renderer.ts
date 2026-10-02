import { EffectRunner } from "@/core/effects/runtime";
import type { EffectInstance } from "@/core/effects/types";
import { Gpu, type Target, type Texture } from "@/core/gpu/gl";
import { DevelopPipeline } from "@/core/gpu/pipeline";
import { defaultVisualFx, type VisualFx } from "./model";

const header = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

/**
 * Source frame → working frame: rotation (clockwise, from the track matrix),
 * fit into the output (letterboxed when the aspect differs), then the visual
 * treatments: zoom and shake, mirror and flip, hue, contrast, invert.
 */
const frameIn = `${header}
uniform sampler2D uSource;
uniform int uRotation;
uniform vec2 uFit;
uniform float uZoom;
uniform vec2 uShift;
uniform int uMirror;
uniform int uFlip;
uniform float uHue;
uniform float uContrast;
uniform int uInvert;
vec3 hueRotate(vec3 c, float a) {
  // Rotation about the grey axis (YIQ chroma plane).
  mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYiq * c;
  float s = sin(a), k = cos(a);
  yiq.yz = vec2(yiq.y * k - yiq.z * s, yiq.y * s + yiq.z * k);
  return toRgb * yiq;
}
void main() {
  vec2 uv = (vUv - 0.5) / uZoom + 0.5 + uShift;
  if (uMirror == 1) uv.x = 1.0 - uv.x;
  if (uFlip == 1) uv.y = 1.0 - uv.y;
  uv = (uv - 0.5) / uFit + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 src = uRotation == 90 ? vec2(uv.y, 1.0 - uv.x) : uRotation == 180 ? vec2(1.0 - uv.x, 1.0 - uv.y) : uRotation == 270 ? vec2(1.0 - uv.y, uv.x) : uv;
  vec3 c = texture(uSource, src).rgb;
  if (uHue != 0.0) c = hueRotate(c, uHue);
  if (uContrast > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.0 + uContrast * 1.5);
    c = (c - 0.5) * (1.0 + uContrast * 1.8) + 0.5;
  }
  if (uInvert == 1) c = 1.0 - c;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const mixPass = `${header}
uniform sampler2D uOriginal;
uniform sampler2D uEffect;
uniform float uMix;
void main() {
  outColor = mix(texture(uOriginal, vUv), texture(uEffect, vUv), uMix);
}`;

/** Straight-alpha overlay (the watermark) laid over the frame. */
const overlayPass = `${header}
uniform sampler2D uFrame;
uniform sampler2D uOverlay;
void main() {
  vec4 f = texture(uFrame, vUv);
  vec4 o = texture(uOverlay, vUv);
  outColor = vec4(mix(f.rgb, o.rgb, o.a), 1.0);
}`;

/** Working targets store the top row first; the canvas draws bottom-up, so flip. */
const present = `${header}
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vec2(vUv.x, 1.0 - vUv.y));
  outColor = vec4(c.rgb, 1.0);
}`;

/** Loop length (seconds) of animated library effects on video. */
export const VIDEO_EFFECT_LOOP = 4;

export type DrawOptions = {
  /** Source image size (unrotated) and the track's clockwise rotation. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly rotation: number;
  /** Output frame size. */
  readonly width: number;
  readonly height: number;
  readonly visual?: VisualFx;
  /** Seconds into the segment (rainbow, shake). */
  readonly local?: number;
  /** Seconds on the timeline (animated library effects). */
  readonly time?: number;
  /** Library effects applied in order, each mixed over the frame by `mix`. */
  readonly effects?: readonly { readonly effect: EffectInstance; readonly mix: number }[];
  /** Where on the canvas to present (defaults to all of it). */
  readonly viewport?: readonly [number, number, number, number];
};

/**
 * Renders video frames with treatments and effects on its own WebGL context.
 * The editor draws timeline frames into the viewer canvas; export uses one on
 * an OffscreenCanvas sized to the output and turns it into VideoFrames.
 */
export class VideoRenderer {
  readonly gpu: Gpu;
  private pipeline: DevelopPipeline;
  private effects: EffectRunner;
  private source: Texture | null = null;
  private overlay: Texture | null = null;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gpu = new Gpu(canvas);
    this.pipeline = new DevelopPipeline(this.gpu);
    this.effects = new EffectRunner(this.gpu, this.pipeline);
  }

  private upload(image: TexImageSource, width: number, height: number) {
    if (!this.source || this.source.width !== width || this.source.height !== height) {
      this.gpu.dispose(this.source);
      this.source = this.gpu.texture(width, height, "rgba8", null, { mipmaps: true });
    }
    this.gpu.upload(this.source, image);
    return this.source;
  }

  /** An image drawn over every frame (null removes it); must match the output size. */
  setOverlay(image: OffscreenCanvas | null) {
    this.gpu.dispose(this.overlay);
    this.overlay = image ? this.gpu.texture(image.width, image.height, "rgba8", image) : null;
  }

  /** Draws one frame (or black when `image` is null) and presents it into the canvas. */
  draw(image: TexImageSource | null, o: DrawOptions) {
    const { width, height } = o;
    let frame: Target = this.pipeline.acquire(width, height);
    if (image) {
      const v = o.visual ?? defaultVisualFx;
      const local = o.local ?? 0;
      const rotated = o.rotation === 90 || o.rotation === 270;
      const sw = rotated ? o.sourceHeight : o.sourceWidth;
      const sh = rotated ? o.sourceWidth : o.sourceHeight;
      // Contain-fit: the fraction of the output each axis of the source covers.
      const scale = Math.min(width / sw, height / sh);
      const fit = [(sw * scale) / width, (sh * scale) / height];
      const shake = v.shake;
      const shift = shake ? [Math.sin(local * 37.1) * 0.025 * shake, Math.cos(local * 29.3) * 0.025 * shake] : [0, 0];
      const hue = ((v.hue + (v.rainbow ? local * 180 : 0)) * Math.PI) / 180;
      const src = this.upload(image, o.sourceWidth, o.sourceHeight);
      this.gpu.pass("video-in", frameIn, {
        target: frame,
        textures: { uSource: src },
        uniforms: {
          uRotation: o.rotation,
          uFit: fit,
          uZoom: v.zoom * (1 + shake * 0.06),
          uShift: shift,
          uMirror: v.mirror ? 1 : 0,
          uFlip: v.flip ? 1 : 0,
          uHue: hue,
          uContrast: v.contrast,
          uInvert: v.invert ? 1 : 0,
        },
      });
      for (const { effect, mix } of o.effects ?? []) {
        if (mix <= 0) continue;
        const fx = this.effects.apply(frame, effect, Math.max(width, height) / 1000, o.time ?? 0, VIDEO_EFFECT_LOOP);
        if (mix >= 1) {
          this.pipeline.release(frame);
          frame = fx;
        } else {
          const mixed = this.pipeline.acquire(width, height);
          this.gpu.pass("video-mix", mixPass, { target: mixed, textures: { uOriginal: frame, uEffect: fx }, uniforms: { uMix: mix } });
          this.pipeline.release(frame);
          this.pipeline.release(fx);
          frame = mixed;
        }
      }
    } else {
      this.gpu.clear(frame, 0);
    }
    if (this.overlay) {
      const stamped = this.pipeline.acquire(width, height);
      this.gpu.pass("video-overlay", overlayPass, { target: stamped, textures: { uFrame: frame, uOverlay: this.overlay } });
      this.pipeline.release(frame);
      frame = stamped;
    }
    const { gl } = this.gpu;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.gpu.pass("video-present", present, { target: null, textures: { uInput: frame }, viewport: o.viewport ?? [0, 0, this.canvas.width, this.canvas.height] });
    this.pipeline.release(frame);
  }

  clear() {
    const { gl } = this.gpu;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    this.effects.dispose();
    this.pipeline.trim();
    this.gpu.dispose(this.source);
    this.gpu.dispose(this.overlay);
    this.source = null;
    this.overlay = null;
    // Offscreen export contexts are released right away; an on-screen canvas may be reused.
    if (!(this.canvas instanceof HTMLCanvasElement)) (this.gpu.gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  }
}
