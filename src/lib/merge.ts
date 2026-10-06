/**
 * Edits shown for one item and applied to several. A panel shows the last selected
 * layer; its controls send whole values built from that layer (a shadow with a new
 * blur, a shape with more points). Another selected layer should take only what
 * changed, onto its own values, so its other settings stay its own.
 */

type Obj = Record<string, unknown>;

const isPlain = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `own` with the fields that differ between `shown` and `next` set as in `next` (and fields `next` dropped removed). */
export function mergeChanged<T extends object>(shown: T, next: T, own: T): T {
  const was = shown as Obj;
  const now = next as Obj;
  const out: Obj = { ...(own as Obj) };
  for (const [k, v] of Object.entries(now)) if (was[k] !== v) out[k] = v;
  for (const k of Object.keys(was)) if (!(k in now)) delete out[k];
  return out as T;
}

/**
 * A patch built against `shown`, applied to `own`. Plain values are set. Object values
 * (a highlight, a gradient, a motion) merge only their changed fields into the layer's
 * own object; turning one on (`shown` had none) keeps a layer's own if it has one; and
 * a layer without one is left without when `shown` merely tweaks its own. `undefined`
 * turns a setting off everywhere.
 */
export function mergePatch<T extends object>(shown: T, patch: Partial<T>, own: T): T {
  const was = shown as Obj;
  const mine = own as Obj;
  const out: Obj = { ...mine };
  for (const [k, v] of Object.entries(patch as Obj)) {
    if (!isPlain(v)) out[k] = v;
    else if (!isPlain(was[k])) out[k] = isPlain(mine[k]) ? mine[k] : v;
    else if (isPlain(mine[k])) out[k] = mergeChanged(was[k] as Obj, v, mine[k] as Obj);
  }
  return out as T;
}
