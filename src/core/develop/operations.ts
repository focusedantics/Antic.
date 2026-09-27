import { clamp } from "@/lib/math";
import { createId } from "@/lib/id";
import {
  createDefaultRecipe,
  defaultBasic,
  defaultColorGrading,
  defaultColorMixer,
  defaultDetail,
  defaultEffects,
  defaultLocalAdjustments,
  defaultOptics,
  defaultToneCurve,
  fullCrop,
  identityCurve,
  type SourceColorInfo,
} from "./defaults";
import {
  basicRanges,
  detailRanges,
  effectsRanges,
  localRanges,
  opticsRanges,
  parametricRanges,
  type Range,
  temperatureRange,
  tintRange,
} from "./params";
import type {
  BrushStroke,
  Curve,
  DevelopRecipe,
  GradeWheel,
  Mask,
  MaskComponent,
  MaskShape,
  RecipeGroup,
} from "./recipe";

// ─── Sanitizing ───────────────────────────────────────────────────────────────
// Recipes arrive from IndexedDB, the clipboard, presets, XMP-like imports and
// project files. Everything goes through `sanitizeRecipe`, which fills gaps from
// defaults and clamps every value, so the renderer can trust what it receives.

type Unknown = Record<string, unknown> | undefined;
const obj = (v: unknown): Unknown =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const num = (v: unknown, fallback: number, range?: Pick<Range, "min" | "max">) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return range ? clamp(n, range.min, range.max) : n;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

function numbers<T extends Record<string, number>>(input: unknown, defaults: T, ranges: Record<string, Range>): T {
  const source = obj(input);
  const out: Record<string, number> = {};
  for (const key of Object.keys(defaults)) {
    out[key] = num(source?.[key], defaults[key], ranges[key]);
  }
  return out as T;
}

export function sanitizeCurve(input: unknown): Curve {
  if (!Array.isArray(input) || input.length < 2) return identityCurve;
  const points = input
    .map((p) => obj(p))
    .filter((p): p is Record<string, unknown> => !!p)
    .map((p) => ({ x: clamp(num(p.x, 0)), y: clamp(num(p.y, 0)) }))
    .sort((a, b) => a.x - b.x);
  const out: { x: number; y: number }[] = [];
  for (const p of points) if (!out.length || p.x - out[out.length - 1].x >= 1 / 1024) out.push(p);
  return out.length >= 2 ? out : identityCurve;
}

function wheel(input: unknown): GradeWheel {
  const w = obj(input);
  return {
    hue: ((num(w?.hue, 0) % 360) + 360) % 360,
    saturation: num(w?.saturation, 0, { min: 0, max: 100 }),
    luminance: num(w?.luminance, 0, { min: -100, max: 100 }),
  };
}

const eight = (v: unknown) => {
  const a = Array.isArray(v) ? v : [];
  return Array.from({ length: 8 }, (_, i) => num(a[i], 0, { min: -100, max: 100 }));
};

const point = (v: unknown, fx = 0.5, fy = 0.5) => {
  const p = obj(v);
  return { x: num(p?.x, fx, { min: -2, max: 3 }), y: num(p?.y, fy, { min: -2, max: 3 }) };
};

function sanitizeStroke(input: unknown): BrushStroke | null {
  const s = obj(input);
  if (!s || !Array.isArray(s.points)) return null;
  const points = s.points
    .filter((p): p is number[] => Array.isArray(p) && p.length >= 2)
    .map((p) => [num(p[0], 0), num(p[1], 0), clamp(num(p[2], 1))] as const);
  if (!points.length) return null;
  return {
    mode: s.mode === "erase" ? "erase" : "paint",
    size: num(s.size, 0.05, { min: 0.0005, max: 2 }),
    feather: num(s.feather, 0.5, { min: 0, max: 1 }),
    flow: num(s.flow, 1, { min: 0.01, max: 1 }),
    density: num(s.density, 1, { min: 0, max: 1 }),
    points,
  };
}

function sanitizeShape(input: unknown): MaskShape | null {
  const s = obj(input);
  switch (s?.kind) {
    case "brush":
      return {
        kind: "brush",
        strokes: (Array.isArray(s.strokes) ? s.strokes : []).map(sanitizeStroke).filter((x) => !!x),
      };
    case "linear":
      return { kind: "linear", start: point(s.start, 0.5, 0.25), end: point(s.end, 0.5, 0.75) };
    case "radial":
      return {
        kind: "radial",
        center: point(s.center),
        radiusX: num(s.radiusX, 0.2, { min: 0.001, max: 4 }),
        radiusY: num(s.radiusY, 0.2, { min: 0.001, max: 4 }),
        angle: num(s.angle, 0),
        feather: num(s.feather, 50, { min: 0, max: 100 }),
      };
    case "luminance": {
      const low = num(s.low, 0.5, { min: 0, max: 1 });
      return {
        kind: "luminance",
        low,
        high: num(s.high, 1, { min: low, max: 1 }),
        smoothness: num(s.smoothness, 0.1, { min: 0, max: 1 }),
      };
    }
    case "color":
      return {
        kind: "color",
        samples: (Array.isArray(s.samples) ? s.samples : [])
          .filter((c): c is number[] => Array.isArray(c) && c.length === 3)
          .slice(0, 5)
          .map((c) => [num(c[0], 0), num(c[1], 0), num(c[2], 0)] as const),
        refine: num(s.refine, 50, { min: 0, max: 100 }),
      };
    case "ai": {
      if (typeof s.rasterId !== "string") return null;
      const targets = ["subject", "sky", "background", "object", "person"] as const;
      const target = targets.find((t) => t === s.target) ?? "subject";
      const points = Array.isArray(s.points)
        ? s.points
            .map((p) => obj(p))
            .filter((p): p is Record<string, unknown> => !!p)
            .map((p) => ({ x: num(p.x, 0), y: num(p.y, 0), positive: p.positive !== false }))
        : undefined;
      return { kind: "ai", target, rasterId: s.rasterId, points };
    }
    default:
      return null;
  }
}

function sanitizeComponent(input: unknown): MaskComponent | null {
  const c = obj(input);
  const shape = sanitizeShape(c?.shape);
  if (!c || !shape) return null;
  const operation = c.operation === "subtract" || c.operation === "intersect" ? c.operation : "add";
  return {
    id: typeof c.id === "string" ? c.id : createId("mc"),
    operation,
    invert: bool(c.invert, false),
    opacity: num(c.opacity, 1, { min: 0, max: 1 }),
    shape,
  };
}

function sanitizeMask(input: unknown): Mask | null {
  const m = obj(input);
  if (!m) return null;
  const components = (Array.isArray(m.components) ? m.components : [])
    .map(sanitizeComponent)
    .filter((c): c is MaskComponent => !!c);
  return {
    id: typeof m.id === "string" ? m.id : createId("mask"),
    name: typeof m.name === "string" ? m.name.slice(0, 80) : "Mask",
    visible: bool(m.visible, true),
    amount: num(m.amount, 1, { min: 0, max: 1 }),
    components,
    adjustments: numbers(m.adjustments, defaultLocalAdjustments, localRanges),
  };
}

export function sanitizeRecipe(input: unknown, info: SourceColorInfo): DevelopRecipe {
  const base = createDefaultRecipe(info);
  const s = obj(input);
  if (!s) return base;
  const wb = obj(s.whiteBalance);
  const temperature = info.raw ? temperatureRange.raw : temperatureRange.rendered;
  const tint = info.raw ? tintRange.raw : tintRange.rendered;
  const tc = obj(s.toneCurve);
  const mixer = obj(s.colorMixer);
  const grade = obj(s.colorGrading);
  const geo = obj(s.geometry);
  const crop = obj(geo?.crop);
  const cx = num(crop?.x, 0, { min: 0, max: 1 });
  const cy = num(crop?.y, 0, { min: 0, max: 1 });
  const optics = obj(s.optics);
  return {
    version: 1,
    profile: s.profile === "monochrome" ? "monochrome" : "color",
    whiteBalance: {
      mode: wb?.mode === "custom" || wb?.mode === "auto" ? wb.mode : "as-shot",
      temperature: num(wb?.temperature, base.whiteBalance.temperature, temperature),
      tint: num(wb?.tint, base.whiteBalance.tint, tint),
    },
    basic: numbers(s.basic, defaultBasic, basicRanges),
    toneCurve: {
      parametric: numbers(tc?.parametric, defaultToneCurve.parametric, parametricRanges),
      master: sanitizeCurve(tc?.master),
      red: sanitizeCurve(tc?.red),
      green: sanitizeCurve(tc?.green),
      blue: sanitizeCurve(tc?.blue),
    },
    colorMixer: mixer
      ? { hue: eight(mixer.hue), saturation: eight(mixer.saturation), luminance: eight(mixer.luminance) }
      : defaultColorMixer,
    colorGrading: grade
      ? {
          shadows: wheel(grade.shadows),
          midtones: wheel(grade.midtones),
          highlights: wheel(grade.highlights),
          global: wheel(grade.global),
          blending: num(grade.blending, 50, { min: 0, max: 100 }),
          balance: num(grade.balance, 0, { min: -100, max: 100 }),
        }
      : defaultColorGrading,
    detail: numbers(s.detail, defaultDetail(info.raw), detailRanges),
    optics: {
      ...numbers(optics, { distortion: 0, vignetting: 0, vignettingMidpoint: 50 }, opticsRanges),
      removeChromaticAberration: bool(optics?.removeChromaticAberration, defaultOptics.removeChromaticAberration),
    },
    geometry: {
      rotate90: ((Math.round(num(geo?.rotate90, 0)) % 4) + 4) % 4,
      flipHorizontal: bool(geo?.flipHorizontal, false),
      flipVertical: bool(geo?.flipVertical, false),
      angle: num(geo?.angle, 0, { min: -45, max: 45 }),
      crop: crop
        ? {
            x: cx,
            y: cy,
            width: num(crop.width, 1, { min: 0.01, max: 1 - cx }),
            height: num(crop.height, 1, { min: 0.01, max: 1 - cy }),
          }
        : fullCrop,
      aspect: typeof geo?.aspect === "number" && geo.aspect > 0 ? clamp(geo.aspect, 0.05, 20) : null,
      vertical: num(geo?.vertical, 0, { min: -100, max: 100 }),
      horizontal: num(geo?.horizontal, 0, { min: -100, max: 100 }),
    },
    effects: numbers(s.effects, defaultEffects, effectsRanges),
    masks: (Array.isArray(s.masks) ? s.masks : []).map(sanitizeMask).filter((m): m is Mask => !!m),
  };
}

// ─── Comparison ───────────────────────────────────────────────────────────────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function isDefaultRecipe(recipe: DevelopRecipe, info: SourceColorInfo) {
  return deepEqual(recipe, createDefaultRecipe(info));
}

/** Groups that differ from the defaults, for badges and "reset" affordances. */
export function editedGroups(recipe: DevelopRecipe, info: SourceColorInfo): RecipeGroup[] {
  const base = createDefaultRecipe(info);
  return (Object.keys(base) as (keyof DevelopRecipe)[])
    .filter((k): k is RecipeGroup => k !== "version" && !deepEqual(recipe[k], base[k]));
}

// ─── Copy / paste / sync ──────────────────────────────────────────────────────

export const recipeGroups: { id: RecipeGroup; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "whiteBalance", label: "White Balance" },
  { id: "basic", label: "Basic Tone & Presence" },
  { id: "toneCurve", label: "Tone Curve" },
  { id: "colorMixer", label: "Color Mixer" },
  { id: "colorGrading", label: "Color Grading" },
  { id: "detail", label: "Detail" },
  { id: "optics", label: "Lens Corrections" },
  { id: "geometry", label: "Crop & Transform" },
  { id: "effects", label: "Effects" },
  { id: "masks", label: "Masks" },
];

/** Groups copied by default: everything except the crop and masks, which are usually photo-specific. */
export const defaultCopyGroups: RecipeGroup[] = recipeGroups
  .map((g) => g.id)
  .filter((g) => g !== "geometry" && g !== "masks");

export type RecipeClip = { readonly groups: readonly RecipeGroup[]; readonly values: Partial<DevelopRecipe>; readonly raw: boolean };

export function copyGroups(recipe: DevelopRecipe, groups: readonly RecipeGroup[], raw: boolean): RecipeClip {
  const values: Record<string, unknown> = {};
  for (const g of groups) values[g] = structuredClone(recipe[g]);
  return { groups: [...groups], values: values as Partial<DevelopRecipe>, raw };
}

/**
 * Applies copied groups onto another photo's recipe. White balance does not
 * transfer between RAW Kelvin and rendered relative scales, so it is skipped
 * when the kinds differ. Masks get fresh ids so photos never share them.
 */
export function pasteGroups(target: DevelopRecipe, clip: RecipeClip, info: SourceColorInfo): DevelopRecipe {
  const next: Record<string, unknown> = { ...target };
  for (const g of clip.groups) {
    if (g === "whiteBalance" && clip.raw !== info.raw) continue;
    let value: unknown = clip.values[g];
    if (g === "masks" && Array.isArray(value)) {
      value = (value as Mask[]).map((m) => ({
        ...m,
        id: createId("mask"),
        components: m.components.map((c) => ({ ...c, id: createId("mc") })),
      }));
    }
    next[g] = value;
  }
  return sanitizeRecipe(next, info);
}

// ─── Presets ──────────────────────────────────────────────────────────────────

function blendValue(from: unknown, to: unknown, t: number): unknown {
  if (typeof from === "number" && typeof to === "number") return from + (to - from) * t;
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length && from.every((v) => typeof v === "number"))
    return from.map((v, i) => blendValue(v, to[i], t));
  const fo = obj(from);
  const tob = obj(to);
  if (fo && tob) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(tob)) out[k] = k in fo ? blendValue(fo[k], tob[k], t) : tob[k];
    return out;
  }
  // Curves, booleans, strings and structural values switch at the halfway point.
  return t >= 0.5 ? to : from;
}

/**
 * Applies a preset at `strength` 0..1 (1 = exactly the preset). Numbers are
 * interpolated from the photo's current values toward the preset's.
 */
export function applyPreset(
  target: DevelopRecipe,
  preset: RecipeClip,
  strength: number,
  info: SourceColorInfo,
): DevelopRecipe {
  const full = pasteGroups(target, preset, info);
  if (strength >= 1) return full;
  const blended: Record<string, unknown> = { ...target };
  for (const g of preset.groups) blended[g] = blendValue(target[g], full[g], clamp(strength));
  return sanitizeRecipe(blended, info);
}

export function resetGroup(recipe: DevelopRecipe, group: RecipeGroup, info: SourceColorInfo): DevelopRecipe {
  return { ...recipe, [group]: createDefaultRecipe(info)[group] };
}
