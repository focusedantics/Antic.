import { header } from "./common";

/**
 * Spot healing and cloning in source pixels. Up to 32 spots per pass; each
 * spot reads the unretouched input. Heal transfers texture from the source and
 * keeps the destination's local tone (ratio of mipmap averages); clone copies.
 */
export const retouch = `${header}
uniform sampler2D uBase;
uniform vec2 uSize;
uniform int uCount;
uniform vec4 uSpots[32];   // dest.xy, source.xy in pixels
uniform vec4 uParams[32];  // radius px, feather 0..1, opacity, mode (0 heal, 1 clone)
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 c = texelFetch(uBase, ivec2(px), 0);
  for (int i = 0; i < 32; i++) {
    if (i >= uCount) break;
    vec2 dest = uSpots[i].xy;
    float r = uParams[i].x;
    float dist = length(px - dest);
    if (dist >= r) continue;
    vec2 offset = uSpots[i].zw - dest;
    vec2 suv = (px + offset) / uSize;
    vec4 s = texture(uBase, suv);
    if (uParams[i].w < 0.5) {
      // Local means at about twice the spot size: tone of the surroundings, not the blemish.
      float lod = max(0.0, log2(r) + 1.0);
      vec3 meanSource = textureLod(uBase, suv, lod).rgb;
      vec3 meanDest = textureLod(uBase, px / uSize, lod).rgb;
      s.rgb *= (meanDest + 1e-4) / (meanSource + 1e-4);
    }
    float inner = r * (1.0 - uParams[i].y);
    float w = uParams[i].z * (1.0 - smoothstep(inner, r, dist));
    c = mix(c, s, w);
  }
  outColor = c;
}`;
