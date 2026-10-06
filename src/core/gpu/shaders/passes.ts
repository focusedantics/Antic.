import { common, header } from "./common";
import { tone } from "./tone";

/** RAW: LibRaw's linear 16-bit Rec.2020 samples → RGBA16F working space. */
export const sourceRgb16 = `${header}
uniform usampler2D uSource;
uniform float uWhite;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec3 v = texelFetch(uSource, p, 0).rgb;
  outColor = vec4(vec3(v) / uWhite, 1.0);
}`;

/**
 * RAW, smaller than the original (phones keep a smaller working copy): each output
 * pixel averages the block of samples it covers. Integer textures cannot be filtered.
 */
export const sourceRgb16Box = `${header}
uniform usampler2D uSource;
uniform float uWhite;
uniform vec2 uScale;
void main() {
  ivec2 size = textureSize(uSource, 0);
  vec2 o = floor(gl_FragCoord.xy);
  ivec2 a = min(size - 1, ivec2(floor(o * uScale)));
  ivec2 b = min(size, max(a + 1, ivec2(floor((o + 1.0) * uScale))));
  vec3 sum = vec3(0.0);
  float n = 0.0;
  for (int y = a.y; y < b.y; y++)
    for (int x = a.x; x < b.x; x++) {
      sum += vec3(texelFetch(uSource, ivec2(x, y), 0).rgb);
      n += 1.0;
    }
  outColor = vec4(sum / (max(n, 1.0) * uWhite), 1.0);
}`;

/** Probe for `srgbSourcesWork`: a mip level of a black/white checker, and an sRGB 128 texel. */
export const srgbProbe = `${header}
uniform sampler2D uChecker;
uniform sampler2D uGray;
void main() {
  outColor = gl_FragCoord.x < 1.0 ? textureLod(uChecker, vec2(0.5), 2.0) : texelFetch(uGray, ivec2(0), 0);
}`;

/** Rendered files: sRGB-encoded 8-bit (decoded to linear by the texture format) → linear Rec.2020. */
export const sourceSrgb = `${header}
${common}
uniform sampler2D uSource;
void main() {
  vec4 c = texelFetch(uSource, ivec2(gl_FragCoord.xy), 0);
  outColor = vec4(SRGB_TO_REC2020 * c.rgb, c.a);
}`;

/**
 * Geometry: output uv → source uv through the recipe's homography, then lens
 * distortion and vignetting correction around the source center.
 */
export const geometry = `${header}
${common}
uniform sampler2D uBase;
uniform mat3 uOutToSrc;
uniform vec2 uSrcSize;
uniform vec2 uOutSize;
uniform float uDistortion;
uniform float uVignetting;
uniform float uVignettingMid;
uniform float uLodBias;
// 1: the base is an 8-bit sRGB texture (linear sRGB once sampled), not linear Rec.2020.
uniform int uBaseSrgb;
void main() {
  // Texel row 0 is the top of the image in every working texture.
  vec3 h = uOutToSrc * vec3(vUv, 1.0);
  vec2 uv = h.xy / h.z;
  // Lens distortion in pixels, normalized so the corners stay fixed.
  vec2 half_ = uSrcSize * 0.5;
  vec2 d = (uv - 0.5) * uSrcSize;
  float diag = length(half_);
  float r2 = dot(d, d) / (diag * diag);
  if (uDistortion != 0.0) {
    float a = uDistortion;
    d *= (1.0 - a * r2) / (1.0 - a);
    uv = d / uSrcSize + 0.5;
  }
  // Level of detail from the local scale of the mapping, taken before any pixel leaves
  // (derivatives across pixels that returned are undefined).
  vec2 dx = dFdx(uv) * uSrcSize;
  vec2 dy = dFdy(uv) * uSrcSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = vec4(0.0); return; }
  float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))) + uLodBias);
  vec4 c = textureLod(uBase, vec2(uv.x, uv.y), lod);
  // A linear map, so converting after filtering equals filtering converted texels.
  if (uBaseSrgb == 1) c.rgb = SRGB_TO_REC2020 * c.rgb;
  if (uVignetting != 0.0) {
    float r = sqrt(r2);
    float shape = pow(r, uVignettingMid);
    c.rgb *= exp2(uVignetting * shape);
  }
  outColor = c;
}`;

/** White balance (Bradford matrix) and exposure. */
export const prepare = `${header}
${common}
${tone}
uniform sampler2D uInput;
uniform mat3 uWhiteBalance;
uniform float uExposure;
void main() {
  vec4 c = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  vec3 rgb = uWhiteBalance * c.rgb;
  rgb = adjustExposure(rgb, uExposure);
  outColor = vec4(rgb, c.a);
}`;

/** Perceptual lightness (R) and linear dark channel (G) at half resolution, for local contrast and dehaze. */
export const lightness = `${header}
${common}
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vUv);
  outColor = vec4(linearToSrgb(luminance(max(c.rgb, 0.0))), max(min(c.r, min(c.g, c.b)), 0.0), 0.0, 1.0);
}`;

/** 2× box downsample. */
export const downsample = `${header}
uniform sampler2D uInput;
uniform vec2 uTexel;
void main() {
  vec4 a = texture(uInput, vUv + uTexel * vec2(-0.5, -0.5));
  vec4 b = texture(uInput, vUv + uTexel * vec2(0.5, -0.5));
  vec4 c = texture(uInput, vUv + uTexel * vec2(-0.5, 0.5));
  vec4 d = texture(uInput, vUv + uTexel * vec2(0.5, 0.5));
  outColor = (a + b + c + d) * 0.25;
}`;

/** Separable Gaussian; uDirection is one texel along the blur axis. */
export const blur = `${header}
uniform sampler2D uInput;
uniform vec2 uDirection;
uniform float uSigma;
void main() {
  if (uSigma < 0.3) { outColor = texture(uInput, vUv); return; }
  int radius = int(ceil(uSigma * 3.0));
  vec4 total = vec4(0.0);
  float weights = 0.0;
  // Pairs of taps with linear filtering halve the fetches.
  for (int i = -radius; i <= radius; i += 2) {
    float o1 = float(i);
    float o2 = float(i + 1);
    float w1 = exp(-0.5 * o1 * o1 / (uSigma * uSigma));
    float w2 = i + 1 <= radius ? exp(-0.5 * o2 * o2 / (uSigma * uSigma)) : 0.0;
    float w = w1 + w2;
    float o = w > 0.0 ? (o1 * w1 + o2 * w2) / w : o1;
    total += texture(uInput, vUv + uDirection * o) * w;
    weights += w;
  }
  outColor = total / weights;
}`;

export const toneAndColor = `${header}
${common}
${tone}
uniform sampler2D uInput;
uniform sampler2D uBlurSmall;
uniform sampler2D uBlurLarge;
uniform sampler2D uCurves;
uniform float uHighlights, uShadows, uWhites, uBlacks, uContrast;
uniform float uTexture, uClarity, uDehaze;
uniform vec3 uAtmosphere;
uniform float uVibrance, uSaturation;
uniform int uProfileCurve;
uniform int uMonochrome;
uniform int uCurvesActive;
uniform int uMixerActive;
uniform vec4 uMixer[8];
uniform int uGradingActive;
uniform vec3 uGradeShadows, uGradeMidtones, uGradeHighlights, uGradeGlobal;
uniform vec2 uGradeLum3;
uniform vec2 uGradeLum3b;
uniform vec2 uGradeBalance;

// Base rendering for camera RAW ("Color" profile): a filmic curve on luminance with a
// highlight shoulder, so scene-referred sensor data looks like a finished photograph.
float profileCurve(float x) {
  if (x <= 0.0) return 0.0;
  // Middle gray (18 %) lands at 41.5 % perceptual (calibrated against camera JPEGs); the shoulder above it is softer than the toe.
  const float anchor = 0.415;
  float ev = log2(x / 0.18);
  float range = ev > 0.0 ? 1.0 - anchor : anchor;
  float k = ev > 0.0 ? 0.29 : 0.24;
  return srgbToLinear(anchor + range * tanh(ev * k / range));
}

float softDetail(float d, float limit) { return d / (1.0 + abs(d) / limit); }

vec3 applyLuminance(vec3 c, float targetPerceptual) {
  float y = luminance(c);
  float target = srgbToLinear(max(targetPerceptual, 0.0));
  if (y <= 1e-6) return c + vec3(target);
  return c * (target / y);
}

float curve(float x, int channel) {
  // Curves are defined on perceptual 0..1; headroom above 1 follows the curve's end.
  float p = linearToSrgb(x);
  if (p >= 1.0) return x * srgbToLinear(texture(uCurves, vec2(1.0, 0.5))[channel]);
  float u = (p * 1023.0 + 0.5) / 1024.0;
  return srgbToLinear(texture(uCurves, vec2(u, 0.5))[channel]);
}

vec3 mixColor(vec3 color) {
  float light = luminance(color);
  if (light <= 0.0) return color;
  vec3 lab = toOklab(REC2020_TO_SRGB * color);
  float strength = smoothstep(0.01, 0.04, length(lab.yz) / max(abs(lab.x), 1e-6));
  float hue = degrees(atan(lab.z, lab.y));
  if (hue < uMixer[0].w) hue += 360.0;
  vec3 change = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    int n = (i + 1) % 8;
    float end = uMixer[n].w + (n == 0 ? 360.0 : 0.0);
    if (hue >= uMixer[i].w && hue <= end) {
      change = mix(uMixer[i].xyz, uMixer[n].xyz, smoothstep(uMixer[i].w, end, hue));
      break;
    }
  }
  change *= strength / 100.0;
  if (change == vec3(0.0)) return color;
  float angle = radians(change.x * 30.0);
  mat2 rot = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  vec2 chroma = rot * lab.yz * (1.0 + change.y);
  vec3 mixed = SRGB_TO_REC2020 * fromOklab(vec3(lab.x, chroma));
  return (mixed + vec3(light - luminance(mixed))) * exp2(change.z);
}

vec3 grade(vec3 color) {
  vec3 lab = toOklab(REC2020_TO_SRGB * max(color, 0.0));
  float l = clamp(lab.x, 0.0, 1.0);
  // Region weights: blending widens the overlap, balance moves the split point.
  float pivot = 0.5 + uGradeBalance.x * 0.25;
  float width = uGradeBalance.y;
  float ws = 1.0 - smoothstep(pivot - width, pivot + width * 0.25, l);
  float wh = smoothstep(pivot - width * 0.25, pivot + width, l);
  float wm = max(0.0, 1.0 - ws - wh);
  vec2 ab = uGradeShadows.xy * ws + uGradeMidtones.xy * wm + uGradeHighlights.xy * wh + uGradeGlobal.xy;
  float dl = uGradeShadows.z * ws + uGradeMidtones.z * wm + uGradeHighlights.z * wh + uGradeGlobal.z;
  lab.yz += ab;
  lab.x = max(0.0, lab.x + dl * 0.15);
  return SRGB_TO_REC2020 * fromOklab(lab);
}

void main() {
  vec4 src = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  vec3 c = max(src.rgb, 0.0);

  if (uDehaze != 0.0) {
    float dark = texture(uBlurLarge, vUv).g;
    float a = max(dot(uAtmosphere, vec3(0.3333)), 1e-3);
    if (uDehaze > 0.0) {
      float t = max(1.0 - uDehaze * 0.9 * dark / a, 0.15);
      c = max((c - uAtmosphere) / t + uAtmosphere, 0.0);
    } else {
      float t = 1.0 + uDehaze * 0.6;
      c = c * t + uAtmosphere * (1.0 - t) * 0.85;
    }
  }

  if (uProfileCurve == 1) {
    float y = luminance(c);
    if (y > 0.0) c *= profileCurve(y) / y;
    // Camera profiles render a little more saturated than colorimetric output.
    c = adjustSaturation(c, 14.0);
  }

  if (uTexture != 0.0 || uClarity != 0.0) {
    float L = linearToSrgb(luminance(c));
    float small = texture(uBlurSmall, vUv).r;
    float large = texture(uBlurLarge, vUv).r;
    float mid = 1.0 - pow(abs(2.0 * clamp(L, 0.0, 1.0) - 1.0), 2.0);
    float outL = L;
    if (uTexture != 0.0) outL += uTexture * (uTexture > 0.0 ? 1.1 : 0.9) * softDetail(L - small, 0.08);
    if (uClarity != 0.0) outL += uClarity * (uClarity > 0.0 ? 0.9 : 0.8) * mid * softDetail(small - large, 0.15);
    c = applyLuminance(c, outL);
  }

  c = adjustHighlights(c, uHighlights);
  c = adjustShadows(c, uShadows);
  c = adjustWhites(c, uWhites);
  c = adjustBlacks(c, uBlacks);
  c = adjustContrast(c, uContrast);

  if (uCurvesActive == 1) c = vec3(curve(c.r, 0), curve(c.g, 1), curve(c.b, 2));
  if (uMixerActive == 1) c = mixColor(c);
  if (uMonochrome == 1) {
    // Black & white: the mixer and saturation shape the gray mix, then grading tones the
    // gray (tinted shadows and highlights, split toning, sepia), as in Lightroom.
    c = adjustVibrance(c, uVibrance);
    c = adjustSaturation(c, uSaturation);
    c = vec3(luminance(c));
    if (uGradingActive == 1) c = grade(c);
  } else {
    if (uGradingActive == 1) c = grade(c);
    c = adjustVibrance(c, uVibrance);
    c = adjustSaturation(c, uSaturation);
  }
  outColor = vec4(max(c, 0.0), src.a);
}`;

/** Luminance and color noise reduction: an edge-aware filter on Oklab. */
export const denoise = `${header}
${common}
uniform sampler2D uInput;
uniform float uLuma;
uniform float uLumaDetail;
uniform float uChroma;
uniform float uStride;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uInput, 0);
  vec4 center = texelFetch(uInput, p, 0);
  vec3 c0 = toOklab(REC2020_TO_SRGB * max(center.rgb, 0.0));
  float sigmaL = mix(0.002, 0.06, uLuma) * mix(1.0, 0.35, uLumaDetail);
  float sigmaC = mix(0.004, 0.05, uChroma);
  vec2 sumL = vec2(0.0);
  vec3 sumC = vec3(0.0);
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      ivec2 q = clamp(p + ivec2(vec2(x, y) * uStride), ivec2(0), size - 1);
      vec3 s = toOklab(REC2020_TO_SRGB * max(texelFetch(uInput, q, 0).rgb, 0.0));
      float spatial = exp(-float(x * x + y * y) / 8.0);
      float dl = s.x - c0.x;
      float wl = spatial * exp(-dl * dl / (2.0 * sigmaL * sigmaL));
      sumL += vec2(s.x * wl, wl);
      float wc = spatial * exp(-dl * dl / (2.0 * max(sigmaL * 4.0, 0.02) * max(sigmaL * 4.0, 0.02)));
      sumC += vec3(s.yz * wc, wc);
    }
  }
  vec3 lab = c0;
  if (uLuma > 0.0) lab.x = mix(c0.x, sumL.x / sumL.y, uLuma);
  if (uChroma > 0.0) lab.yz = mix(c0.yz, sumC.xy / sumC.z, clamp(uChroma * 1.5, 0.0, 1.0));
  outColor = vec4(SRGB_TO_REC2020 * fromOklab(lab), center.a);
}`;

/** Unsharp mask on lightness with detail (halo limit) and edge masking. */
export const sharpen = `${header}
${common}
uniform sampler2D uInput;
uniform float uAmount;
uniform float uSigma;
uniform float uDetail;
uniform float uMasking;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uInput, 0);
  vec4 center = texelFetch(uInput, p, 0);
  float L = linearToSrgb(luminance(max(center.rgb, 0.0)));
  float total = 0.0, weights = 0.0;
  float gx = 0.0, gy = 0.0;
  int r = int(ceil(uSigma * 2.5));
  for (int y = -r; y <= r; y++) {
    for (int x = -r; x <= r; x++) {
      ivec2 q = clamp(p + ivec2(x, y), ivec2(0), size - 1);
      float l = linearToSrgb(luminance(max(texelFetch(uInput, q, 0).rgb, 0.0)));
      float w = exp(-0.5 * float(x * x + y * y) / (uSigma * uSigma));
      total += l * w;
      weights += w;
      gx += l * float(x) * w;
      gy += l * float(y) * w;
    }
  }
  float blurred = total / weights;
  float detail = L - blurred;
  // Detail: low values suppress halos by limiting large differences.
  float limit = mix(0.015, 0.25, uDetail);
  detail = detail / (1.0 + abs(detail) / limit);
  // Masking: only sharpen where there are edges.
  float edge = length(vec2(gx, gy)) / weights / max(uSigma, 0.5);
  float mask = uMasking > 0.0 ? smoothstep(uMasking * 0.02, uMasking * 0.06 + 0.002, edge) : 1.0;
  float outL = L + uAmount * detail * mask;
  float y = luminance(max(center.rgb, 0.0));
  vec3 rgb = y > 1e-6 ? center.rgb * (srgbToLinear(max(outL, 0.0)) / y) : center.rgb;
  outColor = vec4(rgb, center.a);
}`;

/** Post-crop vignette and film grain, in output coordinates. */
export const effects = `${header}
${common}
uniform sampler2D uInput;
/** The whole output's size, and where this render's pixel (0, 0) sits in it (windowed renders). */
uniform vec2 uOutSize;
uniform vec2 uOrigin;
uniform float uFullScale;
uniform float uVignette;
uniform float uVigMid;
uniform float uVigRound;
uniform float uVigFeather;
uniform float uGrain;
uniform float uGrainSize;
uniform float uGrainRough;
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec4 c = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  vec2 pos = gl_FragCoord.xy + uOrigin;
  vec2 uv = pos / uOutSize;
  if (uVignette != 0.0) {
    vec2 d = uv - 0.5;
    float aspect = uOutSize.x / uOutSize.y;
    // Roundness: 0 follows the frame's shape, +100 is a circle, -100 more rectangular.
    float round_ = uVigRound;
    vec2 e = d * vec2(mix(1.0, aspect, max(round_, 0.0)), 1.0);
    float n = mix(2.0, 5.0, max(-round_, 0.0));
    float r = pow(pow(abs(e.x) * 2.0, n) + pow(abs(e.y) * 2.0, n), 1.0 / n) / sqrt(2.0) * sqrt(2.0);
    float start = mix(0.1, 1.0, uVigMid);
    float falloff = smoothstep(start - uVigFeather * 0.9 - 0.02, start + 0.3, r);
    float y = luminance(c.rgb);
    if (uVignette < 0.0) c.rgb *= 1.0 + uVignette * falloff;
    else c.rgb = mix(c.rgb, c.rgb + (vec3(1.0) - c.rgb) * 0.9, uVignette * falloff * smoothstep(0.0, 0.5, 1.0 - y) + 0.0);
  }
  if (uGrain > 0.0) {
    // Grain lives in full-resolution pixels so previews and exports match.
    vec2 full = pos * uFullScale;
    float size = mix(1.0, 4.0, uGrainSize);
    float n = valueNoise(full / size);
    float n2 = valueNoise(full / (size * 0.5) + 17.0);
    float g = mix(n, n2, uGrainRough) - 0.5;
    // Averaging over preview pixels shrinks grain; compensate by the pixel footprint.
    g *= min(1.0, sqrt(uFullScale / size) * 1.0) + 0.0;
    float L = linearToSrgb(luminance(c.rgb));
    float midtones = 4.0 * L * (1.0 - L) + 0.15;
    float outL = L + g * uGrain * 0.25 * midtones;
    float y = luminance(c.rgb);
    if (y > 1e-6) c.rgb *= srgbToLinear(max(outL, 0.0)) / y;
  }
  outColor = c;
}`;

/**
 * Canvas display: maps canvas pixels to image uv (zoom/pan), gamut clips,
 * encodes sRGB, draws clipping overlays and the before/after split.
 */
export const display = `${header}
${common}
uniform sampler2D uImage;
uniform sampler2D uBefore;
uniform mat3 uCanvasToImage;
/** Outside the image: transparent, so the workspace backdrop (CSS or glow) shows. Premultiplied. */
uniform vec4 uBackground;
uniform int uClipping;
uniform int uSplit;
uniform float uSplitX;
uniform vec2 uCanvasSize;
uniform sampler2D uOverlay;
uniform int uOverlayMode;
uniform int uOverlayInvert;
/** The part of the photo the images hold, in photo uv (x, y, width, height): all of it, or a zoomed-in window. */
uniform vec4 uImageWindow;
/** While moving: the whole photo, shown where the window does not reach. */
uniform sampler2D uOverview;
uniform int uHasOverview;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
  vec3 h = uCanvasToImage * vec3(px, 1.0);
  vec2 whole = h.xy / h.z;
  vec2 uv = (whole - uImageWindow.xy) / uImageWindow.zw;
  // Slopes for the mip level, before any pixel leaves or picks its texture per pixel.
  vec2 wx = dFdx(whole);
  vec2 wy = dFdy(whole);
  vec2 ux = dFdx(uv);
  vec2 uy = dFdy(uv);
  if (whole.x < 0.0 || whole.y < 0.0 || whole.x > 1.0 || whole.y > 1.0) { outColor = uBackground; return; }
  bool before = uSplit == 1 && px.x < uSplitX;
  bool inWindow = uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
  if (!inWindow && uHasOverview == 0) { outColor = uBackground; return; }
  vec4 c = before ? textureGrad(uBefore, uv, ux, uy) : inWindow ? textureGrad(uImage, uv, ux, uy) : textureGrad(uOverview, whole, wx, wy);
  vec3 rgb = toDisplay(c.rgb);
  // Transparency over a checkerboard.
  vec2 cell = floor(px / 8.0);
  vec3 checker = mod(cell.x + cell.y, 2.0) < 1.0 ? vec3(0.23) : vec3(0.16);
  rgb = mix(checker, rgb, c.a);
  if (uClipping == 1 && c.a > 0.0) {
    vec3 lin = REC2020_TO_SRGB * c.rgb;
    if (max(lin.r, max(lin.g, lin.b)) >= 0.999) rgb = vec3(1.0, 0.15, 0.1);
    else if (max(lin.r, max(lin.g, lin.b)) <= 0.0015) rgb = vec3(0.1, 0.35, 1.0);
  }
  if (uOverlayMode > 0 && !before && inWindow) {
    float m = textureGrad(uOverlay, uv, ux, uy).r;
    // An unusable coverage value (NaN) would turn every pixel it touches black: count it
    // as unselected so the photo always shows.
    m = m >= 0.0 ? min(m, 1.0) : 0.0;
    if (uOverlayInvert == 1) m = 1.0 - m;
    if (uOverlayMode == 1) rgb = mix(rgb, vec3(1.0, 0.18, 0.12), m * 0.55);
    else rgb = vec3(m);
  }
  if (uSplit == 1 && abs(px.x - uSplitX) < 1.0) rgb = vec3(0.9);
  outColor = vec4(rgb, 1.0);
}`;

/** Display-encoded RGBA8 for histograms, thumbnails and exports. Straight alpha. */
export const encode = `${header}
${common}
uniform sampler2D uImage;
void main() {
  // Row 0 stays the top row, so readPixels returns rows top-first like ImageData.
  vec4 c = texture(uImage, vUv);
  outColor = vec4(toDisplay(c.rgb), c.a);
}`;
