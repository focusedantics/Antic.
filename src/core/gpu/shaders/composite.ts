import { common, header } from "./common";

/**
 * Compositing happens in display-encoded sRGB with premultiplied alpha, like
 * Photoshop's default, so Multiply/Screen/Overlay look the way designers expect.
 */

/** Develop output (linear Rec.2020, straight alpha) → display-encoded straight alpha. */
export const toDisplayStraight = `${header}
${common}
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vUv);
  outColor = vec4(toDisplay(c.rgb), c.a);
}`;

/**
 * Places one layer's content on the canvas. uKind: 0 texture, 1 gradient, 2 solid fill.
 * Output is premultiplied.
 */
export const place = `${header}
${common}
uniform sampler2D uContent;
uniform sampler2D uMask;
uniform mat3 uToContent;      // working px → content uv
uniform vec4 uCrop;           // left, top, right, bottom
uniform int uKind;
uniform vec4 uColor;          // fill color (straight, display-encoded) and alpha
uniform int uMaskOn;
uniform int uMaskInvert;
uniform float uMaskDensity;
uniform float uFill;          // fill opacity (for non-special blend modes it scales alpha)
// Gradient
uniform int uGradType;        // 0 linear, 1 radial
uniform vec2 uGradDir;        // unit direction of the ramp in content uv (aspect corrected)
uniform float uGradScale;
uniform vec2 uGradOffset;
uniform float uGradAspect;
uniform int uGradReverse;
uniform int uStopCount;
uniform float uStopOffsets[16];
uniform vec4 uStopColors[16];

vec4 gradientAt(vec2 uv) {
  vec2 p = (uv - 0.5 - uGradOffset * 0.5) * vec2(uGradAspect, 1.0);
  float t;
  if (uGradType == 0) {
    float halfLen = 0.5 * (abs(uGradDir.x) * uGradAspect + abs(uGradDir.y)) * uGradScale;
    t = dot(p, uGradDir) / max(halfLen, 1e-4) * 0.5 + 0.5;
  } else {
    float radius = 0.5 * max(uGradAspect, 1.0) * uGradScale;
    t = length(p) / max(radius, 1e-4);
  }
  t = clamp(t, 0.0, 1.0);
  if (uGradReverse == 1) t = 1.0 - t;
  vec4 c = uStopColors[0];
  for (int i = 1; i < 16; i++) {
    if (i >= uStopCount) break;
    float a = uStopOffsets[i - 1];
    float b = uStopOffsets[i];
    if (t >= a) c = t >= b ? uStopColors[i] : mix(uStopColors[i - 1], uStopColors[i], (t - a) / max(b - a, 1e-5));
  }
  return c;
}

void main() {
  vec3 h = uToContent * vec3(gl_FragCoord.xy, 1.0);
  vec2 uv = h.xy / h.z;
  if (h.z <= 0.0 || uv.x < uCrop.x || uv.y < uCrop.y || uv.x > uCrop.z || uv.y > uCrop.w) { outColor = vec4(0.0); return; }
  vec4 c;
  if (uKind == 0) c = texture(uContent, uv);
  else if (uKind == 1) c = gradientAt(uv);
  else c = uColor;
  float a = c.a * uFill;
  if (uMaskOn == 1) {
    float m = texture(uMask, uv).r;
    if (uMaskInvert == 1) m = 1.0 - m;
    a *= 1.0 - uMaskDensity * (1.0 - m);
  }
  outColor = vec4(c.rgb * a, a);
}`;

/** W3C Compositing and Blending Level 1, plus Photoshop's extra modes. */
export const blend = `${header}
${common}
uniform sampler2D uBackdrop;
uniform sampler2D uSource;
uniform sampler2D uClipBase;
uniform int uMode;
uniform float uOpacity;
uniform float uSpecialFill;   // fill opacity for the 8 "special" modes, applied to the blend effect
uniform int uAtop;            // clipping: keep the backdrop's alpha

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}

float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float colorDodge(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float colorBurn(float b, float s) { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }

float sep(int m, float b, float s) {
  if (m == 1) return min(b, s);
  if (m == 2) return b * s;
  if (m == 3) return colorBurn(b, s);
  if (m == 4) return max(0.0, b + s - 1.0);
  if (m == 5) return max(b, s);
  if (m == 6) return b + s - b * s;
  if (m == 7) return colorDodge(b, s);
  if (m == 8) return min(1.0, b + s);
  if (m == 9) return hardLight(s, b);
  if (m == 10) return softLight(b, s);
  if (m == 11) return hardLight(b, s);
  if (m == 12) return s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * s - 1.0);
  if (m == 13) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (m == 14) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
  if (m == 15) return b + s >= 1.0 ? 1.0 : 0.0;
  if (m == 16) return abs(b - s);
  if (m == 17) return b + s - 2.0 * b * s;
  if (m == 18) return max(0.0, b - s);
  if (m == 19) return s <= 0.0 ? 1.0 : min(1.0, b / s);
  return s;
}

vec3 blendColor(int m, vec3 b, vec3 s) {
  if (m == 20) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 21) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 22) return setLum(s, lum(b));
  if (m == 23) return setLum(b, lum(s));
  return vec3(sep(m, b.r, s.r), sep(m, b.g, s.g), sep(m, b.b, s.b));
}

void main() {
  vec4 B = texelFetch(uBackdrop, ivec2(gl_FragCoord.xy), 0);
  vec4 S = texelFetch(uSource, ivec2(gl_FragCoord.xy), 0) * uOpacity;
  float ab = B.a;
  float as_ = S.a;
  vec3 cb = ab > 0.0 ? B.rgb / ab : vec3(0.0);
  vec3 cs = as_ > 0.0 ? S.rgb / as_ : vec3(0.0);
  vec3 mixed = clamp(blendColor(uMode, cb, cs), 0.0, 1.0);
  // Photoshop's fill opacity on the special modes fades the blend effect, not the layer.
  mixed = mix(cb, mixed, uSpecialFill);
  // Cs' = (1 - ab) Cs + ab B(Cb, Cs); then source-over.
  vec3 csPrime = (1.0 - ab) * cs + ab * mixed;
  vec3 color = as_ * csPrime + (1.0 - as_) * B.rgb;
  float alpha = as_ + ab * (1.0 - as_);
  if (uAtop == 1) {
    // Clipping: the source only shows where the base is, and the base keeps its alpha.
    vec3 atopColor = as_ * csPrime * ab + (1.0 - as_) * B.rgb;
    outColor = vec4(atopColor, ab);
    return;
  }
  outColor = vec4(color, alpha);
}`;

/** Premultiplied display → linear Rec.2020 straight (for adjustment layers). */
export const displayToLinear = `${header}
${common}
uniform sampler2D uInput;
void main() {
  vec4 c = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  vec3 straight = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  outColor = vec4(SRGB_TO_REC2020 * srgbToLinear3(clamp(straight, 0.0, 1.0)), c.a);
}`;

/** Adjusted linear result back to premultiplied display, mixed with the original by mask and opacity. */
export const linearToDisplayMix = `${header}
${common}
uniform sampler2D uAdjusted;
uniform sampler2D uOriginal;
uniform sampler2D uMask;
uniform mat3 uToContent;
uniform int uMaskOn;
uniform int uMaskInvert;
uniform float uMaskDensity;
uniform float uOpacity;
void main() {
  vec4 o = texelFetch(uOriginal, ivec2(gl_FragCoord.xy), 0);
  vec4 a = texelFetch(uAdjusted, ivec2(gl_FragCoord.xy), 0);
  vec3 adjusted = toDisplay(a.rgb) * o.a;
  float k = uOpacity;
  if (uMaskOn == 1) {
    vec3 h = uToContent * vec3(gl_FragCoord.xy, 1.0);
    vec2 uv = h.xy / h.z;
    float m = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.0 : texture(uMask, uv).r;
    if (uMaskInvert == 1) m = 1.0 - m;
    k *= 1.0 - uMaskDensity * (1.0 - m);
  }
  outColor = vec4(mix(o.rgb, adjusted, k), o.a);
}`;

/** Canvas background: solid color or transparent. */
export const solid = `${header}
uniform vec4 uColor;
void main() { outColor = uColor; }`;

/** Shows the composite on screen: zoom/pan, checkerboard under transparency, pasteboard around the canvas. */
export const compositeDisplay = `${header}
uniform sampler2D uImage;
uniform mat3 uScreenToDoc;   // screen device px → document px
uniform vec2 uDocSize;
uniform vec2 uCanvasSize;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
  vec3 h = uScreenToDoc * vec3(px, 1.0);
  vec2 d = h.xy / h.z;
  if (d.x < 0.0 || d.y < 0.0 || d.x > uDocSize.x || d.y > uDocSize.y) { outColor = vec4(0.0); return; }
  vec4 c = texture(uImage, d / uDocSize);
  vec2 cell = floor(px / 8.0);
  vec3 checker = mod(cell.x + cell.y, 2.0) < 1.0 ? vec3(0.8) : vec3(0.62);
  outColor = vec4(c.rgb + checker * (1.0 - c.a), 1.0);
}`;

/** Scales premultiplied content by a layer mask (content space) and fill opacity. */
export const maskContent = `${header}
uniform sampler2D uInput;
uniform sampler2D uMask;
uniform mat3 uToContent;
uniform int uMaskOn;
uniform int uMaskInvert;
uniform float uMaskDensity;
uniform float uFill;
void main() {
  vec4 c = texture(uInput, vUv);
  float a = uFill;
  if (uMaskOn == 1) {
    vec3 h = uToContent * vec3(gl_FragCoord.xy, 1.0);
    float m = texture(uMask, clamp(h.xy / h.z, 0.0, 1.0)).r;
    if (uMaskInvert == 1) m = 1.0 - m;
    a *= 1.0 - uMaskDensity * (1.0 - m);
  }
  outColor = c * a;
}`;

/**
 * A photo frame's content: the photo covering the frame, zoomed and panned (uMap: the
 * photo's centre in frame uv and its size in frame widths/heights), cut to the frame's
 * shape (uShape alpha). Straight alpha, like other layer content.
 */
export const slotFill = `${header}
uniform sampler2D uPhoto;
uniform sampler2D uShape;
uniform vec4 uMap;
void main() {
  vec2 uv = (vUv - uMap.xy) / uMap.zw + 0.5;
  vec4 c = texture(uPhoto, clamp(uv, 0.0, 1.0));
  outColor = vec4(c.rgb, c.a * texture(uShape, vUv).a);
}`;

/**
 * One step of an outline's dilation: the most coverage within uRadius texels, sampled
 * at the centre and on a ring of 12. Steps of halving radii add up to the full width
 * (their Minkowski sum fills the disc). uChannel 3 reads the input's alpha, 0 its red.
 */
export const dilate = `${header}
uniform sampler2D uInput;
uniform vec2 uTexel;
uniform float uRadius;
uniform int uChannel;
float cov(vec2 uv) { vec4 c = texture(uInput, uv); return uChannel == 3 ? c.a : c.r; }
void main() {
  float m = cov(vUv);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235987756;
    m = max(m, cov(vUv + vec2(cos(a), sin(a)) * uRadius * uTexel));
  }
  outColor = vec4(m, m, m, 1.0);
}`;

/**
 * Layer styles under the layer's own pixels (premultiplied): drop shadow, outer glow and
 * outline, in that order from the bottom. uFill fades the layer's pixels but not its styles
 * (so a layer at 0 % fill shows only its outline or shadow, as in Photoshop).
 */
export const layerStyle = `${header}
uniform sampler2D uContent;
uniform sampler2D uShadow;
uniform sampler2D uGlow;
uniform sampler2D uOutline;
uniform float uFill;
uniform int uShadowOn;
uniform vec4 uShadowColor;     // rgb straight, a = opacity
uniform vec2 uShadowOffset;    // uv
uniform float uShadowSpread;
uniform int uGlowOn;
uniform vec4 uGlowColor;
uniform float uGlowSpread;
uniform int uOutlineOn;
uniform vec4 uOutlineColor;
float spreadOut(float a, float s) { return clamp(a / max(1.0 - s, 0.02), 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
void main() {
  vec4 c = texture(uContent, vUv) * uFill;
  vec4 acc = vec4(0.0);
  if (uShadowOn == 1) {
    float a = spreadOut(texture(uShadow, vUv - uShadowOffset).a, uShadowSpread) * uShadowColor.a;
    acc = vec4(uShadowColor.rgb * a, a);
  }
  if (uGlowOn == 1) {
    float a = spreadOut(texture(uGlow, vUv).a, uGlowSpread) * uGlowColor.a;
    acc = over(vec4(uGlowColor.rgb * a, a), acc);
  }
  if (uOutlineOn == 1) {
    float a = texture(uOutline, vUv).r * uOutlineColor.a;
    acc = over(vec4(uOutlineColor.rgb * a, a), acc);
  }
  outColor = over(c, acc);
}`;
