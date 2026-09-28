import { EffectRunner } from "@/core/effects/runtime";
import { Gpu, type Target, type Texture } from "@/core/gpu/gl";
import { DevelopPipeline } from "@/core/gpu/pipeline";
import type { VideoEdit } from "./model";

const header = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

/** Source frame → working frame: rotation (clockwise, from the track matrix) and scaling. */
const frameIn = `${header}
uniform sampler2D uSource;
uniform int uRotation;
void main() {
  vec2 uv = vUv;
  vec2 src = uRotation == 90 ? vec2(uv.y, 1.0 - uv.x) : uRotation == 180 ? vec2(1.0 - uv.x, 1.0 - uv.y) : uRotation == 270 ? vec2(1.0 - uv.y, uv.x) : uv;
  outColor = vec4(texture(uSource, src).rgb, 1.0);
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

/**
 * Renders video frames with an edit's effect on its own WebGL context. The
 * editor uses it to draw the playing <video> into a canvas; export uses one on
 * an OffscreenCanvas sized to the output and turns the canvas into VideoFrames.
 */
/** Loop length (seconds) of animated effects on video clips. */
export const VIDEO_EFFECT_LOOP = 4;

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

  /**
   * Draws one frame: `image` (sourceWidth × sourceHeight, unrotated) becomes a
   * width × height frame with the edit's effect, presented into `viewport` of
   * the canvas (defaults to the whole canvas). `time` (seconds into the clip)
   * drives animated effects, which loop every `VIDEO_EFFECT_LOOP` seconds.
   */
  draw(
    image: TexImageSource,
    sourceWidth: number,
    sourceHeight: number,
    rotation: number,
    width: number,
    height: number,
    edit: Pick<VideoEdit, "effect" | "effectMix">,
    viewport?: readonly [number, number, number, number],
    time = 0,
  ) {
    const src = this.upload(image, sourceWidth, sourceHeight);
    let frame: Target = this.pipeline.acquire(width, height);
    this.gpu.pass("video-in", frameIn, { target: frame, textures: { uSource: src }, uniforms: { uRotation: rotation } });
    if (edit.effect && edit.effectMix > 0) {
      const fx = this.effects.apply(frame, edit.effect, Math.max(width, height) / 1000, time, VIDEO_EFFECT_LOOP);
      if (edit.effectMix >= 1) {
        this.pipeline.release(frame);
        frame = fx;
      } else {
        const mixed = this.pipeline.acquire(width, height);
        this.gpu.pass("video-mix", mixPass, { target: mixed, textures: { uOriginal: frame, uEffect: fx }, uniforms: { uMix: edit.effectMix } });
        this.pipeline.release(frame);
        this.pipeline.release(fx);
        frame = mixed;
      }
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
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.gpu.pass("video-present", present, { target: null, textures: { uInput: frame }, viewport: viewport ?? [0, 0, this.canvas.width, this.canvas.height] });
    this.pipeline.release(frame);
  }

  clear() {
    const { gl } = this.gpu;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
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
