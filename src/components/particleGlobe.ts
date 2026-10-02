/*
 * The photo as a field of particles that gathers into a turning globe and falls
 * back into the photo. Interpreted from a three.js WebGPU + TSL + Motion sketch
 * supplied by the project owner (one spring value morphs every particle between its
 * place in the picture and a point on a Fibonacci sphere, with per-particle
 * turbulence; the exact photo fades back in only when the particles have settled).
 * Here it is plain WebGL2 points and a small spring integrator, with a pointer that
 * tilts the globe and parts the particles, depth shading, and a dotted progress ring.
 */

type Rect = { x0: number; y0: number; x1: number; y1: number };

const VERT = `#version 300 es
in vec2 aImage;
in vec3 aSphere;
in vec3 aColor;
in vec2 aNoise; // phase, speed
uniform vec2 uView;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uGlobe;
uniform float uTime;
uniform float uYaw;
uniform float uTilt;
uniform float uPoint;
uniform vec2 uPointer;
uniform float uPointerOn;
out vec3 vColor;
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
void main() {
  float phase = aNoise.x;
  float speed = aNoise.y;
  float t = uTime;
  vec3 turbulence = vec3(
    sin(t * (speed + 0.6) + phase) * 0.045,
    cos(t * (speed + 0.37) + phase * 1.71) * 0.035,
    sin(t * (speed + 0.22) + phase * 2.13) * 0.045);
  vec3 g = rotX(uTilt) * (rotY(uYaw) * aSphere) + turbulence;
  vec2 globePx = uCenter + vec2(g.x, -g.y) * uRadius;
  // Each particle leaves and lands a little out of step with its neighbours.
  float settle = sin(3.14159265 * clamp(uGlobe, 0.0, 1.0));
  float k = uGlobe + (fract(phase * 0.1591549) - 0.5) * 0.18 * settle;
  vec2 p = mix(aImage, globePx, k);
  // The pointer parts the particles while they float.
  vec2 d = p - uPointer;
  float near = exp(-dot(d, d) / (uRadius * uRadius * 0.07)) * uPointerOn * clamp(k, 0.0, 1.0);
  p += normalize(d + 1e-4) * near * uRadius * 0.14;
  float depth = g.z * 0.5 + 0.5;
  float kk = clamp(k, 0.0, 1.0);
  vColor = aColor * mix(1.0, 0.45 + 0.75 * depth, kk) + vec3(0.12, 0.2, 0.25) * near;
  gl_PointSize = uPoint * mix(1.0, 0.55 + 0.75 * depth, kk);
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 o;
void main() { o = vec4(vColor, 1.0); }`;

/** Textured or flat quads in pixels (the dark stage and the photo). */
const QUAD_VERT = `#version 300 es
in vec2 aPos;
uniform vec2 uView;
uniform vec4 uRect; // x0 y0 x1 y1 in pixels
out vec2 vUv;
void main() {
  vUv = aPos;
  vec2 p = mix(uRect.xy, uRect.zw, aPos);
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
}`;
const QUAD_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uUvRect;
uniform vec4 uColor;
uniform float uTextured;
out vec4 o;
void main() {
  if (uTextured > 0.5) {
    vec4 c = texture(uTex, mix(uUvRect.xy, uUvRect.zw, vUv));
    o = c * uColor.a; // premultiplied
  } else o = vec4(uColor.rgb * uColor.a, uColor.a);
}`;

/** Fades the exact photo in only once the particles have all but landed (from the sketch). */
export function highResolutionMix(globe: number): number {
  const amount = Math.max(globe, 0);
  const t = Math.min(1, Math.max(0, (amount - 0.005) / (0.035 - 0.005)));
  return 1 - t * t * (3 - 2 * t);
}

/** A damped spring: x'' = (−k (x − target) − c x') / m, stepped at 240 Hz. */
export class Spring {
  x: number;
  v = 0;
  target: number;
  constructor(
    x: number,
    public stiffness = 55,
    public damping = 16,
    public mass = 1,
  ) {
    this.x = x;
    this.target = x;
  }
  to(target: number, stiffness: number, damping: number, mass = 1) {
    this.target = target;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }
  step(dt: number) {
    const h = 1 / 240;
    for (let left = Math.min(dt, 0.1); left > 0; left -= h) {
      const s = Math.min(h, left);
      const a = (-this.stiffness * (this.x - this.target) - this.damping * this.v) / this.mass;
      this.v += a * s;
      this.x += this.v * s;
    }
  }
  get resting() {
    return Math.abs(this.x - this.target) < 0.002 && Math.abs(this.v) < 0.02;
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const make = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Globe shader: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Globe link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export class ParticleGlobe {
  readonly canvas: HTMLCanvasElement;
  readonly spring = new Spring(0);
  private gl: WebGL2RenderingContext | null;
  private points: WebGLProgram | null = null;
  private quads: WebGLProgram | null = null;
  private pointVao: WebGLVertexArrayObject | null = null;
  private quadVao: WebGLVertexArrayObject | null = null;
  private photo: WebGLTexture | null = null;
  private count = 0;
  private ringStart = 0;
  private ringCount = 0;
  private point = 2;
  private raf = 0;
  private last = 0;
  private time = 0;
  private yaw = Math.random() * Math.PI * 2;
  private look = { x: 0, y: 0 };
  private pointer = { x: -1e5, y: -1e5, on: 0, inside: false };
  private progress: number | null = null;

  /**
   * `before` is the viewer as it looks now (device pixels), `box` the photo inside
   * it. The canvas is placed by the caller over the viewer canvas.
   */
  constructor(
    private readonly before: ImageData,
    private readonly box: Rect,
    private readonly scale: number,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = before.width;
    this.canvas.height = before.height;
    this.gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: "high-performance" });
    if (!this.gl) return;
    try {
      this.init(this.gl);
    } catch (error) {
      console.warn(error);
      this.gl = null;
      return;
    }
    window.addEventListener("pointermove", this.onMove, { passive: true });
    this.raf = requestAnimationFrame(this.frame);
  }

  get ready() {
    return !!this.gl;
  }

  /** Model download (0–100) shown as a dotted ring around the globe; null hides it. */
  setProgress(p: number | null) {
    this.progress = p;
  }

  /** Resolves once the spring rests at its target (or after `timeout` ms). */
  async settle(timeout = 2500): Promise<void> {
    const start = performance.now();
    while (!this.spring.resting && performance.now() - start < timeout && this.gl) await new Promise((r) => requestAnimationFrame(r));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("pointermove", this.onMove);
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.canvas.remove();
  }

  private init(gl: WebGL2RenderingContext) {
    const { before, box } = this;
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    // About one particle per 4 CSS pixels, at most 180 across: smooth on modest GPUs.
    const columns = Math.max(48, Math.min(180, Math.round(bw / this.scale / 4)));
    const rows = Math.max(1, Math.round((columns * bh) / bw));
    const count = columns * rows;
    const ring = 160;
    const data = new Float32Array((count + ring) * 10);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const c = i % columns;
      const r = Math.floor(i / columns);
      const x = box.x0 + ((c + 0.5) / columns) * bw;
      const y = box.y0 + ((r + 0.5) / rows) * bh;
      const px = (Math.min(before.height - 1, Math.floor(y)) * before.width + Math.min(before.width - 1, Math.floor(x))) * 4;
      // A Fibonacci sphere, in shuffled order so neighbouring pixels scatter across it.
      const j = (i * 7919) % count;
      const sy = 1 - (j / Math.max(count - 1, 1)) * 2;
      const ringR = Math.sqrt(Math.max(0, 1 - sy * sy));
      const a = j * golden;
      data.set([x, y, Math.cos(a) * ringR, sy, Math.sin(a) * ringR, before.data[px] / 255, before.data[px + 1] / 255, before.data[px + 2] / 255, Math.random() * Math.PI * 2, 0.7 + Math.random() * 0.35], i * 10);
    }
    // The progress ring: dots on a circle, drawn with the same program (globe = 1, no turbulence).
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      data.set([0, 0, Math.sin(a), Math.cos(a), 0, 0.75, 0.96, 1, 0, 0], (count + i) * 10);
    }
    this.count = count;
    this.ringStart = count;
    this.ringCount = ring;
    this.point = Math.max(1, (bw / columns) * 1.02);

    this.points = program(gl, VERT, FRAG);
    this.pointVao = gl.createVertexArray();
    gl.bindVertexArray(this.pointVao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.points!, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset * 4);
    };
    attr("aImage", 2, 0);
    attr("aSphere", 3, 2);
    attr("aColor", 3, 5);
    attr("aNoise", 2, 8);

    this.quads = program(gl, QUAD_VERT, QUAD_FRAG);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const ql = gl.getAttribLocation(this.quads, "aPos");
    gl.enableVertexAttribArray(ql);
    gl.vertexAttribPointer(ql, 2, gl.FLOAT, false, 0, 0);

    this.photo = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.photo);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, before);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = (e.clientX - r.left) * this.scale;
    this.pointer.y = (e.clientY - r.top) * this.scale;
    this.pointer.inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const gl = this.gl;
    if (!gl || !this.points || !this.quads) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    this.time += dt;
    this.spring.step(dt);
    const globe = this.spring.x;
    const { box } = this;
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const radius = Math.min(box.x1 - box.x0, box.y1 - box.y0) * 0.36;
    // The globe turns on its own and leans towards the pointer.
    const p = this.pointer;
    p.on += ((p.inside ? 1 : 0) - p.on) * (1 - Math.exp(-dt * 5));
    const tx = p.inside ? Math.max(-1, Math.min(1, (p.x - cx) / radius)) : 0;
    const ty = p.inside ? Math.max(-1, Math.min(1, (p.y - cy) / radius)) : 0;
    this.look.x += (tx - this.look.x) * (1 - Math.exp(-dt * 3));
    this.look.y += (ty - this.look.y) * (1 - Math.exp(-dt * 3));
    this.yaw += dt * (0.35 + 0.25 * Math.abs(this.look.x));

    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // A dark stage over the photo while the particles are away.
    const stage = Math.min(1, Math.max(0, globe) * 5) * 0.94;
    gl.useProgram(this.quads);
    gl.bindVertexArray(this.quadVao);
    const qu = (n: string) => gl.getUniformLocation(this.quads!, n);
    gl.uniform2f(qu("uView"), W, H);
    gl.uniform4f(qu("uRect"), box.x0, box.y0, box.x1, box.y1);
    if (stage > 0) {
      gl.uniform1f(qu("uTextured"), 0);
      gl.uniform4f(qu("uColor"), 0.035, 0.04, 0.05, stage);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.useProgram(this.points);
    gl.bindVertexArray(this.pointVao);
    const pu = (n: string) => gl.getUniformLocation(this.points!, n);
    gl.uniform2f(pu("uView"), W, H);
    gl.uniform2f(pu("uCenter"), cx, cy);
    gl.uniform1f(pu("uRadius"), radius);
    gl.uniform1f(pu("uGlobe"), globe);
    gl.uniform1f(pu("uTime"), this.time);
    gl.uniform1f(pu("uYaw"), this.yaw + this.look.x * 0.6);
    gl.uniform1f(pu("uTilt"), -0.28 + this.look.y * 0.45);
    gl.uniform1f(pu("uPoint"), this.point);
    gl.uniform2f(pu("uPointer"), p.x, p.y);
    gl.uniform1f(pu("uPointerOn"), p.on);
    if (globe > 0.0005) gl.drawArrays(gl.POINTS, 0, this.count);
    // Download progress: a dotted ring around the globe, lit up to the percentage.
    if (this.progress !== null && globe > 0.5) {
      const lit = Math.round((this.progress / 100) * this.ringCount);
      gl.uniform1f(pu("uGlobe"), 1);
      gl.uniform1f(pu("uTime"), 0);
      gl.uniform1f(pu("uYaw"), 0);
      gl.uniform1f(pu("uTilt"), 0);
      gl.uniform1f(pu("uRadius"), radius * 1.24);
      gl.uniform1f(pu("uPointerOn"), 0);
      gl.uniform1f(pu("uPoint"), Math.max(2, this.point * 1.2));
      if (lit > 0) gl.drawArrays(gl.POINTS, this.ringStart, lit);
    }

    // The exact photo returns only once the particles have landed.
    const photo = highResolutionMix(globe);
    if (photo > 0.001) {
      gl.useProgram(this.quads);
      gl.bindVertexArray(this.quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.photo);
      gl.uniform1i(qu("uTex"), 0);
      gl.uniform1f(qu("uTextured"), 1);
      gl.uniform4f(qu("uColor"), 1, 1, 1, photo);
      gl.uniform4f(qu("uUvRect"), box.x0 / this.before.width, box.y0 / this.before.height, box.x1 / this.before.width, box.y1 / this.before.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}
