/*
 * The export marble: a glass marble with swirling pigment and, floating inside
 * it, a small preview of what is being exported.
 *
 * Adapted from "Magic Marble" by Originkit (https://www.originkit.dev/), MIT,
 * which builds on Matt Rossman's magic-marble tutorial (the volume ray march:
 * slices of a height map accumulated along the view ray inside the sphere).
 * Changes: plain WebGL2 instead of three.js; the height and displacement maps are
 * a procedural 3D noise texture made on the CPU (no network fetches), the HDRI is a
 * procedural studio; the march is front-to-back so a preview card floating in the
 * marble can be seen through the pigment; refraction, Fresnel reflection and a
 * capped frame rate; the same drag-to-spin and click-to-change-colour.
 */

const VERT = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vNdc;
void main() { vNdc = P[gl_VertexID]; gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vNdc;
out vec4 o;
uniform vec3 uEye;
uniform mat3 uCam;      // columns: right, up, forward
uniform float uTan;     // tan(fov / 2)
uniform float uAspect;
uniform float uPx;      // one pixel, in world units at the marble
uniform float uScale;   // press feedback
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uDepth;
uniform float uSmooth;
uniform float uDisplace;
uniform sampler3D uNoise;
uniform sampler2D uCard;
uniform float uHasCard;
uniform vec2 uCardSize;  // half extents in sphere units
uniform mat3 uCardRot;   // card orientation (columns: u axis, v axis, normal)
uniform vec3 uCardPos;

const int STEPS = 40;

float noise(vec3 p) { return texture(uNoise, p).r; }

/**
 * The pigment field (the original's height map). A true 3D field rather than a
 * direction-only one, so the slices form swirling layers instead of radial streaks;
 * the scrolling displacement makes it flow.
 */
float heightAt(vec3 p) {
  vec3 scroll = vec3(uTime, 0.0, uTime * 0.6);
  vec3 disp = vec3(noise(p * 0.21 + scroll), noise(p * 0.21 + 0.37 - scroll), noise(p * 0.21 + 0.71 + scroll.zxy)) - 0.5;
  vec3 q = p + uDisplace * 6.0 * disp;
  float h = noise(q * 0.16) * 0.6 + noise(q * 0.34 + 0.5) * 0.28 + noise(q * 0.7 + 0.25) * 0.12;
  return smoothstep(0.42, 0.8, h);
}

/** A soft studio: warm and cool softboxes over a dim floor (stands in for the HDRI). */
vec3 studio(vec3 r) {
  vec3 c = mix(vec3(0.03), vec3(0.32, 0.33, 0.36), smoothstep(-0.3, 0.6, r.y));
  c += vec3(1.0, 0.95, 0.88) * 2.2 * pow(max(0.0, dot(r, normalize(vec3(-0.6, 0.7, 0.4)))), 24.0);
  c += vec3(0.75, 0.85, 1.0) * 1.2 * pow(max(0.0, dot(r, normalize(vec3(0.8, 0.3, 0.2)))), 12.0);
  c += 0.25 * smoothstep(0.6, 1.0, r.y);
  return c;
}

/** Where the ray meets the floating card (distance, or -1), and its colour. */
float cardHit(vec3 ro, vec3 rd, out vec3 color) {
  color = vec3(0.0);
  if (uHasCard < 0.5) return -1.0;
  vec3 n = uCardRot[2];
  float denom = dot(rd, n);
  if (abs(denom) < 1e-4) return -1.0;
  float t = dot(uCardPos - ro, n) / denom;
  if (t <= 0.0) return -1.0;
  vec3 h = ro + rd * t - uCardPos;
  vec2 uv = vec2(dot(h, uCardRot[0]), dot(h, uCardRot[1])) / uCardSize;
  // Rounded corners.
  vec2 k = max(abs(uv) - (1.0 - 0.12), 0.0);
  if (length(k) > 0.12) return -1.0;
  color = texture(uCard, vec2(uv.x, -uv.y) * 0.5 + 0.5).rgb;
  // Its back is a little darker, like a print seen from behind.
  if (denom > 0.0) color *= 0.55;
  return t;
}

void main() {
  vec3 rd = normalize(uCam * vec3(vNdc.x * uTan * uAspect, vNdc.y * uTan, 1.0));
  vec3 ro = uEye;
  float r = uScale;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) { o = vec4(0.0); return; }
  float s = sqrt(disc);
  float t0 = -b - s;
  vec3 p0 = (ro + rd * t0) / r;
  vec3 n = normalize(p0);
  // Into the glass.
  vec3 ri = refract(rd, n, 1.0 / 1.35);
  float tExit = -2.0 * dot(p0, ri);
  vec3 cardColor;
  float tc = cardHit(p0, ri, cardColor);
  if (tc > tExit) tc = -1.0;

  // The original's march: slices of the height field accumulated along the ray, a fixed
  // depth into the marble. Pigment in front of the card veils it; the rest shows the card.
  float len = min(uDepth, tExit);
  float front = 0.0;
  float total = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float f = (float(i) + 0.5) / float(STEPS);
    float tt = f * len;
    vec3 p = p0 + ri * tt;
    float cutoff = 1.0 - f;
    float slice = smoothstep(cutoff, cutoff + uSmooth, heightAt(p)) / float(STEPS);
    total += slice;
    if (tc < 0.0 || tt < tc) front += slice;
  }
  vec3 col = tc > 0.0 ? mix(cardColor, uColor, smoothstep(0.08, 0.75, front) * 0.7) : mix(uCore, uColor, total);

  // Glass: diffuse-ish light on the pigment, Fresnel reflection of the studio and highlights.
  vec3 refl = reflect(rd, n);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  col *= 0.75 + 0.35 * max(n.y, 0.0);
  col = mix(col, studio(refl), fres);
  col += studio(refl) * 0.08;
  // Soft edge for anti-aliasing.
  vec3 closest = ro + rd * (-b);
  float edge = clamp((r - length(closest)) / uPx, 0.0, 1.0);
  col = col / (1.0 + col * 0.25);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 1.15));
  o = vec4(col * edge, edge);
}`;

const PALETTE = ["#FF0000", "#FFFF00", "#00FF80", "#5252E0", "#CCCCCC"];
const CAMERA_DIST = 2.6;
const CAMERA_TILT = 0.22;
const PITCH_LIMIT = 1.0;

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Periodic 3D value-noise lattice; trilinear filtering of it is the noise. */
function noiseVolume(size: number): Uint8Array {
  const data = new Uint8Array(size * size * size);
  let seed = 1234567;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[i] = seed >>> 24;
  }
  return data;
}

export type MarbleOptions = { reducedMotion: boolean };

/** Renders the marble into its own canvas inside `host` until `dispose()`. */
export class Marble {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private card: WebGLTexture | null = null;
  private cardAspect = 1;
  private hasCard = false;
  private raf = 0;
  private last = 0;
  private lastDraw = 0;
  private time = 0;
  private azimuth = 0;
  private elevation = 0;
  private velAz = 0;
  private velEl = 0;
  private step = 0;
  private color = hex(PALETTE[0]);
  private target = hex(PALETTE[0]);
  private scale = 1;
  private pressed = false;
  private dragging = false;
  private down = { x: 0, y: 0 };
  private lastPtr = { x: 0, y: 0 };
  /** WebGL on the CPU (SwiftShader, llvmpipe): fewer frames and pixels. */
  private software = false;

  constructor(
    host: HTMLElement,
    private options: MarbleOptions,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "marble-canvas";
    host.append(this.canvas);
    this.gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: "low-power" });
    if (!this.gl) return;
    try {
      const info = this.gl.getExtension("WEBGL_debug_renderer_info");
      this.software = /swiftshader|llvmpipe|software/i.test(String(this.gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : this.gl.RENDERER)));
      this.init(this.gl);
    } catch (error) {
      console.warn(error);
      this.gl = null;
      return;
    }
    this.canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.raf = requestAnimationFrame(this.frame);
  }

  get ready() {
    return !!this.gl;
  }

  private init(gl: WebGL2RenderingContext) {
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Marble shader: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Marble link: ${gl.getProgramInfoLog(prog)}`);
    this.program = prog;
    for (const name of ["uEye", "uCam", "uTan", "uAspect", "uPx", "uScale", "uTime", "uColor", "uCore", "uDepth", "uSmooth", "uDisplace", "uNoise", "uCard", "uHasCard", "uCardSize", "uCardRot", "uCardPos"])
      this.u[name] = gl.getUniformLocation(prog, name);
    gl.bindVertexArray(gl.createVertexArray());
    const size = 32;
    const noise = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, noise);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, noiseVolume(size));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
    this.card = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.card);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** The picture floating in the marble (a small bitmap; null removes it). */
  setPreview(image: ImageBitmap | null) {
    const gl = this.gl;
    if (!gl || !this.card) return;
    this.hasCard = !!image;
    if (!image) return;
    this.cardAspect = image.width / Math.max(1, image.height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.card);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.lastDraw = 0;
  }

  setOptions(options: MarbleOptions) {
    this.options = options;
    this.lastDraw = 0;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.canvas.remove();
  }

  private hits(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    return x * x + y * y < 0.62;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pressed = this.hits(e);
    this.dragging = true;
    this.down = { x: e.clientX, y: e.clientY };
    this.lastPtr = { ...this.down };
    this.velAz = this.velEl = 0;
    this.canvas.style.cursor = "grabbing";
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastPtr.x;
    const dy = e.clientY - this.lastPtr.y;
    this.lastPtr = { x: e.clientX, y: e.clientY };
    const s = 0.02;
    this.azimuth -= dx * s;
    this.elevation = Math.max(-PITCH_LIMIT - CAMERA_TILT, Math.min(PITCH_LIMIT - CAMERA_TILT, this.elevation + dy * s));
    this.velAz = -dx * s;
    this.velEl = dy * s;
    this.lastDraw = 0;
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = "";
    const wasPressed = this.pressed;
    this.pressed = false;
    // A click (not a drag) on the marble swirls it to the next colour.
    if (wasPressed && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5 && this.hits(e)) {
      this.step++;
      this.target = hex(PALETTE[this.step % PALETTE.length]);
      this.time += 0.2;
    }
  };

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const gl = this.gl;
    if (!gl || !this.program || document.hidden) return;
    const still = this.options.reducedMotion && !this.dragging;
    const interval = this.software ? 1000 / 12 : 1000 / 30;
    if (now - this.lastDraw < interval || (still && this.lastDraw > 0)) return;
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    this.lastDraw = now;

    if (!still) {
      this.time += dt * 0.05;
      if (!this.dragging) {
        const decay = Math.exp(-dt * 3);
        this.azimuth += this.velAz + dt * 0.48;
        this.elevation = Math.max(-PITCH_LIMIT - CAMERA_TILT, Math.min(PITCH_LIMIT - CAMERA_TILT, this.elevation + this.velEl));
        this.velAz *= decay;
        this.velEl *= decay;
      }
    }
    const k = 1 - Math.exp(-dt * 2);
    this.color = this.color.map((c, i) => c + (this.target[i] - c) * k) as [number, number, number];
    this.scale += ((this.pressed ? 0.95 : 1) - this.scale) * (1 - Math.exp(-dt * 14));

    const cssW = this.canvas.clientWidth || 1;
    const cssH = this.canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, this.software ? 1 : 1.5);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const pitch = CAMERA_TILT + this.elevation;
    const eye = [Math.sin(this.azimuth) * Math.cos(pitch) * CAMERA_DIST, Math.sin(pitch) * CAMERA_DIST, Math.cos(this.azimuth) * Math.cos(pitch) * CAMERA_DIST];
    const len = Math.hypot(eye[0], eye[1], eye[2]);
    const fwd = eye.map((v) => -v / len);
    const rightRaw = [fwd[2], 0, -fwd[0]].map((v) => -v);
    const rl = Math.hypot(rightRaw[0], rightRaw[1], rightRaw[2]) || 1;
    const right = rightRaw.map((v) => v / rl);
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];

    // The card floats facing the viewer, wobbling and drifting gently so it stays readable
    // while the marble turns around it.
    const t = now / 1000;
    const yaw = still ? 0.25 : Math.sin(t * 0.6) * 0.5;
    const tilt = still ? -0.15 : Math.sin(t * 0.43) * 0.3;
    const back = fwd.map((v) => -v);
    const mix = (a: number[], b: number[], ca: number, sb: number) => a.map((v, i) => v * ca + b[i] * sb);
    // Yaw turns right towards the viewer axis; tilt turns up towards it.
    const uAxis = mix(right, back, Math.cos(yaw), Math.sin(yaw));
    const n1 = mix(back, right, Math.cos(yaw), -Math.sin(yaw));
    const vAxis = mix(up, n1, Math.cos(tilt), Math.sin(tilt));
    const nAxis = mix(n1, up, Math.cos(tilt), -Math.sin(tilt));
    const maxHalf = 0.52;
    const cardSize = this.cardAspect >= 1 ? [maxHalf, maxHalf / this.cardAspect] : [maxHalf * this.cardAspect, maxHalf];
    const dx = still ? 0 : Math.sin(t * 0.5) * 0.1;
    const dy = still ? 0 : Math.sin(t * 0.7) * 0.08;
    const cardPos = right.map((v, i) => v * dx + up[i] * dy);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    const u = this.u;
    gl.uniform3fv(u.uEye, eye);
    gl.uniformMatrix3fv(u.uCam, false, [...right, ...up, ...fwd]);
    // The marble fills about 82% of the canvas height.
    const tan = Math.tan(Math.asin(1 / CAMERA_DIST)) / 0.82;
    gl.uniform1f(u.uTan, tan);
    gl.uniform1f(u.uAspect, w / h);
    gl.uniform1f(u.uPx, (2 * tan * CAMERA_DIST) / h);
    gl.uniform1f(u.uScale, this.scale);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform3fv(u.uColor, this.color);
    gl.uniform3fv(u.uCore, [0.01, 0.01, 0.015]);
    gl.uniform1f(u.uDepth, 0.6);
    gl.uniform1f(u.uSmooth, 0.2);
    gl.uniform1f(u.uDisplace, 0.1);
    gl.uniform1i(u.uNoise, 0);
    gl.uniform1i(u.uCard, 1);
    gl.uniform1f(u.uHasCard, this.hasCard ? 1 : 0);
    gl.uniform2fv(u.uCardSize, cardSize);
    gl.uniformMatrix3fv(u.uCardRot, false, [...uAxis, ...vAxis, ...nAxis]);
    gl.uniform3fv(u.uCardPos, cardPos);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

/** Shrinks any picture source to a small bitmap for the marble (fast to upload, smooth to sample). */
export async function previewBitmap(source: Blob | ImageBitmap | string, max = 192): Promise<ImageBitmap | null> {
  try {
    const blob = typeof source === "string" ? await (await fetch(source)).blob() : source;
    const full = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(full.width, full.height));
    if (scale >= 1 && source !== full) return full;
    const small = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * scale)), resizeHeight: Math.max(1, Math.round(full.height * scale)), resizeQuality: "medium" });
    if (full !== source) full.close();
    return small;
  } catch {
    return null;
  }
}
