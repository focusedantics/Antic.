/** GLSL shared by the develop and composite shaders. Working space: linear Rec.2020. */
export const common = /* glsl */ `
float luminance(vec3 c) { return dot(c, vec3(0.2627, 0.6780, 0.0593)); }

float linearToSrgb(float x) {
  x = max(x, 0.0);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
float srgbToLinear(float x) {
  x = max(x, 0.0);
  return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4);
}
vec3 linearToSrgb3(vec3 c) { return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b)); }
vec3 srgbToLinear3(vec3 c) { return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)); }

// Column-major GLSL matrices.
const mat3 SRGB_TO_REC2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956);
const mat3 REC2020_TO_SRGB = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);

// Björn Ottosson's Oklab (public domain), on linear sRGB.
vec3 toOklab(vec3 rgb) {
  vec3 lms = mat3(0.4122214708, 0.2119034982, 0.0883024619,
                  0.5363325363, 0.6806995451, 0.2817188376,
                  0.0514459929, 0.1073969566, 0.6299787005) * rgb;
  lms = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
  return mat3(0.2104542553, 1.9779984951, 0.0259040371,
              0.7936177850, -2.4285922050, 0.7827717662,
              -0.0040720468, 0.4505937099, -0.8086757660) * lms;
}
vec3 fromOklab(vec3 lab) {
  vec3 lms = mat3(1.0, 1.0, 1.0,
                  0.3963377774, -0.1055613458, -0.0894841775,
                  0.2158037573, -0.0638541728, -1.2914855480) * lab;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863,
              -3.3077115913, 2.6097574011, -0.7034186147,
              0.2309699292, -0.3413193965, 1.7076147010) * (lms * lms * lms);
}

// Luminance-preserving gamut clip into [0,1] sRGB (the "preserve luminance" clip).
vec3 clipToGamut(vec3 rgb, float light) {
  vec3 c = rgb;
  float lo = min(c.r, min(c.g, c.b));
  if (lo < 0.0 && light > 0.0) c = mix(c, vec3(light), -lo / (light - lo));
  float hi = max(c.r, max(c.g, c.b));
  if (hi > 1.0) c = mix(c, vec3(light), (hi - 1.0) / max(hi - light, 1e-6));
  return clamp(c, 0.0, 1.0);
}

/** Working space → display-encoded sRGB in [0,1]. */
vec3 toDisplay(vec3 working) {
  float light = luminance(working);
  if (light >= 1.0) return vec3(1.0);
  return linearToSrgb3(clipToGamut(REC2020_TO_SRGB * working, light));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export const header = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
in vec2 vUv;
out vec4 outColor;
`;
