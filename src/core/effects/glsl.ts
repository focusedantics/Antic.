import { common } from "@/core/gpu/shaders/common";

/**
 * Prelude shared by every effect shader. The input is the layer stack below the
 * effect: premultiplied, display-encoded sRGB, with mipmaps so `srcAvg` can read
 * the average color of a cell in one fetch. gl_FragCoord is in working pixels
 * with y pointing down the image (row 0 is the top).
 */
export const fx = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
uniform vec2 uSize;
uniform float uUnit;
uniform float uSeed;
uniform float uMaxLod;
const float PI = 3.14159265;
const float TAU = 6.2831853;
${common}
vec4 unpremul(vec4 c) { return c.a > 1e-4 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 src(vec2 p) { return unpremul(textureLod(uInput, p / uSize, 0.0)); }
vec4 srcLod(vec2 p, float lod) { return unpremul(textureLod(uInput, p / uSize, clamp(lod, 0.0, uMaxLod))); }
/** Average color over a footprint of about \`size\` pixels around p. */
vec4 srcAvg(vec2 p, float size) { return srcLod(p, log2(max(size, 1.0))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** The image's average brightness (its smallest mip level). */
float meanLuma() { return luma(srcLod(uSize * 0.5, uMaxLod).rgb); }
/** Brightness re-centered on the image's average, so mid-toned photos still use the full range. */
float leveled(float l, float k) { return clamp((l - meanLuma()) * k + 0.5, 0.0, 1.0); }
float sat01(float x) { return clamp(x, 0.0, 1.0); }
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.1379);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.1379);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
mat2 rot(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
/** Anti-aliased coverage of a signed distance in pixels (negative inside). */
float cover(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 saturateColor(vec3 c, float amount) { return clamp(mix(vec3(luma(c)), c, amount), 0.0, 1.0); }
vec3 contrast(vec3 c, float k) { return clamp((c - 0.5) * k + 0.5, 0.0, 1.0); }
/** Perceptual distance for palette matching (Oklab on linear sRGB). */
vec3 labOf(vec3 display) { return toOklab(srgbToLinear3(display)); }
void emit(vec3 c, float a) {
  a = clamp(a, 0.0, 1.0);
  outColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}
float bayer(vec2 cell, int levels) {
  int n = 1 << levels;
  ivec2 p = ivec2(mod(cell, float(n)));
  int v = 0;
  for (int k = 0; k < 3; k++) {
    if (k >= levels) break;
    int xk = (p.x >> k) & 1;
    int yk = (p.y >> k) & 1;
    v |= (((xk ^ yk) << 1) | yk) << (2 * (levels - 1 - k));
  }
  return (float(v) + 0.5) / float(n * n);
}
/** Distance from p to the segment ab. */
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
`;

/** Glyph atlas helpers for text effects (atlas laid out in a grid, see runtime). */
export const glyphs = /* glsl */ `
uniform sampler2D uGlyphs;
uniform vec2 uGlyphGrid;
uniform float uGlyphCount;
/** Coverage (0..1) of glyph \`index\` at \`local\` (0..1 in the cell, y down). */
float glyph(float index, vec2 local, vec2 cellPx) {
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return 0.0;
  vec2 g = vec2(mod(index, uGlyphGrid.x), floor(index / uGlyphGrid.x));
  vec2 uv = (g + local) / uGlyphGrid;
  vec2 d = 1.0 / (cellPx * uGlyphGrid);
  return textureGrad(uGlyphs, uv, vec2(d.x, 0.0), vec2(0.0, d.y)).a;
}
`;
