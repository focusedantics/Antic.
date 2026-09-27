/**
 * Minimal WebGL2 layer for image processing: float render targets, programs
 * with reflected uniforms, and fullscreen passes. Everything the develop and
 * composite pipelines draw goes through `Gpu.pass`.
 */

export type TextureFormat = "rgba16f" | "rgba8" | "r16f" | "r8" | "srgba8" | "rgb16ui" | "rgba16ui";

type FormatInfo = { internal: number; format: number; type: number; filterable: boolean; integer?: boolean };

export type Texture = {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly mipmaps: boolean;
};

export type Target = Texture & { readonly framebuffer: WebGLFramebuffer };

export type UniformValue = number | boolean | readonly number[] | Float32Array | Int32Array;

export type PassInput = {
  readonly uniforms?: Record<string, UniformValue>;
  readonly textures?: Record<string, Texture | null | undefined>;
  /** Output target; null renders to the canvas (default framebuffer). */
  readonly target: Target | null;
  readonly viewport?: readonly [number, number, number, number];
  readonly blend?: "none" | "over" | "add" | "max" | "screen" | "multiply-inverse";
};

type Program = {
  program: WebGLProgram;
  uniforms: Map<string, { location: WebGLUniformLocation; type: number; size: number }>;
  samplers: string[];
};

const VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // One triangle covering the viewport; vUv is 0..1 across it.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class GpuError extends Error {}

export class Gpu {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly floatRenderable: boolean;
  readonly floatLinear: boolean;
  private readonly programs = new Map<string, Program>();
  private readonly vao: WebGLVertexArrayObject;
  private readonly formats: Record<TextureFormat, FormatInfo>;
  private live = new Set<WebGLTexture>();

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new GpuError("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.floatRenderable = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    if (!this.floatRenderable) throw new GpuError("This GPU cannot render to floating-point textures (EXT_color_buffer_float).");
    this.floatLinear = !!gl.getExtension("OES_texture_float_linear");
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.vao = gl.createVertexArray()!;
    this.formats = {
      rgba16f: { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filterable: true },
      rgba8: { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filterable: true },
      srgba8: { internal: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filterable: true },
      r16f: { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, filterable: true },
      r8: { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filterable: true },
      rgb16ui: { internal: gl.RGB16UI, format: gl.RGB_INTEGER, type: gl.UNSIGNED_SHORT, filterable: false, integer: true },
      rgba16ui: { internal: gl.RGBA16UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_SHORT, filterable: false, integer: true },
    };
  }

  get isLost() {
    return this.gl.isContextLost();
  }

  // ─── Textures ────────────────────────────────────────────────────────────

  texture(
    width: number,
    height: number,
    format: TextureFormat,
    data?: ArrayBufferView | TexImageSource | null,
    options: { mipmaps?: boolean; wrap?: "clamp" | "repeat" } = {},
  ): Texture {
    const { gl } = this;
    const info = this.formats[format];
    const texture = gl.createTexture();
    if (!texture) throw new GpuError("Out of GPU memory (createTexture failed).");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const levels = options.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, info.internal, width, height);
    if (data) {
      if (ArrayBuffer.isView(data)) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, info.format, info.type, data);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, info.format, info.type, data as TexImageSource);
    }
    const filter = info.filterable ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    const wrap = options.wrap === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this.live.add(texture);
    return { texture, width, height, format, mipmaps: !!options.mipmaps };
  }

  generateMipmaps(texture: Texture) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  target(width: number, height: number, format: TextureFormat = "rgba16f", options: { mipmaps?: boolean } = {}): Target {
    const { gl } = this;
    const tex = this.texture(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), format, null, options);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new GpuError("Out of GPU memory (createFramebuffer failed).");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      this.dispose(tex);
      throw new GpuError(`Render target ${format} ${width}×${height} is not supported (status ${status}).`);
    }
    return { ...tex, framebuffer };
  }

  dispose(texture: Texture | Target | null | undefined) {
    if (!texture) return;
    const { gl } = this;
    if ("framebuffer" in texture) gl.deleteFramebuffer(texture.framebuffer);
    gl.deleteTexture(texture.texture);
    this.live.delete(texture.texture);
  }

  /** Number of textures currently allocated, for leak checks. */
  get textureCount() {
    return this.live.size;
  }

  // ─── Programs ────────────────────────────────────────────────────────────

  private compile(key: string, fragment: string): Program {
    const cached = this.programs.get(key);
    if (cached) return cached;
    const { gl } = this;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        const numbered = source
          .split("\n")
          .map((l, i) => `${String(i + 1).padStart(4)} ${l}`)
          .join("\n");
        throw new GpuError(`Shader ${key} failed to compile:\n${log}\n${numbered}`);
      }
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new GpuError(`Program ${key} failed to link: ${gl.getProgramInfoLog(program)}`);
    const uniforms = new Map<string, { location: WebGLUniformLocation; type: number; size: number }>();
    const samplers: string[] = [];
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)!;
      const name = info.name.replace(/\[0\]$/, "");
      const location = gl.getUniformLocation(program, info.name)!;
      uniforms.set(name, { location, type: info.type, size: info.size });
      if (
        info.type === gl.SAMPLER_2D ||
        info.type === gl.UNSIGNED_INT_SAMPLER_2D ||
        info.type === gl.INT_SAMPLER_2D
      )
        samplers.push(name);
    }
    const compiled = { program, uniforms, samplers };
    this.programs.set(key, compiled);
    return compiled;
  }

  private setUniform(u: { location: WebGLUniformLocation; type: number; size: number }, value: UniformValue) {
    const { gl } = this;
    const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
    const arr = typeof v === "number" ? [v] : v;
    switch (u.type) {
      case gl.FLOAT:
        return gl.uniform1fv(u.location, arr as Float32List);
      case gl.FLOAT_VEC2:
        return gl.uniform2fv(u.location, arr as Float32List);
      case gl.FLOAT_VEC3:
        return gl.uniform3fv(u.location, arr as Float32List);
      case gl.FLOAT_VEC4:
        return gl.uniform4fv(u.location, arr as Float32List);
      case gl.INT:
      case gl.BOOL:
        return gl.uniform1iv(u.location, Array.from(arr as ArrayLike<number>, (x) => Math.round(x)));
      case gl.INT_VEC2:
        return gl.uniform2iv(u.location, Array.from(arr as ArrayLike<number>, (x) => Math.round(x)));
      case gl.FLOAT_MAT3:
        return gl.uniformMatrix3fv(u.location, false, arr as Float32List);
      case gl.FLOAT_MAT4:
        return gl.uniformMatrix4fv(u.location, false, arr as Float32List);
      default:
        throw new GpuError(`Unsupported uniform type ${u.type}`);
    }
  }

  /** Runs a fullscreen fragment pass. `key` identifies the compiled program. */
  pass(key: string, fragment: string, input: PassInput) {
    const { gl } = this;
    const program = this.compile(key, fragment);
    gl.useProgram(program.program);
    gl.bindVertexArray(this.vao);
    const target = input.target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    const [x, y, w, h] = input.viewport ?? [0, 0, target ? target.width : gl.drawingBufferWidth, target ? target.height : gl.drawingBufferHeight];
    gl.viewport(x, y, w, h);
    switch (input.blend ?? "none") {
      case "none":
        gl.disable(gl.BLEND);
        break;
      case "over":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case "add":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case "max":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        break;
      case "screen":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE);
        break;
      case "multiply-inverse":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
        break;
    }
    let unit = 0;
    for (const name of program.samplers) {
      const tex = input.textures?.[name];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex ? tex.texture : null);
      gl.uniform1i(program.uniforms.get(name)!.location, unit);
      unit++;
    }
    if (input.uniforms) {
      for (const [name, value] of Object.entries(input.uniforms)) {
        const u = program.uniforms.get(name);
        if (u) this.setUniform(u, value);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Unbind textures so a later pass can render into them without feedback loops.
    for (let i = 0; i < unit; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /** Reads RGBA8 pixels from a target (bottom-up rows, as GL stores them). */
  readRgba8(target: Target): Uint8Array {
    const { gl } = this;
    const out = new Uint8Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Reads float pixels (RGBA32F) from a float target. */
  readFloat(target: Target): Float32Array {
    const { gl } = this;
    const out = new Float32Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
