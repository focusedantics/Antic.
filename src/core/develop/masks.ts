import { createId } from "@/lib/id";
import { defaultLocalAdjustments } from "./defaults";
import type { DevelopRecipe, LocalAdjustments, Mask, MaskComponent, MaskOperation, MaskShape } from "./recipe";

export type ShapeKind = MaskShape["kind"];

export const shapeLabels: Record<ShapeKind, string> = {
  brush: "Brush",
  linear: "Linear Gradient",
  radial: "Radial Gradient",
  luminance: "Luminance Range",
  color: "Color Range",
  ai: "AI Selection",
};

export const aiTargetLabels = {
  subject: "Subject",
  sky: "Sky",
  background: "Background",
  object: "Object",
  person: "People",
} as const;

/** Default geometry for a new shape, centered on `center` (source uv) and sized to `scale` of the long side. */
export function defaultShape(kind: Exclude<ShapeKind, "ai">, center = { x: 0.5, y: 0.5 }, scale = 0.25, aspect = 1.5): MaskShape {
  switch (kind) {
    case "brush":
      return { kind: "brush", strokes: [] };
    case "linear":
      return { kind: "linear", start: { x: center.x, y: center.y - scale * 0.8 }, end: { x: center.x, y: center.y + scale * 0.2 } };
    case "radial":
      return { kind: "radial", center, radiusX: scale * 0.9, radiusY: (scale * 0.9) / Math.max(0.5, Math.min(aspect, 2)) * 1.2, angle: 0, feather: 50 };
    case "luminance":
      return { kind: "luminance", low: 0.6, high: 1, smoothness: 0.15 };
    case "color":
      return { kind: "color", samples: [], refine: 50 };
  }
}

export function newComponent(shape: MaskShape, operation: MaskOperation = "add"): MaskComponent {
  return { id: createId("mc"), operation, invert: false, opacity: 1, shape };
}

export function maskName(recipe: DevelopRecipe) {
  return `Mask ${recipe.masks.length + 1}`;
}

export function addMask(recipe: DevelopRecipe, shape: MaskShape, name?: string): { recipe: DevelopRecipe; mask: Mask } {
  const mask: Mask = {
    id: createId("mask"),
    name: name ?? maskName(recipe),
    visible: true,
    amount: 1,
    invert: false,
    components: [newComponent(shape)],
    adjustments: defaultLocalAdjustments,
  };
  return { recipe: { ...recipe, masks: [...recipe.masks, mask] }, mask };
}

export const updateMask = (recipe: DevelopRecipe, id: string, change: (m: Mask) => Mask): DevelopRecipe => ({
  ...recipe,
  masks: recipe.masks.map((m) => (m.id === id ? change(m) : m)),
});

export const removeMask = (recipe: DevelopRecipe, id: string): DevelopRecipe => ({
  ...recipe,
  masks: recipe.masks.filter((m) => m.id !== id),
});

export function duplicateMask(recipe: DevelopRecipe, id: string): DevelopRecipe {
  const m = recipe.masks.find((x) => x.id === id);
  if (!m) return recipe;
  const copy: Mask = { ...m, id: createId("mask"), name: `${m.name} copy`, components: m.components.map((c) => ({ ...c, id: createId("mc") })) };
  const index = recipe.masks.indexOf(m);
  return { ...recipe, masks: [...recipe.masks.slice(0, index + 1), copy, ...recipe.masks.slice(index + 1)] };
}

export const updateComponent = (recipe: DevelopRecipe, maskId: string, componentId: string, change: (c: MaskComponent) => MaskComponent) =>
  updateMask(recipe, maskId, (m) => ({ ...m, components: m.components.map((c) => (c.id === componentId ? change(c) : c)) }));

export const addComponent = (recipe: DevelopRecipe, maskId: string, component: MaskComponent) =>
  updateMask(recipe, maskId, (m) => ({ ...m, components: [...m.components, component] }));

export const removeComponent = (recipe: DevelopRecipe, maskId: string, componentId: string) =>
  updateMask(recipe, maskId, (m) => ({ ...m, components: m.components.filter((c) => c.id !== componentId) }));

export const setLocal = (recipe: DevelopRecipe, maskId: string, field: keyof LocalAdjustments, value: number) =>
  updateMask(recipe, maskId, (m) => ({ ...m, adjustments: { ...m.adjustments, [field]: value } }));

export const invertMask = (recipe: DevelopRecipe, maskId: string) => updateMask(recipe, maskId, (m) => ({ ...m, invert: !m.invert }));
