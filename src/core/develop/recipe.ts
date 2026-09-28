import type { Point } from "@/lib/math";

/**
 * A develop recipe is the complete, serializable description of how a photo is
 * rendered. It never contains pixels: masks are editable coverage descriptions,
 * AI masks point at a stored coverage raster by id, and the original file is
 * never touched. Values use Lightroom-like UI units so presets read naturally.
 */

export type CurvePoint = Point;
export type Curve = readonly CurvePoint[];

export type WhiteBalance = {
  /** `as-shot` follows the camera; `custom` uses the values below; `auto` was estimated and stored in them. */
  readonly mode: "as-shot" | "auto" | "custom";
  /**
   * Kelvin for camera RAW files. For rendered files (JPEG, PNG, …) Lightroom's
   * relative scale is used instead: -100..100 around the file's own white.
   */
  readonly temperature: number;
  /** -150..150 (RAW) or -100..100 (rendered). Positive is magenta. */
  readonly tint: number;
};

export type Basic = {
  readonly exposure: number; // -5..5 EV
  readonly contrast: number; // -100..100
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
  readonly texture: number;
  readonly clarity: number;
  readonly dehaze: number;
  readonly vibrance: number;
  readonly saturation: number;
};

export type ParametricCurve = {
  readonly highlights: number; // -100..100
  readonly lights: number;
  readonly darks: number;
  readonly shadows: number;
};

export type ToneCurve = {
  readonly parametric: ParametricCurve;
  readonly master: Curve;
  readonly red: Curve;
  readonly green: Curve;
  readonly blue: Curve;
};

/** Eight hue ranges, red → magenta. Values are -100..100. */
export type ColorMixer = {
  readonly hue: readonly number[];
  readonly saturation: readonly number[];
  readonly luminance: readonly number[];
};

export type GradeWheel = {
  readonly hue: number; // 0..360
  readonly saturation: number; // 0..100
  readonly luminance: number; // -100..100
};

export type ColorGrading = {
  readonly shadows: GradeWheel;
  readonly midtones: GradeWheel;
  readonly highlights: GradeWheel;
  readonly global: GradeWheel;
  readonly blending: number; // 0..100
  readonly balance: number; // -100..100
};

export type Detail = {
  readonly sharpenAmount: number; // 0..150
  readonly sharpenRadius: number; // 0.5..3 px
  readonly sharpenDetail: number; // 0..100
  readonly sharpenMasking: number; // 0..100
  readonly noiseLuminance: number; // 0..100
  readonly noiseDetail: number; // 0..100
  readonly noiseColor: number; // 0..100
};

export type Optics = {
  readonly removeChromaticAberration: boolean;
  /** Manual radial distortion, -100 (pincushion fix) .. 100 (barrel fix). */
  readonly distortion: number;
  /** Lens vignetting compensation, -100..100, applied around the uncropped center. */
  readonly vignetting: number;
  readonly vignettingMidpoint: number; // 0..100
};

export type Geometry = {
  /** Quarter turns clockwise, 0..3. */
  readonly rotate90: number;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  /** Straighten angle, -45..45 degrees. */
  readonly angle: number;
  /**
   * Crop rectangle in normalized coordinates of the rotated-and-straightened frame
   * (0..1 on both axes). The full frame is { x: 0, y: 0, width: 1, height: 1 }.
   */
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Width / height, or null for a free crop. Only guides the crop tool. */
  readonly aspect: number | null;
  /** Upright-style keystone correction, -100..100. */
  readonly vertical: number;
  readonly horizontal: number;
};

export type Effects = {
  readonly vignetteAmount: number; // -100..100 (post-crop)
  readonly vignetteMidpoint: number; // 0..100
  readonly vignetteRoundness: number; // -100..100
  readonly vignetteFeather: number; // 0..100
  readonly grainAmount: number; // 0..100
  readonly grainSize: number; // 0..100
  readonly grainRoughness: number; // 0..100
};

export type Profile = "color" | "monochrome";

// ─── Masks ────────────────────────────────────────────────────────────────────
// Positions are normalized to the oriented, uncropped photo (0..1 on each axis),
// so masks survive crops, rotations and any preview resolution. Lengths are a
// fraction of the photo's longer side.

export type StrokePoint = readonly [x: number, y: number, pressure: number];

export type BrushStroke = {
  readonly mode: "paint" | "erase";
  readonly size: number;
  /** Soft edge as a fraction of the radius, 0..1. */
  readonly feather: number;
  readonly flow: number; // 0..1
  /** Upper bound of coverage this stroke can build, 0..1. */
  readonly density: number;
  readonly points: readonly StrokePoint[];
};

export type MaskShape =
  | { readonly kind: "brush"; readonly strokes: readonly BrushStroke[] }
  /** Full effect at `start`, none at `end`. */
  | { readonly kind: "linear"; readonly start: Point; readonly end: Point }
  | {
      readonly kind: "radial";
      readonly center: Point;
      readonly radiusX: number;
      readonly radiusY: number;
      /** Radians. */
      readonly angle: number;
      /** 0..100 */
      readonly feather: number;
    }
  | {
      readonly kind: "luminance";
      /** Selected range in perceptual lightness 0..1. */
      readonly low: number;
      readonly high: number;
      /** Soft falloff width outside the range, 0..1. */
      readonly smoothness: number;
    }
  | {
      readonly kind: "color";
      /** Sampled colors as Oklab (L, a, b). */
      readonly samples: readonly (readonly [number, number, number])[];
      /** 0..100 */
      readonly refine: number;
    }
  | {
      readonly kind: "ai";
      readonly target: "subject" | "sky" | "background" | "object" | "person";
      /** Id of a stored coverage raster (the model's result, edge-refined). */
      readonly rasterId: string;
      /** Prompt points for object selection, kept so the mask can be regenerated. */
      readonly points?: readonly { readonly x: number; readonly y: number; readonly positive: boolean }[];
      /** Softens the edge, 0..100. */
      readonly feather: number;
      /** Contracts (negative) or expands (positive) the edge, -100..100. */
      readonly shift: number;
    };

export type MaskOperation = "add" | "subtract" | "intersect";

export type MaskComponent = {
  readonly id: string;
  readonly operation: MaskOperation;
  readonly invert: boolean;
  /** 0..1 */
  readonly opacity: number;
  readonly shape: MaskShape;
};

export type LocalAdjustments = {
  readonly temperature: number; // -100..100
  readonly tint: number;
  readonly exposure: number; // -4..4
  readonly contrast: number;
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
  readonly texture: number;
  readonly clarity: number;
  readonly dehaze: number;
  readonly hue: number; // -180..180 degrees
  readonly saturation: number;
};

export type Mask = {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** Scales every local adjustment, 0..1 (Lightroom's mask "Amount"). */
  readonly amount: number;
  /** Applies the adjustments outside the combined coverage instead of inside. */
  readonly invert: boolean;
  /**
   * Transparency: outside this mask the photo becomes transparent (Remove
   * Background). At most one mask per recipe is a cutout.
   */
  readonly cutout: boolean;
  readonly components: readonly MaskComponent[];
  readonly adjustments: LocalAdjustments;
};

/**
 * One spot repair. `x, y` is the blemish, `sourceX, sourceY` where pixels are
 * taken from, both in source uv. Heal matches the surrounding tone and color;
 * clone copies the source as-is.
 */
export type Spot = {
  readonly id: string;
  readonly mode: "heal" | "clone";
  readonly x: number;
  readonly y: number;
  readonly sourceX: number;
  readonly sourceY: number;
  /** Radius as a fraction of the photo's long side. */
  readonly radius: number;
  /** 0..100 */
  readonly feather: number;
  /** 0..1 */
  readonly opacity: number;
};

export type DevelopRecipe = {
  readonly version: 1;
  readonly profile: Profile;
  readonly whiteBalance: WhiteBalance;
  readonly basic: Basic;
  readonly toneCurve: ToneCurve;
  readonly colorMixer: ColorMixer;
  readonly colorGrading: ColorGrading;
  readonly detail: Detail;
  readonly optics: Optics;
  readonly geometry: Geometry;
  readonly effects: Effects;
  readonly masks: readonly Mask[];
  readonly retouch: readonly Spot[];
};

/** Groups that can be copied, pasted, synced and saved in presets independently. */
export type RecipeGroup = Exclude<keyof DevelopRecipe, "version">;
