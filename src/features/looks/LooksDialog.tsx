import { useEffect, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { getAsset } from "@/core/catalog/store";
import type { RecipeGroup } from "@/core/develop/recipe";
import { colorInfoFor, recipeFor } from "@/core/develop/session";
import { composite } from "@/core/document/session";
import { download } from "@/core/export/destination";
import { basePhoto, describeLook, type Look, lookFromRecipe, lookLayers, lookToFile, newLook, readLookFile } from "@/core/looks/look";
import { looks, refreshLooks, removeLook, saveLook } from "@/core/looks/store";
import { video } from "@/core/video/session";
import { ProgressBar } from "@/features/export/ExportParts";

/** Where the Looks dialog was opened from, which decides what it saves and applies to. */
export type LooksContext = { kind: "library"; ids: readonly string[] } | { kind: "develop"; assetId: string } | { kind: "composite" } | { kind: "video" };

const host = createStore<{ context: LooksContext | null }>(() => ({ context: null }));
export const openLooks = (context: LooksContext) => host.setState({ context });
const close = () => host.setState({ context: null });

export function LooksHost() {
  const context = useStore(host, (s) => s.context);
  return context ? <LooksDialog context={context} /> : null;
}

const ADJUSTMENTS: RecipeGroup[] = ["profile", "whiteBalance", "basic", "toneCurve", "colorMixer", "colorGrading", "detail", "optics", "effects"];

/** The asset whose develop settings a look saved here would carry. */
function sourceAsset(context: LooksContext): string | null {
  if (context.kind === "develop") return context.assetId;
  if (context.kind === "composite") {
    const doc = composite.getState().doc;
    const photo = doc ? basePhoto(doc) : undefined;
    return photo?.develop === "asset" ? photo.assetId : null;
  }
  return null;
}

function SaveLook({ context, onSaved }: { context: LooksContext; onSaved: (look: Look) => void }) {
  const assetId = sourceAsset(context);
  const recipe = assetId ? recipeFor(assetId) : null;
  const doc = useStore(composite, (s) => s.doc);
  const edit = useStore(video, (s) => s.edit);
  const layers = context.kind === "composite" && doc ? lookLayers(doc) : null;
  const [name, setName] = useState("");
  const [include, setInclude] = useState({ develop: true, masks: (recipe?.masks.length ?? 0) > 0, geometry: false, layers: true, video: true });
  const toggle = (k: keyof typeof include) => setInclude((s) => ({ ...s, [k]: !s[k] }));
  if (context.kind === "library") return null;

  const save = async () => {
    const groups: RecipeGroup[] = [...(include.develop ? ADJUSTMENTS : []), ...(include.masks ? (["masks"] as const) : []), ...(include.geometry ? (["geometry"] as const) : [])];
    const look = newLook(name || (assetId ? `${getAsset(assetId)?.fileName.replace(/\.[^.]+$/, "")} look` : "My look"), {
      develop: recipe && assetId && groups.length ? lookFromRecipe(recipe, groups, colorInfoFor(assetId).raw) : null,
      layers: include.layers ? layers : null,
      video: context.kind === "video" && include.video && edit?.effect ? { effect: edit.effect, effectMix: edit.effectMix } : null,
    });
    if (!look.develop && !look.layers && !look.video) {
      toast("Nothing to save: choose at least one part that has edits.", "error");
      return;
    }
    await saveLook(look);
    setName("");
    onSaved(look);
    toast(`Saved the look “${look.name}”.`);
  };

  return (
    <div className="looks-save">
      <div className="subhead">Save the current edits as a look</div>
      <div className="row">
        <input className="input" style={{ flex: 1 }} placeholder="Look name" value={name} maxLength={120} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} aria-label="Look name" />
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save look
        </button>
      </div>
      <div className="row wrap">
        {recipe && (
          <>
            <label className="check">
              <input type="checkbox" checked={include.develop} onChange={() => toggle("develop")} /> Develop adjustments
            </label>
            <label className="check">
              <input type="checkbox" checked={include.masks} disabled={!recipe.masks.length} onChange={() => toggle("masks")} /> Masks ({recipe.masks.length})
            </label>
            <label className="check">
              <input type="checkbox" checked={include.geometry} onChange={() => toggle("geometry")} /> Crop & transform
            </label>
          </>
        )}
        {context.kind === "composite" && (
          <label className="check">
            <input type="checkbox" checked={include.layers} disabled={!layers} onChange={() => toggle("layers")} /> Layers: effects, text, adjustments… ({layers?.items.length ?? 0})
          </label>
        )}
        {context.kind === "video" && (
          <label className="check">
            <input type="checkbox" checked={include.video} disabled={!edit?.effect} onChange={() => toggle("video")} /> Video effect{edit?.effect ? "" : " (none yet)"}
          </label>
        )}
      </div>
    </div>
  );
}

function LooksDialog({ context }: { context: LooksContext }) {
  const list = useStore(looks, (s) => s.list);
  const [options, setOptions] = useState({ develop: true, layers: true, redetect: true });
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    void refreshLooks();
  }, []);

  const targetLabel =
    context.kind === "library" ? `${context.ids.length} selected photo${context.ids.length === 1 ? "" : "s"}` : context.kind === "develop" ? "this photo" : context.kind === "composite" ? "this composition" : "this video";

  const apply = async (look: Look) => {
    const { applyLookToComposition, applyLookToPhotos, applyLookToVideo } = await import("./apply");
    const report = (done: number, total: number, label: string) => setProgress({ done, total, label });
    try {
      let extra = "";
      if (context.kind === "video") {
        if (!look.video) return toast("This look has no video effect.", "error");
        applyLookToVideo(look);
      } else if (context.kind === "composite") {
        await applyLookToComposition(look, options, report);
      } else {
        const ids = context.kind === "library" ? context.ids : [context.assetId];
        const made = await applyLookToPhotos(look, ids, options, report);
        if (made === 1) extra = " and opened it as a composition in Composite";
        else if (made > 1) extra = `. Created ${made} compositions with its layers — find them in Composite`;
      }
      toast(`Applied “${look.name}” to ${targetLabel}${extra}.`);
      close();
    } catch (error) {
      toast(`Couldn't apply the look: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setProgress(null);
    }
  };

  const importFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".focused,application/zip";
    input.multiple = true;
    input.onchange = async () => {
      for (const file of input.files ?? []) {
        try {
          const look = await readLookFile(file);
          if (!look) {
            toast(`${file.name} is a project, not a look. Open it with Composite → Open .focused…`, "error");
            continue;
          }
          await saveLook(look);
          setFresh(look.id);
          toast(`Added the look “${look.name}”.`);
        } catch (error) {
          toast(`${file.name}: ${error instanceof Error ? error.message : error}`, "error");
        }
      }
    };
    input.click();
  };

  const usable = (look: Look) => (context.kind === "video" ? !!look.video : !!(look.develop || look.layers));

  return (
    <Dialog
      wide
      title="Looks"
      onClose={() => !progress && close()}
      footer={
        <>
          <button type="button" className="btn" style={{ marginRight: "auto" }} onClick={importFile} disabled={!!progress}>
            Import .focused…
          </button>
          <button type="button" className="btn" onClick={close} disabled={!!progress}>
            Close
          </button>
        </>
      }
    >
      <p className="dim" style={{ margin: 0 }}>
        A look saves your edits — develop settings, masks, effect and text layers, video effects — so you can apply the same result to other photos, compositions and videos. Share one as a
        .focused file.
      </p>
      {progress && <ProgressBar {...progress} />}
      <SaveLook context={context} onSaved={(l) => setFresh(l.id)} />
      <div className="subhead">Apply to {targetLabel}</div>
      {context.kind !== "video" && (
        <div className="row wrap">
          <label className="check">
            <input type="checkbox" checked={options.develop} onChange={(e) => setOptions({ ...options, develop: e.target.checked })} /> Develop settings & masks
          </label>
          <label className="check">
            <input type="checkbox" checked={options.layers} onChange={(e) => setOptions({ ...options, layers: e.target.checked })} />{" "}
            {context.kind === "composite" ? "Add the look's layers" : "Layers (makes a composition per photo)"}
          </label>
          <label className="check" title="AI masks (subject, sky, people, objects) are detected again on each photo">
            <input type="checkbox" checked={options.redetect} onChange={(e) => setOptions({ ...options, redetect: e.target.checked })} /> Re-detect AI masks
          </label>
        </div>
      )}
      <div className="looks-list">
        {!list.length && <p className="faint">No looks yet. Save one above, or import a .focused look file.</p>}
        {list.map((look) => (
          <div key={look.id} className="look-row" aria-current={look.id === fresh}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="look-name">{look.name}</div>
              <div className="faint" style={{ fontSize: 11 }}>
                {describeLook(look).join(" · ") || "empty"}
              </div>
            </div>
            <button type="button" className="btn small primary" disabled={!!progress || !usable(look) || (context.kind === "library" && !context.ids.length)} onClick={() => void apply(look)}>
              Apply
            </button>
            <button type="button" className="btn small" title="Download as a .focused file" onClick={async () => download(`${look.name}.focused`, await lookToFile(look))}>
              .focused
            </button>
            <button
              type="button"
              className="btn small ghost"
              aria-label={`Delete ${look.name}`}
              onClick={() => {
                if (confirm(`Delete the look “${look.name}”?`)) void removeLook(look.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
