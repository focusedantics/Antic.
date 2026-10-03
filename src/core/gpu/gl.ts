/**
 * Minimal WebGL2 layer for image processing: float render targets, programs
 * with reflected uniforms, and fullscreen passes. Everything the develop and
 * composite pipelines draw goes through `Gpu.pass`.
 */

export type TextureFormat = "rgba16f" | "rgba8" | "r16f" | "r8" | "srgba8" | "rgb16ui" | "rgba16ui";

const BYTES_PER_TEXEL: Record<TextureFormat, number> = { rgba16f: 8, rgba8: 4, srgba8: 4, r16f: 2, r8: 1, rgb16ui: 6, rgba16ui: 8 };

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

const DAB_VERTEX = `#version 300 es
precision highp float;
// One quad per dab: (x, y) center and radius in target pixels, flow in w.
in vec4 aDab;
uniform vec2 uTargetSize;
out vec2 vLocal;
out float vFlow;
void main() {
  int corner = gl_VertexID % 6;
  vec2 offsets[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
  vec2 o = offsets[corner];
  vLocal = o;
  vFlow = aDab.w;
  vec2 p = aDab.xy + o * (aDab.z + 1.0);
  gl_Position = vec4(p / uTargetSize * 2.0 - 1.0, 0.0, 1.0);
}`;

const DAB_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vFlow;
uniform float uFeather;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  if (d > 1.0) discard;
  // Soft edge: full inside (1 - feather), smooth falloff to the rim.
  float inner = 1.0 - uFeather;
  float a = uFeather <= 0.0 ? 1.0 : 1.0 - smoothstep(inner, 1.0, d);
  a *= vFlow;
  outColor = vec4(a, a, a, a);
}`;

/** Draws one tile of a straight-alpha image into the (bottom-up, premultiplied) canvas. */
const READBACK_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
uniform vec4 uRect; // tile x, y, width, height in uv, y measured from the top row
void main() {
  vec2 uv = vec2(uRect.x + vUv.x * uRect.z, uRect.y + (1.0 - vUv.y) * uRect.w);
  vec4 c = texture(uInput, uv);
  outColor = vec4(c.rgb * c.a, c.a);
}`;

/** Packs one float channel per output pixel (4 output pixels per input texel) into 24-bit RGB. */
const PACK_FLOAT_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
uniform vec2 uOrigin;
uniform vec2 uInputSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int channel = p.x % 4;
  ivec2 texel = ivec2(uOrigin) + ivec2(p.x / 4, p.y);
  vec4 c = texelFetch(uInput, clamp(texel, ivec2(0), ivec2(uInputSize) - 1), 0);
  float v = channel == 0 ? c.r : channel == 1 ? c.g : channel == 2 ? c.b : c.a;
  uint q = uint(clamp((v + 64.0) / 128.0, 0.0, 1.0) * 16777215.0 + 0.5);
  outColor = vec4(float((q >> 16) & 255u), float((q >> 8) & 255u), float(q & 255u), 255.0) / 255.0;
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
  /** Live textures and their approximate size in bytes (mip levels included). */
  private live = new Map<WebGLTexture, number>();
  private bytes = 0;

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
    const size = width * height * BYTES_PER_TEXEL[format] * (options.mipmaps ? 4 / 3 : 1);
    this.live.set(texture, size);
    this.bytes += size;
    return { texture, width, height, format, mipmaps: !!options.mipmaps };
  }

  /** Replaces a texture's pixels with an image of the same size (video frames, canvases). */
  upload(texture: Texture, source: TexImageSource) {
    const { gl } = this;
    const info = this.formats[texture.format];
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, info.format, info.type, source);
    if (texture.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
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
    this.bytes -= this.live.get(texture.texture) ?? 0;
    this.live.delete(texture.texture);
  }

  /** Clears pending GL errors so a later `failed()` only reports new ones. */
  drainErrors() {
    const { gl } = this;
    for (let i = 0; i < 32 && gl.getError() !== gl.NO_ERROR; i++);
  }

  /** True when the context was lost or the driver ran out of memory since `drainErrors`. */
  failed(): boolean {
    const { gl } = this;
    if (gl.isContextLost()) return true;
    let oom = false;
    for (let i = 0; i < 32; i++) {
      const e = gl.getError();
      if (e === gl.NO_ERROR) break;
      if (e === gl.OUT_OF_MEMORY || e === gl.CONTEXT_LOST_WEBGL) oom = true;
    }
    return oom;
  }

  /** Number of textures currently allocated, for leak checks. */
  get textureCount() {
    return this.live.size;
  }

  /** Approximate GPU memory held by live textures, in bytes. */
  get textureBytes() {
    return this.bytes;
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

  private dabProgram: { program: WebGLProgram; vao: WebGLVertexArrayObject; buffer: WebGLBuffer; size: WebGLUniformLocation; feather: WebGLUniformLocation } | null = null;

  /**
   * Draws brush dabs (x, y, radius in target pixels, flow) into a target,
   * accumulating with "over" so overlapping dabs build up like a real brush.
   */
  drawDabs(target: Target, dabs: Float32Array, feather: number) {
    const { gl } = this;
    if (!this.dabProgram) {
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new GpuError(`Dab shader: ${gl.getShaderInfoLog(sh)}`);
        return sh;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, DAB_VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, DAB_FRAGMENT));
      gl.bindAttribLocation(program, 0, "aDab");
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new GpuError(`Dab program: ${gl.getProgramInfoLog(program)}`);
      const vao = gl.createVertexArray()!;
      const buffer = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindVertexArray(null);
      this.dabProgram = {
        program,
        vao,
        buffer,
        size: gl.getUniformLocation(program, "uTargetSize")!,
        feather: gl.getUniformLocation(program, "uFeather")!,
      };
    }
    const p = this.dabProgram;
    const count = dabs.length / 4;
    if (!count) return;
    gl.useProgram(p.program);
    gl.bindVertexArray(p.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, dabs, gl.DYNAMIC_DRAW);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.uniform2f(p.size, target.width, target.height);
    gl.uniform1f(p.feather, feather);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  clear(target: Target, value = 0) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(value, value, value, value);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Called after `readImage` borrowed the canvas, so its owner can redraw it. */
  onCanvasBorrowed: (() => void) | null = null;

  /**
   * Copies a straight-alpha, display-encoded image into CPU memory (top row
   * first, like ImageData). Instead of gl.readPixels on an offscreen framebuffer,
   * which some browser/GPU combinations return wrong, each tile is drawn into the
   * canvas and copied out with the browser's own canvas path — the same one that
   * puts frames on screen.
   */
  readImage(input: Texture): ImageData {
    const { gl, canvas } = this;
    const W = input.width;
    const H = input.height;
    const out = new OffscreenCanvas(W, H);
    const ctx = out.getContext("2d", { willReadFrequently: true })!;
    const saved = [canvas.width, canvas.height];
    let tile = 2048;
    try {
      for (let ty = 0; ty < H; ty += tile) {
        for (let tx = 0; tx < W; tx += tile) {
          const tw = Math.min(tile, W - tx);
          const th = Math.min(tile, H - ty);
          if (canvas.width !== tw || canvas.height !== th) {
            canvas.width = tw;
            canvas.height = th;
          }
          if (gl.drawingBufferWidth < tw || gl.drawingBufferHeight < th) {
            // The browser capped the drawing buffer: retry with smaller tiles.
            if (tile <= 256) throw new GpuError("The browser limited the drawing buffer too far to export.");
            tile /= 2;
            ctx.clearRect(0, 0, W, H);
            tx = W;
            ty = -tile;
            continue;
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, tw, th);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          this.pass("readback", READBACK_FRAGMENT, {
            target: null,
            viewport: [0, 0, tw, th],
            textures: { uInput: input },
            uniforms: { uRect: [tx / W, ty / H, tw / W, th / H] },
          });
          ctx.drawImage(canvas as CanvasImageSource, 0, 0, tw, th, tx, ty, tw, th);
        }
      }
    } finally {
      canvas.width = saved[0];
      canvas.height = saved[1];
      this.onCanvasBorrowed?.();
    }
    return ctx.getImageData(0, 0, W, H);
  }

  /**
   * Reads float RGBA values of a region through the same canvas path as
   * `readImage`: each channel is packed into 24 bits of an RGBA8 pixel on the
   * GPU (range −64…64, ~8e-6 precision) and unpacked here.
   */
  readFloatRegion(input: Texture, x: number, y: number, width: number, height: number): Float32Array {
    const packed = this.target(width * 4, height, "rgba8");
    try {
      this.pass("pack-float", PACK_FLOAT_FRAGMENT, {
        target: packed,
        textures: { uInput: input },
        uniforms: { uOrigin: [x, y], uInputSize: [input.width, input.height] },
      });
      const bytes = this.readImage(packed).data;
      const out = new Float32Array(width * height * 4);
      for (let i = 0; i < out.length; i++) {
        const q = bytes[i * 4] * 65536 + bytes[i * 4 + 1] * 256 + bytes[i * 4 + 2];
        out[i] = (q / 16777215) * 128 - 64;
      }
      return out;
    } finally {
      this.dispose(packed);
    }
  }

  /** Reads one float pixel at texel (x, y). */
  readPixelFloat(target: Texture, x: number, y: number): [number, number, number, number] {
    const px = Math.max(0, Math.min(target.width - 1, Math.floor(x)));
    const py = Math.max(0, Math.min(target.height - 1, Math.floor(y)));
    const v = this.readFloatRegion(target, px, py, 1, 1);
    return [v[0], v[1], v[2], v[3]];
  }

  /** Reads every float pixel of a (small) target, top row first. */
  readFloat(target: Texture): Float32Array {
    return this.readFloatRegion(target, 0, 0, target.width, target.height);
  }
}

