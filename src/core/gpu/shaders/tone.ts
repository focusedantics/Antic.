/**
 * Tone operators in linear Rec.2020, ported from OpenLight's WGSL
 * (https://github.com/roprgm/openlight, src/features/adjustments/*.wgsl,
 * MIT, © 2026 roprgm). The fitted constants are OpenLight's calibration
 * against Lightroom-like responses and are kept unchanged. Focused changes:
 * GLSL syntax; contrast/vibrance/saturation take -100..100 UI units; every
 * function is pure so the same code serves global and mask-local adjustments.
 */
export const tone = /* glsl */ `
float exposeGray(float light, float stops) {
  float bounded = min(light, 1.0);
  float headroom = (light - bounded) * exp2(stops);
  if (stops < 0.0) return headroom + exp2(stops * 1.09) * pow(bounded, exp2(-stops * 0.14));
  vec2 gain = mix(vec2(1.11, -0.11) * min(stops, 1.0), vec2(4.05, -0.63), max(stops - 1.0, 0.0) / 4.0);
  return headroom + 1.0 - pow(1.0 - pow(bounded, exp2(gain.y)), exp2(gain.x));
}

// Every channel scales by the gain of the pixel's luminance, so hue holds at any exposure.
vec3 adjustExposure(vec3 color, float stops) {
  vec3 clipped = max(color, vec3(0.0));
  if (stops == 0.0) return clipped;
  float light = luminance(clipped);
  if (light <= 0.0) return clipped;
  return clipped * (exposeGray(light, stops) / light);
}

float highlightCompression(float t) {
  float mask = smoothstep(0.0, 0.25, t);
  float curve = 0.5 + t * (1.0 - t) * (-0.89 + t * (-1.1 + t * 6.44));
  float tail = smoothstep(0.95, 1.0, t);
  return mask * curve - 0.2 * tail * tail * tail;
}

vec3 adjustHighlights(vec3 color, float amount) {
  if (amount == 0.0) return color;
  float light = clamp(luminance(color), 0.0, 1.0);
  float strength = abs(amount) / 100.0;
  if (amount < 0.0) {
    float t = linearToSrgb(light);
    float gain = exp2(-highlightCompression(t));
    float chroma = pow(gain, 1.0 - 0.76 * smoothstep(0.5, 1.0, t));
    vec3 gray = vec3(luminance(color));
    vec3 endpoint = gray * gain + (color - gray) * chroma;
    return mix(color, endpoint, strength);
  }
  float mask = smoothstep(0.0, 0.175, linearToSrgb(light));
  float curve = 0.38 + 2.42 * light * light;
  float stops = mask * curve;
  if (light < 0.0001) return color * mix(1.0, exp2(stops), strength);
  float mapped = 1.0 - pow(1.0 - light, exp2(stops));
  return color * mix(1.0, mapped / light, strength);
}

float liftedShadow(float t) {
  float inv = 1.0 - t;
  float shape = 0.95 + t * (-3.0 + 3.28 * t);
  return t + sqrt(t) * inv * inv * shape;
}
float crushedShadow(float t) {
  float shape = -2.21 + t * (6.91 - 7.12 * t);
  return t + pow(t, 1.25) * pow(1.0 - t, 2.25) * shape;
}

vec3 adjustShadows(vec3 color, float amount) {
  if (amount == 0.0) return color;
  float light = clamp(luminance(color), 0.0, 1.0);
  if (light == 0.0) return color;
  float t = linearToSrgb(light);
  float endpointStrength = amount > 0.0 ? 0.25 : 1.0;
  float strength = abs(amount) / 100.0 * endpointStrength;
  float mappedTone = amount > 0.0 ? liftedShadow(t) : crushedShadow(t);
  float gain = srgbToLinear(mappedTone) / light;
  return color * mix(1.0, gain, strength);
}

float endpointCurve(float value, float offset) {
  float start = max(-offset, 0.0);
  float t = clamp((value - start) / (0.5 - start), 0.0, 1.0);
  return max(value, start) + offset * (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
}

vec3 remapLuminance(vec3 color, float mapped) {
  float light = luminance(color);
  if (mapped > light) return mix(color, vec3(1.0), (mapped - light) / max(1.0 - light, 1e-6));
  if (mapped < light) return color * (mapped / max(light, 1e-6));
  return color;
}

vec3 adjustWhites(vec3 color, float amount) {
  if (amount == 0.0) return color;
  float light = linearToSrgb(luminance(color));
  if (light <= 0.5) return color;
  float mapped = 1.0 - endpointCurve(1.0 - light, -amount / 100.0 * 0.1);
  return remapLuminance(color, srgbToLinear(mapped));
}

vec3 adjustBlacks(vec3 color, float amount) {
  if (amount == 0.0) return color;
  float light = linearToSrgb(luminance(color));
  if (light >= 0.5) return color;
  float mapped = endpointCurve(light, amount / 100.0 * 0.1);
  return remapLuminance(color, srgbToLinear(mapped));
}

vec3 interpolateGain(float amount, vec3 half_, vec3 full) {
  float strength = 2.0 * abs(amount);
  return mix(half_ * min(strength, 1.0), full, max(strength - 1.0, 0.0));
}

vec3 adjustContrast(vec3 color, float amountUi) {
  if (amountUi == 0.0) return color;
  float amount = 1.0 + amountUi / 100.0;
  vec2 positive = interpolateGain(amount - 1.0, vec3(0.32, 1.48, 0.0), vec3(0.59, 2.77, 0.0)).xy;
  vec2 gain = amount < 1.0 ? vec2(-0.43, -2.51) * (1.0 - amount) : positive;
  vec3 bounded = min(color, vec3(1.0));
  return color + bounded * (1.0 - bounded) * (gain.x + gain.y * (bounded - 0.5));
}

vec3 adjustSaturation(vec3 color, float amountUi) {
  vec3 gray = vec3(luminance(color));
  return gray + (color - gray) * (1.0 + amountUi / 100.0);
}

vec3 adjustVibrance(vec3 color, float amountUi) {
  if (amountUi == 0.0) return color;
  float amount = amountUi / 100.0;
  float high = max(max(color.r, color.g), color.b);
  float low = max(0.0, min(min(color.r, color.g), color.b));
  float saturation = 1.0 - sqrt(low / max(high, 0.000001));
  float s = 1.0 + amount * (amount < 0.0 ? 0.23 : 0.63) * (1.0 - sign(amount) * saturation);
  return max(vec3(high) + (color - vec3(high)) * s, vec3(0.0));
}
`;
