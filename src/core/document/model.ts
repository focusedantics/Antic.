import type { DevelopRecipe, MaskComponent } from "@/core/develop/recipe";
import type { EffectInstance } from "@/core/effects/types";
import type { Point } from "@/lib/math";

/**
 * A composite document: a canvas and a tree of layers. Like develop recipes it
 * is plain, immutable, serializable data. Image layers reference photos by
 * asset id and (by default) follow the photo's live develop recipe, so a RAW
 * edited in Develop — including a background cutout — updates every
 * composition that uses it. Nothing is flattened.
 */

export type BlendMode =
  | "normal"
  | "darken"
  | "multiply"
  | "color-burn"
  | "linear-burn"
  | "lighten"
  | "screen"
  | "color-dodge"
  | "linear-dodge"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "vivid-light"
  | "linear-light"
  | "pin-light"
  | "hard-mix"
  | "difference"
  | "exclusion"
  | "subtract"
  | "divide"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export const BLEND_MODES: { id: BlendMode; label: string; group: number }[] = [
  { id: "normal", label: "Normal", group: 0 },
  { id: "darken", label: "Darken", group: 1 },
  { id: "multiply", label: "Multiply", group: 1 },
  { id: "color-burn", label: "Color Burn", group: 1 },
  { id: "linear-burn", label: "Linear Burn", group: 1 },
  { id: "lighten", label: "Lighten", group: 2 },
  { id: "screen", label: "Screen", group: 2 },
  { id: "color-dodge", label: "Color Dodge", group: 2 },
  { id: "linear-dodge", label: "Linear Dodge (Add)", group: 2 },
  { id: "overlay", label: "Overlay", group: 3 },
  { id: "soft-light", label: "Soft Light", group: 3 },
  { id: "hard-light", label: "Hard Light", group: 3 },
  { id: "vivid-light", label: "Vivid Light", group: 3 },
  { id: "linear-light", label: "Linear Light", group: 3 },
  { id: "pin-light", label: "Pin Light", group: 3 },
  { id: "hard-mix", label: "Hard Mix", group: 3 },
  { id: "difference", label: "Difference", group: 4 },
  { id: "exclusion", label: "Exclusion", group: 4 },
  { id: "subtract", label: "Subtract", group: 4 },
  { id: "divide", label: "Divide", group: 4 },
  { id: "hue", label: "Hue", group: 5 },
  { id: "saturation", label: "Saturation", group: 5 },
  { id: "color", label: "Color", group: 5 },
  { id: "luminosity", label: "Luminosity", group: 5 },
];

/**
 * Placement of a layer's content on the canvas. `x, y` is the content center in
 * canvas pixels; `width, height` its size before rotation. `corners`, when set,
 * overrides the rectangle with a free perspective quad (top-left, top-right,
 * bottom-right, bottom-left, canvas pixels).
 */
export type Transform = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Degrees, clockwise. */
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly corners?: readonly [Point, Point, Point, Point];
};

/** Visible part of the content, normalized 0..1 (applied before the transform). */
export type LayerCrop = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/** Editable layer mask: the same components as develop masks, in the layer's content space. */
export type LayerMask = {
  readonly enabled: boolean;
  readonly invert: boolean;
  /** 0..1: how much the mask hides (Photoshop's mask density). */
  readonly density: number;
  readonly components: readonly MaskComponent[];
};

export type GradientStop = { readonly offset: number; readonly color: string; readonly opacity: number };
export type Gradient = {
  readonly type: "linear" | "radial";
  /** Degrees; 90 goes top → bottom. */
  readonly angle: number;
  /** 0.1..3: length of the ramp relative to the layer. */
  readonly scale: number;
  /** Center offset relative to the layer, -1..1. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly reverse: boolean;
  readonly stops: readonly GradientStop[];
};

/** Animated text: how the letters move over the composition's loop. */
export type TextMotionKind = "none" | "typewriter" | "pop-in" | "wave" | "bounce" | "rainbow" | "pulse" | "flicker" | "glitch";
export type TextMotion = {
  readonly kind: TextMotionKind;
  /** Whole cycles per loop (1–4), so repeating motions loop seamlessly. */
  readonly speed: number;
  /** 0..1: how far letters travel / how strong the effect is. */
  readonly amount: number;
};

/** Text highlight: a box behind each line. */
export type TextHighlight = { readonly color: string; readonly opacity: number; /** × size */ readonly padding: number; /** × size */ readonly radius: number };

export type TextStyle = {
  readonly text: string;
  readonly font: string;
  /** Canvas pixels. */
  readonly size: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly color: string;
  readonly align: "left" | "center" | "right";
  readonly lineHeight: number;
  readonly letterSpacing: number;
  /** Absent = still text. */
  readonly motion?: TextMotion;
  /** -1..1: bends the lines along an arc (1 = a half circle, bulging up; negative bends down). */
  readonly curve?: number;
  /** Replaces `color` with a gradient across the text box. */
  readonly gradient?: Gradient;
  readonly textCase?: "upper" | "lower" | "title";
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly highlight?: TextHighlight;
};

export type ShapeStyle = {
  readonly shape: "rectangle" | "ellipse";
  readonly fill: string;
  readonly fillOpacity: number;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly radius: number;
};

/**
 * Vector paths. Coordinates are in the layer's unit box (0..1 across its width and
 * height), so resizing the layer scales the drawing; strokes keep their width. A node's
 * `in`/`out` are its Bézier handles (absent: a sharp corner).
 */
export type PathNode = { readonly x: number; readonly y: number; readonly in?: Point; readonly out?: Point };
export type SubPath = { readonly closed: boolean; readonly nodes: readonly PathNode[] };

export type SmartShapeKind =
  | "rectangle"
  | "ellipse"
  | "polygon"
  | "star"
  | "burst"
  | "heart"
  | "arrow"
  | "double-arrow"
  | "chevron"
  | "speech"
  | "ring"
  | "cross"
  | "crescent"
  | "teardrop"
  | "cloud"
  | "line";
/**
 * A shape drawn from a few numbers (it stays editable as such until it is converted
 * to nodes). `points`: corners of a polygon, points of a star or burst. `ratio`: inner
 * radius of a star or ring, shaft of an arrow, tail of a bubble, bar of a cross,
 * bite of a crescent (0..1). `round`: corner rounding (0..1).
 */
export type SmartShape = { readonly kind: SmartShapeKind; readonly points: number; readonly ratio: number; readonly round: number };

export type PathStyle = {
  /** null: no fill. */
  readonly fill: string | null;
  readonly fillOpacity: number;
  readonly fillGradient?: Gradient;
  /** null: no stroke. */
  readonly stroke: string | null;
  readonly strokeOpacity: number;
  readonly strokeGradient?: Gradient;
  /** Canvas pixels. */
  readonly strokeWidth: number;
  /** Dash and gap lengths in stroke widths; empty for a solid line. */
  readonly dash: readonly number[];
  readonly cap: "butt" | "round" | "square";
  readonly join: "miter" | "round" | "bevel";
  readonly fillRule: "nonzero" | "evenodd";
};

/**
 * Layer styles, drawn from the layer's own shape (its alpha) on the GPU, so they work
 * on photos, cut-outs, text, shapes and groups alike. Sizes are canvas pixels.
 */
export type ShadowStyle = { readonly color: string; readonly opacity: number; /** degrees; 90 = straight down */ readonly angle: number; readonly distance: number; readonly blur: number; /** 0..1 */ readonly spread: number };
export type GlowStyle = { readonly color: string; readonly opacity: number; readonly blur: number; readonly spread: number };
export type OutlineStyle = { readonly color: string; readonly opacity: number; readonly width: number };
export type LayerFx = { readonly shadow?: ShadowStyle; readonly glow?: GlowStyle; readonly outline?: OutlineStyle };

/** How a slot's photo sits in its frame: `zoom` ≥ 1 over "cover", `x`/`y` -1..1 pan within the room left. */
export type SlotFit = { readonly zoom: number; readonly x: number; readonly y: number };

/** A develop-style adjustment applied to everything below it (within its group or clip). */
export type Adjustment = Pick<DevelopRecipe, "basic" | "toneCurve" | "colorMixer" | "colorGrading" | "profile">;

type LayerBase = {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly opacity: number;
  readonly fillOpacity: number;
  readonly blend: BlendMode;
  /** Clipped to the nearest unclipped layer below. */
  readonly clip: boolean;
  readonly transform: Transform;
  readonly crop: LayerCrop;
  readonly mask: LayerMask | null;
  /** Shadow, glow and outline (absent: none). */
  readonly fx?: LayerFx;
};

export type ImageLayer = LayerBase & {
  readonly kind: "image";
  readonly assetId: string;
  /** "asset" follows the photo's own develop recipe; a recipe makes this layer independent. */
  readonly develop: "asset" | DevelopRecipe;
};
export type FillLayer = LayerBase & { readonly kind: "fill"; readonly color: string };
export type GradientLayer = LayerBase & { readonly kind: "gradient"; readonly gradient: Gradient };
export type TextLayer = LayerBase & { readonly kind: "text"; readonly style: TextStyle };
export type ShapeLayer = LayerBase & { readonly kind: "shape"; readonly style: ShapeStyle };
export type AdjustmentLayer = LayerBase & { readonly kind: "adjustment"; readonly adjustment: Adjustment };
/** A stylization effect (ASCII, halftone, glass…) applied to everything below it, like an adjustment. */
export type EffectLayer = LayerBase & { readonly kind: "effect"; readonly effect: EffectInstance };
/** A vector drawing: a smart shape, or nodes from the pen (`shape` null). */
export type PathLayer = LayerBase & { readonly kind: "path"; readonly shape: SmartShape | null; readonly paths: readonly SubPath[]; readonly style: PathStyle };
/**
 * A photo frame ("tap to add your photo"): the photo fills `frame` (cover), zoomed and
 * panned by `fit`; without a photo it shows a placeholder. Replacing the photo keeps the
 * frame, transform, styles and mask.
 */
export type SlotLayer = LayerBase & { readonly kind: "slot"; readonly frame: SmartShape; readonly assetId: string | null; readonly fit: SlotFit; readonly placeholder: string };
/** Brushes for paint layers. */
export type BrushKind = "round" | "soft" | "marker" | "pencil" | "spray" | "calligraphy" | "eraser";
/**
 * One brush stroke. `points` are x, y, pressure triples in the layer's unit box; `size`
 * is the brush diameter as a share of the box width (so the drawing scales with the
 * layer). `seed` makes textured brushes (pencil, spray) repeat exactly.
 */
export type PaintStroke = {
  readonly type: "stroke";
  readonly brush: BrushKind;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  /** 0..1, soft brush only: how much of the radius is solid. */
  readonly hardness: number;
  readonly points: readonly number[];
  readonly seed: number;
};
/** A bucket fill at a point of the layer (unit box), replayed in order with the strokes. */
export type PaintFill = { readonly type: "fill"; readonly x: number; readonly y: number; readonly color: string; readonly opacity: number; /** 0..1 colour distance */ readonly tolerance: number };
export type PaintOp = PaintStroke | PaintFill;
/** A drawing: strokes and fills kept as data, drawn at whatever resolution is needed. */
export type PaintLayer = LayerBase & { readonly kind: "paint"; readonly ops: readonly PaintOp[] };

export type GroupLayer = LayerBase & {
  readonly kind: "group";
  readonly children: readonly Layer[];
  readonly expanded: boolean;
};

export type Layer = ImageLayer | FillLayer | GradientLayer | TextLayer | ShapeLayer | PathLayer | SlotLayer | PaintLayer | AdjustmentLayer | EffectLayer | GroupLayer;
export type LayerKind = Layer["kind"];

export type Guide = { readonly id: string; readonly axis: "x" | "y"; readonly position: number };

/** Loop settings for documents with animated effects (GIF / MP4 export and the live preview). */
export type DocAnimation = { readonly duration: number; readonly fps: number };

export type CompositeDocument = {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** null = transparent canvas. */
  readonly background: string | null;
  /** Bottom first: the array is paint order. */
  readonly layers: readonly Layer[];
  readonly guides: readonly Guide[];
  /** Absent = defaults (3 s at 15 fps); only matters when an animated effect is present. */
  readonly animation?: DocAnimation;
  /** "design": made and listed in the Design workspace (absent: a Composite composition). */
  readonly purpose?: "design";
  readonly createdAt: number;
};
