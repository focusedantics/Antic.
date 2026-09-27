import type { DevelopRecipe, MaskComponent } from "@/core/develop/recipe";
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
};

export type ShapeStyle = {
  readonly shape: "rectangle" | "ellipse";
  readonly fill: string;
  readonly fillOpacity: number;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly radius: number;
};

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
export type GroupLayer = LayerBase & {
  readonly kind: "group";
  readonly children: readonly Layer[];
  readonly expanded: boolean;
};

export type Layer = ImageLayer | FillLayer | GradientLayer | TextLayer | ShapeLayer | AdjustmentLayer | GroupLayer;
export type LayerKind = Layer["kind"];

export type Guide = { readonly id: string; readonly axis: "x" | "y"; readonly position: number };

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
  readonly createdAt: number;
};
