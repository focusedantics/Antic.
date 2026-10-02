import { chooseFiles, pickerAccept } from "@/lib/files";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "@/app/hooks";
import { toast, ui } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { deleteSnapshot, listSnapshots, type PresetRecord, putSnapshot, type SnapshotRecord } from "@/core/catalog/db";
import { createDefaultRecipe } from "@/core/develop/defaults";
import { applyPreset, copyGroups, defaultCopyGroups, pasteGroups, type RecipeClip, recipeGroups, sanitizeRecipe } from "@/core/develop/operations";
import { allPresets, parsePresetFile, presetFile, removePreset, savePreset } from "@/core/develop/presets";
import type { DevelopRecipe, RecipeGroup } from "@/core/develop/recipe";
import { colorInfoFor, currentHistory, develop, editRecipe, recipeFor, setRecipeFor } from "@/core/develop/session";
import { putPreset } from "@/core/catalog/db";
import { createId } from "@/lib/id";

// ─── Clipboard ──────────────────────────────────────────────────────────────

let clipboard: RecipeClip | null = null;
const clipboardListeners = new Set<() => void>();
const setClipboard = (clip: RecipeClip) => {
  clipboard = clip;
  clipboardListeners.forEach((l) => l());
};
const useClipboard = () =>
  useSyncExternalStore(
    (l) => {
      clipboardListeners.add(l);
      return () => clipboardListeners.delete(l);
    },
    () => clipboard,
  );

export function copySettings(groups: readonly RecipeGroup[] = defaultCopyGroups) {
  const { recipe, info } = develop.getState();
  if (!recipe || !info) return;
  setClipboard(copyGroups(recipe, groups, info.raw));
  toast(`Copied ${groups.length === recipeGroups.length ? "all settings" : `${groups.length} setting groups`}.`);
}

export function pasteSettings(ids?: string[]) {
  if (!clipboard) {
    toast("Nothing copied yet. Copy settings first (Ctrl+Shift+C).");
    return;
  }
  const targets = ids ?? [develop.getState().assetId].filter((x): x is string => !!x);
  for (const id of targets) {
    const current = recipeFor(id);
    if (current) setRecipeFor(id, pasteGroups(current, clipboard, colorInfoFor(id)), "Paste Settings");
  }
  if (targets.length > 1) toast(`Pasted settings to ${targets.length} photos.`);
}

/** Copies the chosen groups of the open photo to every other selected photo. */
export function syncSettings(groups: readonly RecipeGroup[]) {
  const { recipe, info, assetId } = develop.getState();
  if (!recipe || !info || !assetId) return;
  const clip = copyGroups(recipe, groups, info.raw);
  const targets = [...ui.getState().selection].filter((id) => id !== assetId);
  for (const id of targets) {
    const current = recipeFor(id);
    if (current) setRecipeFor(id, pasteGroups(current, clip, colorInfoFor(id)), "Sync Settings");
  }
  toast(`Synced ${groups.length} setting group${groups.length === 1 ? "" : "s"} to ${targets.length} photo${targets.length === 1 ? "" : "s"}.`);
}

export function GroupPicker({ title, action, initial, onDone, onClose }: { title: string; action: string; initial: readonly RecipeGroup[]; onDone: (groups: RecipeGroup[]) => void; onClose: () => void }) {
  const [groups, setGroups] = useState<Set<RecipeGroup>>(new Set(initial));
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={() => setGroups(new Set(recipeGroups.map((g) => g.id)))}>
            Check all
          </button>
          <button type="button" className="btn ghost" onClick={() => setGroups(new Set())} style={{ marginRight: "auto" }}>
            Check none
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!groups.size}
            onClick={() => {
              onDone(recipeGroups.map((g) => g.id).filter((g) => groups.has(g)));
              onClose();
            }}
          >
            {action}
          </button>
        </>
      }
    >
      {recipeGroups.map((g) => (
        <label key={g.id} className="check">
          <input
            type="checkbox"
            checked={groups.has(g.id)}
            onChange={(e) => {
              const next = new Set(groups);
              if (e.target.checked) next.add(g.id);
              else next.delete(g.id);
              setGroups(next);
            }}
          />
          {g.label}
        </label>
      ))}
    </Dialog>
  );
}

// ─── Presets ────────────────────────────────────────────────────────────────

function PresetsPanel() {
  const [presets, setPresets] = useState<PresetRecord[]>([]);
  const [applied, setApplied] = useState<{ preset: PresetRecord; base: DevelopRecipe; assetId: string; amount: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const assetId = useStore(develop, (s) => s.assetId);
  const reload = () => void allPresets().then(setPresets);
  useEffect(reload, []);
  useEffect(() => setApplied(null), [assetId]);

  const apply = (preset: PresetRecord, amount = 1) => {
    const { recipe, info, assetId } = develop.getState();
    if (!recipe || !info || !assetId) return;
    const base = applied && applied.preset.id === preset.id && applied.assetId === assetId ? applied.base : recipe;
    editRecipe(`Preset: ${preset.name}`, () => applyPreset(base, preset.clip, amount, info));
    setApplied({ preset, base, assetId, amount });
  };
  const groups = [...new Set(presets.map((p) => p.group))];
  return (
    <Panel
      id="dev-presets"
      title="Presets"
      actions={
        <>
          <button type="button" className="btn ghost small" title="Create preset from current settings" onClick={() => setCreating(true)}>
            +
          </button>
          <button
            type="button"
            className="btn ghost small"
            title="Import presets"
            onClick={async () => {
              const [file] = await chooseFiles({ accept: pickerAccept(".json,application/json", {}) });
              if (!file) return;
              try {
                const list = parsePresetFile(await file.text());
                for (const p of list) await putPreset(p);
                toast(`Imported ${list.length} preset${list.length === 1 ? "" : "s"}.`);
                reload();
              } catch (error) {
                toast(String(error), "error");
              }
            }}
          >
            ⇪
          </button>
        </>
      }
    >
      {groups.map((group) => (
        <div key={group}>
          <div className="subhead">{group}</div>
          {presets
            .filter((p) => p.group === group)
            .map((p) => (
              <div key={p.id} className="row">
                <button type="button" className="nav-item" aria-current={applied?.preset.id === p.id} onClick={() => apply(p, 1)} title={`Apply ${p.clip.groups.join(", ")}`}>
                  <span className="name">{p.name}</span>
                </button>
                {!p.id.startsWith("builtin:") && (
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={`Delete preset ${p.name}`}
                    onClick={async () => {
                      if (!confirm(`Delete preset “${p.name}”?`)) return;
                      await removePreset(p.id);
                      reload();
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
        </div>
      ))}
      {applied && (
        <div style={{ marginTop: 8 }}>
          <Slider
            label="Amount"
            value={Math.round(applied.amount * 100)}
            min={0}
            max={100}
            defaultValue={100}
            format={(v) => `${v}%`}
            onGestureStart={() => currentHistory()?.begin(`Preset: ${applied.preset.name}`)}
            onGestureEnd={() => currentHistory()?.commit()}
            onChange={(v) => apply(applied.preset, v / 100)}
          />
        </div>
      )}
      {presets.some((p) => !p.id.startsWith("builtin:")) && (
        <button
          type="button"
          className="btn small ghost"
          style={{ marginTop: 6 }}
          onClick={() => {
            const url = URL.createObjectURL(presetFile(presets.filter((p) => !p.id.startsWith("builtin:"))));
            const a = document.createElement("a");
            a.href = url;
            a.download = "focused-presets.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export my presets…
        </button>
      )}
      {creating && (
        <GroupPicker
          title="New Preset"
          action="Choose name…"
          initial={defaultCopyGroups}
          onClose={() => setCreating(false)}
          onDone={async (groups) => {
            const name = prompt("Preset name");
            if (!name) return;
            const { recipe, info } = develop.getState();
            if (!recipe || !info) return;
            await savePreset(name, "User Presets", copyGroups(recipe, groups, info.raw));
            reload();
          }}
        />
      )}
    </Panel>
  );
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

function SnapshotsPanel() {
  const assetId = useStore(develop, (s) => s.assetId);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const reload = () => {
    if (assetId) void listSnapshots(assetId).then((s) => setSnapshots(s.sort((a, b) => a.createdAt - b.createdAt)));
  };
  useEffect(reload, [assetId]);
  if (!assetId) return null;
  return (
    <Panel
      id="dev-snapshots"
      title="Snapshots"
      actions={
        <button
          type="button"
          className="btn ghost small"
          title="Create snapshot"
          onClick={async () => {
            const { recipe } = develop.getState();
            if (!recipe) return;
            const name = prompt("Snapshot name", `Snapshot ${snapshots.length + 1}`);
            if (!name) return;
            await putSnapshot({ id: createId("snap"), assetId, name, createdAt: Date.now(), recipe });
            reload();
          }}
        >
          +
        </button>
      }
      defaultOpen={false}
    >
      {!snapshots.length && <p className="faint">Save named versions of this photo's settings, like “Before retouch” or “Final”.</p>}
      {snapshots.map((s) => (
        <div key={s.id} className="row">
          <button type="button" className="nav-item" onClick={() => {
              const info = develop.getState().info;
              if (info) editRecipe(`Snapshot: ${s.name}`, () => sanitizeRecipe(s.recipe, info));
            }}>
            <span className="name">{s.name}</span>
          </button>
          <button
            type="button"
            className="btn ghost small"
            aria-label={`Delete snapshot ${s.name}`}
            onClick={async () => {
              await deleteSnapshot(s.id);
              reload();
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </Panel>
  );
}

// ─── History ────────────────────────────────────────────────────────────────

function HistoryPanel() {
  const assetId = useStore(develop, (s) => s.assetId);
  const history = assetId ? currentHistory() : null;
  const status = useSyncExternalStore(
    (l) => history?.subscribe(l) ?? (() => {}),
    () => history?.status() ?? null,
  );
  if (!history || !status) return null;
  return (
    <Panel
      id="dev-history"
      title="History"
      actions={
        <button type="button" className="btn ghost small" title="Clear history" onClick={() => history.reset(history.get(), "Cleared")}>
          Clear
        </button>
      }
    >
      <div className="history-list">
        {[...status.entries].reverse().map((entry, ri) => {
          const i = status.entries.length - 1 - ri;
          return (
            <button key={`${i}-${entry.time}`} type="button" className="history-item" aria-current={i === status.index} data-future={i > status.index} onClick={() => history.goTo(i)}>
              {entry.label}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

export function DevelopLeftPanel() {
  const [dialog, setDialog] = useState<"copy" | "sync" | null>(null);
  const clip = useClipboard();
  const selectionSize = useStore(ui, (s) => s.selection.size);
  return (
    <>
      <PresetsPanel />
      <SnapshotsPanel />
      <HistoryPanel />
      <div className="row wrap" style={{ padding: 12, gap: 6 }}>
        <button type="button" className="btn small" title="Copy settings (Ctrl+Shift+C)" onClick={() => setDialog("copy")}>
          Copy…
        </button>
        <button type="button" className="btn small" title="Paste settings (Ctrl+Shift+V)" disabled={!clip} onClick={() => pasteSettings()}>
          Paste
        </button>
        <button type="button" className="btn small" title="Apply this photo's settings to the other selected photos" disabled={selectionSize < 2} onClick={() => setDialog("sync")}>
          Sync…
        </button>
        <button
          type="button"
          className="btn small"
          title="Reset all settings"
          onClick={() => {
            const { info } = develop.getState();
            if (info) editRecipe("Reset", () => createDefaultRecipe(info));
          }}
        >
          Reset
        </button>
      </div>
      {dialog === "copy" && <GroupPicker title="Copy Settings" action="Copy" initial={defaultCopyGroups} onDone={(g) => copySettings(g)} onClose={() => setDialog(null)} />}
      {dialog === "sync" && (
        <GroupPicker title={`Sync Settings to ${selectionSize - 1} photos`} action="Synchronize" initial={defaultCopyGroups} onDone={(g) => syncSettings(g)} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
