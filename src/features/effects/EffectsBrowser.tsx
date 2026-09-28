import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "@/app/hooks";
import { effectLayer, insertLayer, layersBelow, locate, updateLayer } from "@/core/document/operations";
import { composite, editDocument } from "@/core/document/session";
import { EFFECTS, effectById, newEffect, PICKS } from "@/core/effects/registry";
import { EFFECT_CATEGORIES, type EffectDef, OUR_PICKS } from "@/core/effects/types";
import { developEngine } from "@/core/gpu/develop-engine";
import { createStore } from "zustand/vanilla";

/**
 * What the chosen effect is for: a new effect layer, the effect of an existing
 * layer, or any other owner (a video edit) that previews on its own image.
 */
export type Target =
  | { mode: "add" }
  | { mode: "replace"; layerId: string }
  | { mode: "custom"; current: string | null; image: () => Promise<ImageBitmap | null>; onPick: (id: string) => void };

/** Which layer the browser is choosing an effect for; null when closed. */
export const effectsBrowser = createStore<{ target: Target | null }>(() => ({ target: null }));
export const openEffectsBrowser = (target: Target = { mode: "add" }) => effectsBrowser.setState({ target });
const close = () => effectsBrowser.setState({ target: null });

const ALL = "All effects";
type Section = typeof OUR_PICKS | typeof ALL | (typeof EFFECT_CATEGORIES)[number];

let lastSection: Section = OUR_PICKS;
let lastView: "grid" | "list" = "grid";

/** Adds an effect layer above the selection (or swaps the effect of an existing layer). */
export function applyEffect(id: string, target: Target) {
  if (target.mode === "custom") {
    target.onPick(id);
    return;
  }
  const def = effectById(id);
  const doc = composite.getState().doc;
  if (!def || !doc) return;
  if (target.mode === "replace") {
    editDocument(`Effect: ${def.name}`, (d) =>
      updateLayer(d, target.layerId, (l) => {
        if (l.kind !== "effect") return l;
        const previous = effectById(l.effect.id)?.name;
        return { ...l, name: l.name === previous ? def.name : l.name, effect: newEffect(id)! };
      }),
    );
    composite.setState({ selection: [target.layerId] });
    return;
  }
  const layer = effectLayer(doc, id);
  if (!layer) return;
  const anchor = composite.getState().selection.at(-1) ?? null;
  editDocument(`Add effect: ${def.name}`, (d) => insertLayer(d, layer, anchor));
  composite.setState({ selection: [layer.id] });
}

export function EffectsBrowserHost() {
  const target = useStore(effectsBrowser, (s) => s.target);
  return target ? <EffectsBrowser target={target} /> : null;
}

function EffectsBrowser({ target }: { target: Target }) {
  const [section, setSection] = useState<Section>(lastSection);
  const [view, setView] = useState<"grid" | "list">(lastView);
  const [query, setQuery] = useState("");
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = target.mode === "replace" ? locate(composite.getState().doc?.layers ?? [], target.layerId)?.layer : null;
  const currentId = target.mode === "custom" ? target.current : current?.kind === "effect" ? current.effect.id : null;

  useEffect(() => {
    lastSection = section;
    lastView = view;
  }, [section, view]);

  useEffect(() => {
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Live previews: every effect, with its defaults, on the layers it would receive.
  useEffect(() => {
    const doc = composite.getState().doc;
    if (target.mode !== "custom" && !doc) return;
    const anchor = target.mode === "replace" ? target.layerId : (composite.getState().selection.at(-1) ?? null);
    const urls: string[] = [];
    const order = [...PICKS.map((id) => effectById(id)!), ...EFFECTS.filter((e) => !PICKS.includes(e.id))];
    const engine = developEngine();
    let cancelled = false;
    // Give the dialog a frame to paint before the GPU work starts.
    const timer = setTimeout(async () => {
      try {
        const source = target.mode === "custom" ? await target.image() : layersBelow(doc!, anchor, target.mode === "replace");
        if (!source || cancelled) return;
        await engine.effectPreviews(source, 360, order.map((e) => newEffect(e.id)!), (i, url) => {
          urls.push(url);
          if (cancelled) URL.revokeObjectURL(url);
          else setPreviews((p) => ({ ...p, [order[i].id]: url }));
        });
      } catch (error) {
        console.warn("Effect previews failed", error);
      }
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      engine.cancelEffectPreviews();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [target]);

  const counts = useMemo(() => {
    const c = new Map<string, number>([[OUR_PICKS, PICKS.length], [ALL, EFFECTS.length]]);
    for (const e of EFFECTS) c.set(e.category, (c.get(e.category) ?? 0) + 1);
    return c;
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return EFFECTS.filter((e) => `${e.name} ${e.category} ${e.description}`.toLowerCase().includes(q));
    if (section === OUR_PICKS) return PICKS.map((id) => effectById(id)!);
    if (section === ALL) return [...EFFECTS];
    return EFFECTS.filter((e) => e.category === section);
  }, [query, section]);

  const focused = (focusId && effectById(focusId)) || list[0] || null;
  const pick = (def: EffectDef) => {
    applyEffect(def.id, target);
    close();
  };
  const sections: Section[] = [OUR_PICKS, ALL, ...EFFECT_CATEGORIES];

  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="fx-browser" role="dialog" aria-modal="true" aria-label="Effects">
        <aside className="fx-nav">
          <div className="fx-title">Effects</div>
          <nav aria-label="Effect categories">
            {sections.map((s) => (
              <button
                key={s}
                type="button"
                className="fx-nav-item"
                aria-current={!query && section === s ? "true" : undefined}
                onClick={() => {
                  setQuery("");
                  setSection(s);
                }}
              >
                <span>{s}</span>
                <span className="faint num">{counts.get(s) ?? 0}</span>
              </button>
            ))}
          </nav>
        </aside>
        <section className="fx-main">
          <header className="fx-head">
            <input
              ref={search}
              className="input fx-search"
              type="search"
              placeholder="Search effects"
              aria-label="Search effects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && list[0]) pick(list[0]);
              }}
            />
            <div className="segmented" role="group" aria-label="View">
              <button type="button" aria-pressed={view === "grid"} onClick={() => setView("grid")}>
                Grid
              </button>
              <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
                List
              </button>
            </div>
            <button type="button" className="btn ghost icon" aria-label="Close" onClick={close}>
              ✕
            </button>
          </header>
          <div className={`fx-items ${view}`} role="list">
            {list.map((def) => (
              <button
                key={def.id}
                type="button"
                role="listitem"
                className="fx-card"
                aria-pressed={def.id === currentId}
                title={def.description}
                onMouseEnter={() => setFocusId(def.id)}
                onFocus={() => setFocusId(def.id)}
                onClick={() => pick(def)}
              >
                <span className="fx-thumb">{previews[def.id] ? <img src={previews[def.id]} alt="" draggable={false} /> : <span className="fx-thumb-wait" />}</span>
                <span className="fx-card-text">
                  <span className="fx-name">{def.name}</span>
                  {view === "list" && <span className="faint">{def.category}</span>}
                  {view === "list" && <span className="dim fx-desc">{def.description}</span>}
                </span>
              </button>
            ))}
            {!list.length && <p className="faint">No effects match “{query}”.</p>}
          </div>
          <div className="fx-foot">
            {focused ? (
              <span>
                <strong>{focused.name}</strong> <span className="dim">— {focused.description}</span>
              </span>
            ) : (
              <span className="dim">Choose an effect to apply and edit.</span>
            )}
            <span className="faint">{target.mode === "custom" ? "Effects stay editable: change or remove them any time." : "Effects are layers: change, mask, blend or remove them any time."}</span>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
