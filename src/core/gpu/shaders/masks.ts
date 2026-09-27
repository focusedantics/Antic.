import { common, header } from "./common";
import { tone } from "./tone";

/**
 * One mask component combined into the running coverage (R channel).
 * Coordinates: output uv → source uv through the recipe homography; lengths are
 * in units of the photo's longer side, so masks are resolution independent.
 */
export const maskComponent = `${header}
${common}
uniform sampler2D uPrevious;
uniform sampler2D uImage;
uniform sampler2D uRaster;
uniform mat3 uOutToSrc;
uniform vec2 uSrcSize;
uniform int uKind;        // 0 linear, 1 radial, 2 brush/raster, 3 luminance, 4 color
uniform int uOperation;   // 0 add, 1 subtract, 2 intersect
uniform int uFirst;
uniform int uInvert;
uniform float uOpacity;
uniform vec2 uA;          // linear start / radial center
uniform vec2 uB;          // linear end / radial radii
uniform float uAngle;
uniform float uFeather;
uniform vec3 uRange;      // luminance: low, high, smoothness
uniform vec3 uSamples[5];
uniform int uSampleCount;
uniform float uRefine;
uniform float uShift;

float component(vec2 src) {
  float longSide = max(uSrcSize.x, uSrcSize.y);
  vec2 p = src * uSrcSize / longSide;
  if (uKind == 0) {
    vec2 a = uA * uSrcSize / longSide;
    vec2 b = uB * uSrcSize / longSide;
    vec2 d = b - a;
    float t = dot(p - a, d) / max(dot(d, d), 1e-8);
    // Full effect before the start line, none after the end line.
    return 1.0 - smoothstep(0.0, 1.0, clamp(t, 0.0, 1.0));
  }
  if (uKind == 1) {
    vec2 c = uA * uSrcSize / longSide;
    vec2 d = p - c;
    float s = sin(uAngle), co = cos(uAngle);
    vec2 r = vec2(co * d.x + s * d.y, -s * d.x + co * d.y) / max(uB, vec2(1e-4));
    float dist = length(r);
    float inner = 1.0 - clamp(uFeather, 0.0, 1.0);
    return 1.0 - smoothstep(inner, 1.0 + 1e-4, dist);
  }
  if (uKind == 2) {
    if (src.x < 0.0 || src.y < 0.0 || src.x > 1.0 || src.y > 1.0) return 0.0;
    float v = texture(uRaster, src).r;
    // Expand (positive) or contract (negative) by moving the edge threshold.
    if (uShift != 0.0) {
      float t = clamp(0.5 - uShift * 0.45, 0.02, 0.98);
      v = smoothstep(t - 0.12, t + 0.12, v);
    }
    return v;
  }
  vec3 c = max(texelFetch(uImage, ivec2(gl_FragCoord.xy), 0).rgb, 0.0);
  if (uKind == 3) {
    float L = linearToSrgb(luminance(c));
    float s = max(uRange.z, 1e-3);
    return smoothstep(uRange.x - s, uRange.x, L) * (1.0 - smoothstep(uRange.y, uRange.y + s, L));
  }
  vec3 lab = toOklab(REC2020_TO_SRGB * c);
  float best = 1e9;
  for (int i = 0; i < 5; i++) {
    if (i >= uSampleCount) break;
    // Hue/chroma weigh more than lightness, like selecting "this color".
    vec3 d = lab - uSamples[i];
    best = min(best, length(vec3(d.x * 0.5, d.yz)));
  }
  float tolerance = mix(0.02, 0.2, uRefine);
  return 1.0 - smoothstep(tolerance * 0.5, tolerance, best);
}

void main() {
  vec3 h = uOutToSrc * vec3(vUv, 1.0);
  vec2 src = h.xy / h.z;
  float c = component(src);
  if (uInvert == 1) c = 1.0 - c;
  c = clamp(c * uOpacity, 0.0, 1.0);
  float prev = uFirst == 1 ? 0.0 : texelFetch(uPrevious, ivec2(gl_FragCoord.xy), 0).r;
  float v;
  if (uOperation == 0) v = prev + c - prev * c;
  else if (uOperation == 1) v = prev * (1.0 - c);
  else v = uFirst == 1 ? c : prev * c;
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

/** Local adjustments through a coverage mask. */
export const localAdjust = `${header}
${common}
${tone}
uniform sampler2D uInput;
uniform sampler2D uCoverage;
uniform sampler2D uBlurSmall;
uniform sampler2D uBlurLarge;
uniform float uAmount;
uniform int uInvertMask;
uniform mat3 uWhiteBalance;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTexture, uClarity, uDehaze, uHue, uSaturation;
uniform vec3 uAtmosphere;

float softDetail(float d, float limit) { return d / (1.0 + abs(d) / limit); }

void main() {
  vec4 src = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  float coverage = texelFetch(uCoverage, ivec2(gl_FragCoord.xy), 0).r;
  float m = (uInvertMask == 1 ? 1.0 - coverage : coverage) * uAmount;
  if (m <= 0.0) { outColor = src; return; }
  vec3 c = max(src.rgb, 0.0);
  c = uWhiteBalance * c;
  c = adjustExposure(c, uExposure);
  if (uDehaze != 0.0) {
    float dark = texture(uBlurLarge, vUv).g;
    float a = max(dot(uAtmosphere, vec3(0.3333)), 1e-3);
    if (uDehaze > 0.0) c = max((c - uAtmosphere) / max(1.0 - uDehaze * 0.9 * dark / a, 0.15) + uAtmosphere, 0.0);
    else c = c * (1.0 + uDehaze * 0.6) - uAtmosphere * uDehaze * 0.6 * 0.85;
  }
  if (uTexture != 0.0 || uClarity != 0.0) {
    float L = linearToSrgb(luminance(c));
    float small = texture(uBlurSmall, vUv).r;
    float large = texture(uBlurLarge, vUv).r;
    float mid = 1.0 - pow(abs(2.0 * clamp(L, 0.0, 1.0) - 1.0), 2.0);
    float outL = L + uTexture * softDetail(L - small, 0.08) + uClarity * mid * softDetail(small - large, 0.15);
    float y = luminance(c);
    float target = srgbToLinear(max(outL, 0.0));
    c = y > 1e-6 ? c * (target / y) : c + vec3(target);
  }
  c = adjustHighlights(c, uHighlights);
  c = adjustShadows(c, uShadows);
  c = adjustWhites(c, uWhites);
  c = adjustBlacks(c, uBlacks);
  c = adjustContrast(c, uContrast);
  if (uHue != 0.0 || uSaturation != 0.0) {
    float light = luminance(c);
    vec3 lab = toOklab(REC2020_TO_SRGB * c);
    float a = radians(uHue);
    lab.yz = mat2(cos(a), sin(a), -sin(a), cos(a)) * lab.yz * (1.0 + uSaturation / 100.0);
    vec3 mixed = SRGB_TO_REC2020 * fromOklab(lab);
    c = max(mixed + vec3(light - luminance(mixed)), 0.0);
  }
  outColor = vec4(mix(src.rgb, c, clamp(m, 0.0, 1.0)), src.a);
}`;

/** Straight copy (used to fork cached brush coverage). */
export const copy = `${header}
uniform sampler2D uInput;
void main() { outColor = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0); }`;

/** Caps a stroke's accumulated coverage at its density before it joins the brush. */
export const density = `${header}
uniform sampler2D uInput;
uniform float uDensity;
void main() {
  float v = min(texelFetch(uInput, ivec2(gl_FragCoord.xy), 0).r, uDensity);
  outColor = vec4(v, v, v, v);
}`;

/** Filtered resample of the whole input. */
export const resample = `${header}
uniform sampler2D uInput;
void main() { outColor = texture(uInput, vUv); }`;

/** Multiplies alpha by a cutout mask's coverage: outside the mask becomes transparent. */
export const cutout = `${header}
uniform sampler2D uInput;
uniform sampler2D uCoverage;
uniform int uInvertMask;
void main() {
  vec4 c = texelFetch(uInput, ivec2(gl_FragCoord.xy), 0);
  float m = texelFetch(uCoverage, ivec2(gl_FragCoord.xy), 0).r;
  if (uInvertMask == 1) m = 1.0 - m;
  outColor = vec4(c.rgb, c.a * clamp(m, 0.0, 1.0));
}`;
