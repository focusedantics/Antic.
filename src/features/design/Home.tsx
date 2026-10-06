import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/app/hooks";
import { openMenu } from "@/components/Menu";
import { Icon } from "@/components/icons";
import { type DocumentRecord, getDocument } from "@/core/catalog/db";
import { composite, moveDocumentToFolder, refreshDocumentList, removeStoredDocument } from "@/core/document/session";
import { duplicateDesign, moveToComposite, newDesign, openDesign } from "./actions";
import { SIZE_GROUPS, SIZE_PRESETS, type SizeGroup, type SizePreset, sizeLabel } from "./presets";

/** A size drawn to scale inside a fixed box. */
export function SizeShape({ width, height, box = 56, slides = 1 }: { width: number; height: number; box?: number; slides?: number }) {
  const total = width * slides;
  const k = box / Math.max(total, height);
  return (
    <span className="size-shape" style={{ width: box, height: box }} aria-hidden="true">
      <span className="size-slides" style={{ width: Math.max(6, total * k), height: Math.max(6, height * k) }}>
        {slides > 1 && Array.from({ length: slides - 1 }, (_, i) => <i key={i} style={{ left: `${((i + 1) / slides) * 100}%` }} />)}
      </span>
    </span>
  );
}

function SizeCard({ preset }: { preset: SizePreset }) {
  return (
    <button type="button" className="size-card" onClick={() => newDesign(preset.width, preset.height, preset.label, "#ffffff", preset.slides ?? 1)} title={`New ${preset.label}, ${sizeLabel(preset.width, preset.height, preset.slides)}`}>
      <SizeShape width={preset.width} height={preset.height} slides={preset.slides} />
      <span className="size-name">{preset.label}</span>
      <span className="size-dims">{sizeLabel(preset.width, preset.height, preset.slides)}</span>
    </button>
  );
}

function CustomSize() {
  const [w, setW] = useState(1080);
  const [h, setH] = useState(1080);
  return (
    <form
      className="size-card custom"
      onSubmit={(e) => {
        e.preventDefault();
        newDesign(w, h, "Untitled design");
      }}
    >
      <SizeShape width={w} height={h} />
      <span className="size-name">Custom size</span>
      <span className="custom-fields">
        <input className="input" type="number" min={16} max={30000} value={w} aria-label="Width (px)" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setW(Math.max(16, Math.min(30000, Number(e.target.value) || 16)))} />
        <span aria-hidden="true">×</span>
        <input className="input" type="number" min={16} max={30000} value={h} aria-label="Height (px)" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setH(Math.max(16, Math.min(30000, Number(e.target.value) || 16)))} />
      </span>
      <button type="submit" className="btn small primary">
        Create
      </button>
    </form>
  );
}

/** Saved designs with their thumbnails, newest first. */
function YourDesigns() {
  const all = useStore(composite, (s) => s.documents);
  const designs = useMemo(() => all.filter((d) => d.design), [all]);
  const folders = useMemo(() => [...new Set(designs.map((d) => d.folder))].filter(Boolean).sort((a, b) => a.localeCompare(b)), [designs]);
  const [folder, setFolder] = useState<string | null>(null);
  const docs = useMemo(() => (folder === null ? designs : designs.filter((d) => d.folder === folder || d.folder.startsWith(`${folder}/`))), [designs, folder]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    void refreshDocumentList();
  }, []);
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    void Promise.all(docs.map((d) => getDocument(d.id))).then((records) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const r of records.filter((x): x is DocumentRecord => !!x?.thumb)) {
        const url = URL.createObjectURL(r.thumb!);
        urls.push(url);
        next[r.id] = url;
      }
      setThumbs(next);
    });
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [docs]);
  if (!designs.length) return <p className="faint">Designs you make appear here.</p>;
  return (
    <>
      {folders.length > 0 && (
        <div className="chip-row" role="group" aria-label="Design folders">
          <button type="button" className="filter-chip" aria-pressed={folder === null} onClick={() => setFolder(null)}>
            All
          </button>
          {folders.map((f) => (
            <button key={f} type="button" className="filter-chip" aria-pressed={folder === f} onClick={() => setFolder(f)}>
              <Icon name="folders" size={12} /> {f}
            </button>
          ))}
        </div>
      )}
    <div className="design-grid">
      {docs.map((d) => (
        <div key={d.id} className="design-tile">
          <button type="button" className="design-thumb" onClick={() => void openDesign(d.id)} aria-label={`Open ${d.name}`}>
            {thumbs[d.id] ? <img src={thumbs[d.id]} alt="" /> : <Icon name="design" size={28} />}
          </button>
          <span className="design-tile-name">{d.name}</span>
          <button
            type="button"
            className="btn ghost small design-tile-more"
            aria-label={`More for ${d.name}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(r.left, r.bottom + 4, [
                { label: "Open", onSelect: () => void openDesign(d.id) },
                { label: "Duplicate", onSelect: () => void duplicateDesign(d.id) },
                {
                  label: "Move to folder…",
                  onSelect: () => {
                    const f = prompt("Folder (empty for none; use / for subfolders)", d.folder);
                    if (f !== null) void moveDocumentToFolder(d.id, f);
                  },
                },
                { label: "Move to Composite", onSelect: () => void moveToComposite(d.id) },
                "separator",
                { label: "Delete…", onSelect: () => confirm(`Delete the design “${d.name}”? Photos stay in the Library.`) && void removeStoredDocument(d.id) },
              ]);
            }}
          >
            ⋯
          </button>
        </div>
      ))}
    </div>
    </>
  );
}

/** The Design workspace's start: sizes to begin from, templates, and your designs. */
export function DesignHome({ templates }: { templates?: (query: string) => React.ReactNode }) {
  const [group, setGroup] = useState<SizeGroup | "All">("Social");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const sizes = SIZE_PRESETS.filter((p) => (q ? [p.label, ...(p.tags ?? [])].some((t) => t.toLowerCase().includes(q)) : group === "All" || p.group === group));
  return (
    <div className="design-home">
      <header className="design-home-head">
        <h1>Design</h1>
        <p className="faint">Posters, posts, stories, wallpapers, flyers, cards and logos, made from your photos.</p>
        <input className="input design-search" type="search" placeholder="Search sizes and templates (story, flyer, wallpaper…)" value={query} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setQuery(e.target.value)} aria-label="Search sizes and templates" />
      </header>
      <section aria-labelledby="design-sizes">
        <h2 id="design-sizes">Start with a size</h2>
        {!q && (
          <div className="chip-row" role="group" aria-label="Size groups">
            {(["All", ...SIZE_GROUPS] as const).map((g) => (
              <button key={g} type="button" className="filter-chip" aria-pressed={group === g} onClick={() => setGroup(g)}>
                {g}
              </button>
            ))}
          </div>
        )}
        <div className="size-row">
          {!q && <CustomSize />}
          {sizes.map((p) => (
            <SizeCard key={p.id} preset={p} />
          ))}
          {q && !sizes.length && <p className="faint">No size matches “{query}”.</p>}
        </div>
      </section>
      {templates?.(q)}
      <section aria-labelledby="design-yours">
        <h2 id="design-yours">Your designs</h2>
        <YourDesigns />
      </section>
    </div>
  );
}
