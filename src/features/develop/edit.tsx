import { useStore } from "@/app/hooks";
import { formatSigned, Slider } from "@/components/Slider";
import type { Range } from "@/core/develop/params";
import type { DevelopRecipe } from "@/core/develop/recipe";
import { beginGesture, develop, editRecipe, endGesture } from "@/core/develop/session";

export const useRecipe = () => useStore(develop, (s) => s.recipe);

type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
type Group = "basic" | "detail" | "optics" | "effects" | "geometry";

/** Sets one numeric field of a recipe group as an edit labelled after the control. */
export function setField<G extends Group>(group: G, field: NumericKeys<DevelopRecipe[G]>, value: number, label: string) {
  editRecipe(label, (r) => ({ ...r, [group]: { ...r[group], [field]: value } }));
}

/** A slider bound to `recipe[group][field]`. */
export function RecipeSlider<G extends Group>({
  group,
  field,
  range,
  defaultValue = 0,
  track,
  format,
  disabled,
}: {
  group: G;
  field: NumericKeys<DevelopRecipe[G]>;
  range: Range;
  defaultValue?: number;
  track?: string;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const value = useStore(develop, (s) => (s.recipe ? (s.recipe[group][field] as number) : defaultValue));
  return (
    <Slider
      label={range.label}
      value={value}
      min={range.min}
      max={range.max}
      step={range.step}
      defaultValue={defaultValue}
      track={track}
      format={format ?? ((v) => formatSigned(v, range.step))}
      disabled={disabled}
      onGestureStart={() => beginGesture(range.label)}
      onGestureEnd={endGesture}
      onChange={(v) => setField(group, field, v, range.label)}
    />
  );
}

export const TEMPERATURE_TRACK = "linear-gradient(90deg, #3a6fd8, #d8d8d8 50%, #e4c04a)";
export const TINT_TRACK = "linear-gradient(90deg, #4dbb4d, #d8d8d8 50%, #c84fc8)";
