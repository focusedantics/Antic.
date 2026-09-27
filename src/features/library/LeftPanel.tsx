import { type DragEvent, useMemo, useState } from "react";
import { useStore } from "@/app/hooks";
import { setQuery, toast, ui } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { folderTree, type LibrarySource, matchesSmart } from "@/core/catalog/query";
import {
  addToCollection,
  catalog,
  createCollection,
  deleteCollection,
  updateCollection,
} from "@/core/catalog/store";
import type { Collection, SmartRule, SmartRules } from "@/core/catalog/types";
import { openMenu } from "@/components/Menu";

const same = (a: LibrarySource, b: LibrarySource) => JSON.stringify(a) === JSON.stringify(b);

function NavItem({ source, name, count, depth = 0, onMenu, onDrop }: {
  source: LibrarySource;
  name: string;
  count?: number;
  depth?: number;
  onMenu?: (x: number, y: number) => void;
  onDrop?: (ids: string[]) => void;
}) {
  const current = useStore(ui, (s) => same(s.query.source, source));
  const [over, setOver] = useState(false);
  const dropProps = onDrop
    ? {
        onDragOver: (e: DragEvent) => {
          if (e.dataTransfer.types.includes("application/x-focused-assets")) {
            e.preventDefault();
            setOver(true);
          }
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          const ids = ui.getState().selection.size ? [...ui.getState().selection] : [e.dataTransfer.getData("application/x-focused-assets")];
          onDrop(ids.filter(Boolean));
        },
      }
    : {};
  return (
    <button
      type="button"
      className={`nav-item${over ? " drop-target" : ""}`}
      aria-current={current}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => setQuery({ source, expandedStacks: [] })}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      {...dropProps}
    >
      <span className="name">{name}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );
}

export function LibraryLeftPanel() {
  const assets = useStore(catalog, (s) => s.assets);
  const collections = useStore(catalog, (s) => s.collections);
  const [editing, setEditing] = useState<Collection | "new" | null>(null);
  const folders = useMemo(() => folderTree(assets.values()), [assets]);
  const stats = useMemo(() => {
    let latest = 0;
    for (const a of assets.values()) latest = Math.max(latest, a.importedAt);
    let recent = 0;
    const counts = new Map<string, number>();
    for (const a of assets.values()) {
      if (a.importedAt >= latest - 86400000) recent++;
      for (const c of a.collectionIds) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const c of collections.values()) {
      if (c.kind !== "smart" || !c.rules) continue;
      let n = 0;
      for (const a of assets.values()) if (matchesSmart(a, c.rules)) n++;
      counts.set(c.id, n);
    }
    return { recent, counts };
  }, [assets, collections]);

  const sorted = [...collections.values()].sort((a, b) => a.name.localeCompare(b.name));
  const collectionMenu = (c: Collection) => (x: number, y: number) =>
    openMenu(x, y, [
      {
        label: "Rename…",
        onSelect: () => {
          const name = prompt("Rename collection", c.name);
          if (name?.trim()) updateCollection(c.id, { name: name.trim() });
        },
      },
      ...(c.kind === "smart" ? [{ label: "Edit rules…", onSelect: () => setEditing(c) }] : []),
      "separator",
      {
        label: "Delete collection",
        danger: true,
        onSelect: () => {
          if (!confirm(`Delete “${c.name}”? Photos stay in the library.`)) return;
          if (same(ui.getState().query.source, { kind: "collection", id: c.id })) setQuery({ source: { kind: "all" } });
          deleteCollection(c.id);
        },
      },
    ]);

  return (
    <>
      <Panel id="lib-catalog" title="Catalog">
        <NavItem source={{ kind: "all" }} name="All Photographs" count={assets.size} />
        <NavItem source={{ kind: "recent" }} name="Previous Import" count={stats.recent} />
      </Panel>
      <Panel id="lib-folders" title="Folders">
        {folders.length === 0 && <p className="faint">Import a folder to browse it here.</p>}
        {folders.map((f) => (
          <NavItem key={f.path} source={{ kind: "folder", path: f.path }} name={f.name} count={f.count} depth={f.depth} />
        ))}
      </Panel>
      <Panel
        id="lib-collections"
        title="Collections"
        actions={
          <>
            <button
              type="button"
              className="btn ghost small"
              title="New collection"
              onClick={() => {
                const name = prompt("Collection name");
                if (!name) return;
                const c = createCollection(name, "collection");
                const selected = [...ui.getState().selection];
                if (selected.length && confirm(`Add the ${selected.length} selected photo(s) to “${c.name}”?`)) addToCollection(selected, c.id);
              }}
            >
              + New
            </button>
            <button type="button" className="btn ghost small" title="New smart collection" onClick={() => setEditing("new")}>
              + Smart
            </button>
          </>
        }
      >
        {sorted.length === 0 && <p className="faint">Collections group photos from anywhere. Smart collections fill themselves from rules.</p>}
        {sorted.map((c) => (
          <NavItem
            key={c.id}
            source={{ kind: "collection", id: c.id }}
            name={`${c.kind === "smart" ? "⚙ " : ""}${c.name}`}
            count={stats.counts.get(c.id) ?? 0}
            onMenu={collectionMenu(c)}
            onDrop={c.kind === "collection" ? (ids) => {
              addToCollection(ids, c.id);
              toast(`Added ${ids.length} to “${c.name}”.`);
            } : undefined}
          />
        ))}
      </Panel>
      {editing && <SmartCollectionDialog collection={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

type RuleField = SmartRule["field"];
const ruleFields: { id: RuleField; label: string; type: "number" | "text" | "choice" | "date" | "bool"; choices?: string[] }[] = [
  { id: "rating", label: "Rating", type: "number" },
  { id: "flag", label: "Flag", type: "choice", choices: ["pick", "reject", "none"] },
  { id: "label", label: "Color label", type: "choice", choices: ["red", "yellow", "green", "blue", "purple", "none"] },
  { id: "kind", label: "File type", type: "choice", choices: ["raw", "jpeg", "heic", "tiff", "png", "webp", "avif"] },
  { id: "keyword", label: "Keyword", type: "text" },
  { id: "camera", label: "Camera", type: "text" },
  { id: "lens", label: "Lens", type: "text" },
  { id: "fileName", label: "File name", type: "text" },
  { id: "folder", label: "Folder", type: "text" },
  { id: "iso", label: "ISO", type: "number" },
  { id: "focalLength", label: "Focal length", type: "number" },
  { id: "fNumber", label: "Aperture (ƒ)", type: "number" },
  { id: "captureTime", label: "Capture date", type: "date" },
  { id: "edited", label: "Has edits", type: "bool" },
];

function defaultRule(field: RuleField): SmartRule {
  const def = ruleFields.find((f) => f.id === field)!;
  switch (def.type) {
    case "number":
      return { field, op: ">=", value: field === "rating" ? 3 : 100 } as SmartRule;
    case "text":
      return { field, op: "contains", value: "" } as SmartRule;
    case "choice":
      return { field, op: "=", value: def.choices![0] } as SmartRule;
    case "date":
      return { field, op: ">=", value: Date.now() - 30 * 86400000 } as SmartRule;
    case "bool":
      return { field, op: "=", value: true } as SmartRule;
  }
}

function SmartCollectionDialog({ collection, onClose }: { collection: Collection | null; onClose: () => void }) {
  const [name, setName] = useState(collection?.name ?? "Smart Collection");
  const [rules, setRules] = useState<SmartRules>(collection?.rules ?? { match: "all", rules: [defaultRule("rating")] });
  const assets = useStore(catalog, (s) => s.assets);
  const matches = useMemo(() => [...assets.values()].filter((a) => matchesSmart(a, rules)).length, [assets, rules]);
  const setRule = (i: number, rule: SmartRule) => setRules({ ...rules, rules: rules.rules.map((r, j) => (i === j ? rule : r)) });
  const save = () => {
    if (collection) updateCollection(collection.id, { name, rules });
    else {
      const c = createCollection(name, "smart", rules);
      setQuery({ source: { kind: "collection", id: c.id } });
    }
    onClose();
  };
  return (
    <Dialog
      title={collection ? "Edit Smart Collection" : "New Smart Collection"}
      onClose={onClose}
      footer={
        <>
          <span className="dim num" style={{ marginRight: "auto" }}>
            {matches} matching photo{matches === 1 ? "" : "s"}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save}>
            {collection ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <div className="row">
        Match
        <select className="input" value={rules.match} onChange={(e) => setRules({ ...rules, match: e.target.value as "all" | "any" })}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of the following rules:
      </div>
      {rules.rules.map((rule, i) => {
        const def = ruleFields.find((f) => f.id === rule.field)!;
        return (
          <div className="row" key={i}>
            <select className="input" value={rule.field} onChange={(e) => setRule(i, defaultRule(e.target.value as RuleField))}>
              {ruleFields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            {(def.type === "number" || def.type === "date") && (
              <select className="input" value={rule.op} onChange={(e) => setRule(i, { ...rule, op: e.target.value } as SmartRule)}>
                <option value=">=">{def.type === "date" ? "on or after" : "≥"}</option>
                <option value="<=">{def.type === "date" ? "on or before" : "≤"}</option>
                {rule.field === "rating" && <option value="=">=</option>}
              </select>
            )}
            {def.type === "number" && (
              <input className="input" type="number" style={{ width: 90 }} value={rule.value as number} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setRule(i, { ...rule, value: Number(e.target.value) } as SmartRule)} />
            )}
            {def.type === "text" && (
              <input className="input" placeholder="contains…" value={rule.value as string} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setRule(i, { ...rule, value: e.target.value } as SmartRule)} />
            )}
            {def.type === "choice" && (
              <select className="input" value={rule.value as string} onChange={(e) => setRule(i, { ...rule, value: e.target.value } as SmartRule)}>
                {def.choices!.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            {def.type === "date" && (
              <input
                className="input"
                type="date"
                value={new Date(rule.value as number).toISOString().slice(0, 10)}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => setRule(i, { ...rule, value: new Date(e.target.value).getTime() } as SmartRule)}
              />
            )}
            {def.type === "bool" && (
              <select className="input" value={String(rule.value)} onChange={(e) => setRule(i, { ...rule, value: e.target.value === "true" } as SmartRule)}>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            )}
            <button type="button" className="btn ghost small" aria-label="Remove rule" onClick={() => setRules({ ...rules, rules: rules.rules.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        );
      })}
      <div>
        <button type="button" className="btn small" onClick={() => setRules({ ...rules, rules: [...rules.rules, defaultRule("keyword")] })}>
          + Add rule
        </button>
      </div>
    </Dialog>
  );
}
