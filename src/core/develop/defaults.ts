import type {
  Basic,
  ColorGrading,
  ColorMixer,
  Curve,
  Detail,
  DevelopRecipe,
  Effects,
  Geometry,
  LocalAdjustments,
  Optics,
  ToneCurve,
  WhiteBalance,
} from "./recipe";

export const identityCurve: Curve = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
]);

export const defaultBasic: Basic = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
};

export const defaultToneCurve: ToneCurve = {
  parametric: { highlights: 0, lights: 0, darks: 0, shadows: 0 },
  master: identityCurve,
  red: identityCurve,
  green: identityCurve,
  blue: identityCurve,
};

const zeros8 = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]);
export const defaultColorMixer: ColorMixer = { hue: zeros8, saturation: zeros8, luminance: zeros8 };

const neutralWheel = { hue: 0, saturation: 0, luminance: 0 };
export const defaultColorGrading: ColorGrading = {
  shadows: neutralWheel,
  midtones: neutralWheel,
  highlights: neutralWheel,
  global: neutralWheel,
  blending: 50,
  balance: 0,
};

/** Lightroom applies light capture sharpening to RAW files by default; so do we. */
export const defaultDetail = (raw: boolean): Detail => ({
  sharpenAmount: raw ? 40 : 0,
  sharpenRadius: 1,
  sharpenDetail: 25,
  sharpenMasking: 0,
  noiseLuminance: 0,
  noiseDetail: 50,
  noiseColor: raw ? 25 : 0,
});

export const defaultOptics: Optics = {
  removeChromaticAberration: false,
  distortion: 0,
  vignetting: 0,
  vignettingMidpoint: 50,
};

export const fullCrop = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

export const defaultGeometry: Geometry = {
  rotate90: 0,
  flipHorizontal: false,
  flipVertical: false,
  angle: 0,
  crop: fullCrop,
  aspect: null,
  vertical: 0,
  horizontal: 0,
};

export const defaultEffects: Effects = {
  vignetteAmount: 0,
  vignetteMidpoint: 50,
  vignetteRoundness: 0,
  vignetteFeather: 50,
  grainAmount: 0,
  grainSize: 25,
  grainRoughness: 50,
};

export const defaultLocalAdjustments: LocalAdjustments = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  hue: 0,
  saturation: 0,
};

export type SourceColorInfo = {
  /** Camera RAW: white balance is in Kelvin and "as shot" comes from the camera. */
  readonly raw: boolean;
  readonly asShot?: { readonly temperature: number; readonly tint: number };
};

export function asShotWhiteBalance(info: SourceColorInfo): WhiteBalance {
  if (info.raw) {
    const shot = info.asShot ?? { temperature: 5500, tint: 0 };
    return { mode: "as-shot", temperature: shot.temperature, tint: shot.tint };
  }
  return { mode: "as-shot", temperature: 0, tint: 0 };
}

export function createDefaultRecipe(info: SourceColorInfo): DevelopRecipe {
  return {
    version: 1,
    profile: "color",
    whiteBalance: asShotWhiteBalance(info),
    basic: defaultBasic,
    toneCurve: defaultToneCurve,
    colorMixer: defaultColorMixer,
    colorGrading: defaultColorGrading,
    detail: defaultDetail(info.raw),
    optics: defaultOptics,
    geometry: defaultGeometry,
    effects: defaultEffects,
    masks: [],
    retouch: [],
  };
}
