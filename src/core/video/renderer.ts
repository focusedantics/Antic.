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
export class VideoRenderer {
  readonly gpu: Gpu;
  private pipeline: DevelopPipeline;
  private effects: EffectRunner;
  private source: Texture | null = null;

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

  /**
   * Draws one frame: `image` (sourceWidth × sourceHeight, unrotated) becomes a
   * width × height frame with the edit's effect, presented into `viewport` of
   * the canvas (defaults to the whole canvas).
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
  ) {
    const src = this.upload(image, sourceWidth, sourceHeight);
    let frame: Target = this.pipeline.acquire(width, height);
    this.gpu.pass("video-in", frameIn, { target: frame, textures: { uSource: src }, uniforms: { uRotation: rotation } });
    if (edit.effect && edit.effectMix > 0) {
      const fx = this.effects.apply(frame, edit.effect, Math.max(width, height) / 1000);
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
    this.source = null;
    // Offscreen export contexts are released right away; an on-screen canvas may be reused.
    if (!(this.canvas instanceof HTMLCanvasElement)) (this.gpu.gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  }
}
