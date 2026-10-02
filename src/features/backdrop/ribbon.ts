/*
 * Ribbon glow backdrop.
 *
 * Adapted from "Ribbon Glow 2" by Originkit (https://www.originkit.dev/), MIT
 * license (see docs/THIRD_PARTY.md).
 *
 * Changes from the original: a plain class instead of a React component; the
 * colours, angle, size, speed and brightness are uniforms that blend between
 * per-workspace looks; the field renders at a capped resolution and frame rate
 * (lower again on software GL); it pauses when hidden, holds still under
 * prefers-reduced-motion, and survives WebGL context loss. The paper (light
 * background) branch and CSS colour parsing were removed.
 */
import { approach, BACKDROP_BASE, type GlowLook } from "./looks";

const LAYERS = 84;
const TWIST = 1.25;
const DRAG = 0.18;

const VERT_SRC = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`;

const FIELD_SRC = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uSize;
uniform float uAngle;
uniform vec2 uMouse;
uniform float uOn;
uniform float uReach;
uniform vec2 uVel;
out vec4 o;

const float LAYERS = ${LAYERS.toFixed(1)};
const float TWIST = ${TWIST.toFixed(3)};
const float DRAG = ${DRAG.toFixed(3)};
const float GAIN = 0.62;
const vec2 CENTRE = vec2(-0.62, 0.24);
const float TILT = 0.6;
const float ZOOM = 1.05;
const float THETA = 2.13;
const float SHEAR = 0.963;
const float SHRINK = 0.953;
const vec2 WARP_FREQ = vec2(0.42, 2.4);
const vec2 WARP_AMP = vec2(0.13, 0.027);
const vec2 ASPECT = vec2(2.1, 0.17);
const float OFFSET = 0.36;
const float GLOW = 0.0021;
const float SOFT = 0.0019;
const float FALLOFF = 0.37;
const float PHASE = 12.0;
const float CYCLE = 0.16;
const float HUE_TRAVEL = 2.0;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

void main() {
  vec2 R = uRes;
  vec2 pos = (gl_FragCoord.xy - 0.5 * R) / R.y;

  vec2 d = pos - uMouse;
  float w = uOn * exp(-dot(d, d) / (uReach * uReach));
  if (w > 1e-4) pos = uMouse + rot(w * TWIST) * d * (1.0 - 0.3 * min(w, 1.0)) - uVel * min(w, 1.0) * DRAG;

  pos = rot(uAngle) * pos / uSize;
  float t = uTime * 0.49 + PHASE;
  float breath = (-sin(uTime * 0.735) + sin(uTime * 0.49 + 1.0)) * 0.25 + 0.5;
  vec2 u = rot(TILT) * ((pos - CENTRE) * (ZOOM - breath * 0.085));
  mat2 fold = mat2(cos(THETA), sin(THETA), -SHEAR, cos(THETA));

  vec3 col = vec3(0.0);
  for (float i = 1.0; i <= LAYERS; i += 1.0) {
    u.x -= sin(u.y * WARP_FREQ.x + t + i * 0.007) * WARP_AMP.x;
    u.y -= sin(u.x * WARP_FREQ.y - t + i * 0.02) * WARP_AMP.y;
    u = fold * u * SHRINK;
    vec2 q = (u - vec2(OFFSET + breath * 0.1, 0.0)) * ASPECT;
    float g = GLOW / (dot(q, q) + SOFT) * (0.25 + breath * 0.4);
    float r = length(u);
    float k = sin(i * CYCLE + t * 1.2 + r * HUE_TRAVEL) * 0.5 + 0.5;
    col += g * mix(uC1, uC2, k) * (0.62 + 0.5 * k) * exp2(-r * FALLOFF);
  }
  vec3 x = max(col * GAIN, 0.0);
  col = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.85, 0.92, 0.98));
  col *= 1.0 - smoothstep(0.5, 1.6, length(pos)) * 0.07;
  o = vec4(col, 1.0);
}
`;

const FINISH_SRC = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBg;
uniform float uIntensity;
out vec4 o;

float ign(vec2 p, float f) { p += 5.588238 * mod(f, 64.0); return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 L = max(texture(uField, frag / uRes).rgb, 0.0) * uIntensity;
  vec3 col = uBg + L * (1.0 - uBg);
  col += (ign(frag, floor(uTime * 24.0)) - 0.5) / 255.0;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

function link(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`Backdrop shader: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT_SRC);
  const fs = shader(gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`Backdrop link: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}

const locations = (gl: WebGL2RenderingContext, prog: WebGLProgram, names: string[]): Uniforms =>
  Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));

/** True when WebGL runs on the CPU (SwiftShader, llvmpipe…): render less. */
function softwareGl(gl: WebGL2RenderingContext) {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

type Gl = {
  gl: WebGL2RenderingContext;
  field: WebGLProgram;
  finish: WebGLProgram;
  uf: Uniforms;
  un: Uniforms;
  vao: WebGLVertexArrayObject;
  fbo: WebGLFramebuffer;
  tex: WebGLTexture | null;
  half: boolean;
  w: number;
  h: number;
};

export type RibbonOptions = {
  reducedMotion: boolean;
  /** Keep the current frame on screen and draw nothing (e.g. while a video plays). */
  held?: boolean;
};

/**
 * Draws the glow into a canvas of its own inside `host` until `dispose()`.
 * Pixels stay on the GPU. Owning the canvas means a disposed context (released
 * at once with WEBGL_lose_context) is never handed to the next instance.
 */
export class RibbonGlow {
  private readonly canvas: HTMLCanvasElement;
  private g: Gl | null = null;
  private raf = 0;
  private last = -1;
  private lastDraw = -Infinity;
  private clock = 0;
  private look: GlowLook;
  private target: GlowLook;
  private software = false;
  private dirty = true;
  // Pointer, in canvas CSS pixels.
  private ptr = { x: 0, y: 0, inside: false };
  private mx = 0;
  private my = 0;
  private vx = 0;
  private vy = 0;
  private on = 0;

  constructor(
    host: HTMLElement,
    look: GlowLook,
    private options: RibbonOptions,
  ) {
    this.canvas = document.createElement("canvas");
    host.append(this.canvas);
    this.look = look;
    this.target = look;
    this.canvas.addEventListener("webglcontextlost", this.lost);
    this.canvas.addEventListener("webglcontextrestored", this.restored);
    window.addEventListener("pointermove", this.move, { passive: true });
    window.addEventListener("pointerdown", this.move, { passive: true });
    document.addEventListener("pointerout", this.leave);
    this.init();
    this.raf = requestAnimationFrame(this.render);
  }

  /** Blends to a new look (or jumps, under reduced motion). */
  setLook(look: GlowLook) {
    this.target = look;
    if (this.options.reducedMotion) this.look = look;
    this.dirty = true;
  }

  setOptions(options: RibbonOptions) {
    this.options = options;
    this.dirty = true;
  }

  /** The look currently on screen (for tests and the tour). */
  current(): GlowLook {
    return this.look;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerdown", this.move);
    document.removeEventListener("pointerout", this.leave);
    this.canvas.remove();
    const g = this.g;
    this.g = null;
    if (!g || g.gl.isContextLost()) return;
    const { gl } = g;
    if (g.tex) gl.deleteTexture(g.tex);
    gl.deleteFramebuffer(g.fbo);
    gl.deleteVertexArray(g.vao);
    gl.deleteProgram(g.field);
    gl.deleteProgram(g.finish);
    // Hand the context back now rather than at garbage collection.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private init() {
    const gl = this.canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) return;
    try {
      const field = link(gl, FIELD_SRC);
      const finish = link(gl, FINISH_SRC);
      this.software = softwareGl(gl);
      this.g = {
        gl,
        field,
        finish,
        uf: locations(gl, field, ["uRes", "uTime", "uC1", "uC2", "uSize", "uAngle", "uMouse", "uOn", "uReach", "uVel"]),
        un: locations(gl, finish, ["uField", "uRes", "uTime", "uBg", "uIntensity"]),
        vao: gl.createVertexArray()!,
        fbo: gl.createFramebuffer()!,
        tex: null,
        half: !!gl.getExtension("EXT_color_buffer_float"),
        w: 0,
        h: 0,
      };
      this.dirty = true;
    } catch (error) {
      console.warn(error);
      this.g = null;
    }
  }

  private lost = (e: Event) => {
    e.preventDefault();
    this.g = null;
  };

  private restored = () => this.init();

  private move = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.ptr.x = e.clientX - r.left;
    this.ptr.y = e.clientY - r.top;
    this.ptr.inside = true;
  };

  /** Leaving the window: pointerout with nothing on the other side. */
  private leave = (e: PointerEvent) => {
    if (!e.relatedTarget) this.ptr.inside = false;
  };

  private resizeField(g: Gl, nw: number, nh: number) {
    if (nw === g.w && nh === g.h && g.tex) return;
    const { gl } = g;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (g.tex) gl.deleteTexture(g.tex);
      g.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, g.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, g.half ? gl.RGBA16F : gl.RGBA8, nw, nh, 0, gl.RGBA, g.half ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (ok || !g.half) break;
      g.half = false;
    }
    g.w = nw;
    g.h = nh;
  }

  private render = (now: number) => {
    this.raf = requestAnimationFrame(this.render);
    const g = this.g;
    if (!g || document.hidden || this.options.held) {
      this.last = -1;
      return;
    }
    const still = this.options.reducedMotion;
    // The glow is soft: 30 fps is plenty, 15 on a software renderer. Still mode draws only on change.
    const interval = this.software ? 1000 / 15 : 1000 / 30;
    if (still ? !this.dirty : now - this.lastDraw < interval - 2) return;
    const dt = this.last < 0 || still ? 0 : Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.lastDraw = now;
    this.dirty = false;

    this.look = still ? this.target : approach(this.look, this.target, dt);
    const v = this.look;
    this.clock = (this.clock + dt * v.speed) % 3600;

    const { gl, uf, un } = g;
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    // Device pixel ratio 1: the image is a blur plus dither, extra pixels only cost.
    const bw = Math.max(1, Math.round(cw));
    const bh = Math.max(1, Math.round(ch));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    const cap = this.software ? 320 : 720;
    const fieldScale = Math.min(0.5, cap / Math.max(bw, bh));
    this.resizeField(g, Math.max(1, Math.round(bw * fieldScale)), Math.max(1, Math.round(bh * fieldScale)));

    // Pointer swirl: eases in when the pointer is over the page, follows with drag.
    const present = this.ptr.inside && !still ? 1 : 0;
    if (present && this.on < 0.02) {
      this.mx = this.ptr.x;
      this.my = this.ptr.y;
    }
    this.on += (present - this.on) * (1 - Math.exp(-dt * 5));
    const k = 1 - Math.exp(-dt * 16);
    const nx = this.mx + (this.ptr.x - this.mx) * k;
    const ny = this.my + (this.ptr.y - this.my) * k;
    if (dt > 0) {
      const kv = 1 - Math.exp(-dt * 8);
      this.vx += ((nx - this.mx) / dt - this.vx) * kv;
      this.vy += ((ny - this.my) / dt - this.vy) * kv;
    }
    this.mx = nx;
    this.my = ny;
    const vLen = Math.hypot(this.vx, this.vy) / ch;
    const vCap = vLen > 3 ? 3 / vLen : 1;

    gl.bindVertexArray(g.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
    gl.viewport(0, 0, g.w, g.h);
    gl.useProgram(g.field);
    gl.uniform2f(uf.uRes, g.w, g.h);
    gl.uniform1f(uf.uTime, this.clock);
    gl.uniform3f(uf.uC1, ...v.color1);
    gl.uniform3f(uf.uC2, ...v.color2);
    gl.uniform1f(uf.uSize, v.size);
    gl.uniform1f(uf.uAngle, (v.angle * Math.PI) / 180);
    gl.uniform2f(uf.uMouse, (this.mx - cw / 2) / ch, (ch / 2 - this.my) / ch);
    gl.uniform1f(uf.uOn, this.on);
    gl.uniform1f(uf.uReach, 240 / ch);
    gl.uniform2f(uf.uVel, (this.vx / ch) * vCap, (-this.vy / ch) * vCap);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(g.finish);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.uniform1i(un.uField, 0);
    gl.uniform2f(un.uRes, bw, bh);
    gl.uniform1f(un.uTime, this.clock);
    gl.uniform3f(un.uBg, ...BACKDROP_BASE);
    gl.uniform1f(un.uIntensity, v.intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}
