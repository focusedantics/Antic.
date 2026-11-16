import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { openMenu } from "@/components/Menu";
import { Icon } from "@/components/icons";
import { composite, moveDocumentToFolder, refreshDocumentList, removeStoredDocument } from "@/core/document/session";
import { ago } from "@/lib/ago";
import { duplicateDesign, moveToComposite, newDesign, openDesign } from "./actions";
import { SIZE_GROUPS, SIZE_PRESETS, type SizeGroup, type SizePreset, sizeLabel } from "./presets";
import { useDesignThumb } from "./thumbs";

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

type Saved = ReturnType<typeof composite.getState>["documents"][number];

/** How many of the newest designs the shelf holds before "All designs" is the way to the rest. */
const SHELF = 12;

const sizeOf = (d: Saved) => (d.width && d.height ? sizeLabel(Math.round(d.width / d.slides), d.height, d.slides) : "");

function designMenu(d: Saved, at: DOMRect) {
  openMenu(at.left, at.bottom + 4, [
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
}

/** One saved design: its thumbnail (read when the tile is on screen), name, age and menu. */
function DesignTile({ d, lead = false }: { d: Saved; lead?: boolean }) {
  const thumb = useDesignThumb(d.id, d.updatedAt);
  return (
    <div className="design-tile" data-lead={lead || undefined}>
      <button type="button" className="design-thumb" onClick={() => void openDesign(d.id)} aria-label={`Open ${d.name}`}>
        {thumb ? <img src={thumb} alt="" decoding="async" /> : <Icon name="design" size={28} />}
        {lead && <span className="design-continue">Continue</span>}
      </button>
      <span className="design-tile-name">{d.name}</span>
      <span className="design-tile-meta">
        {ago(d.updatedAt)}
        {lead && sizeOf(d) && ` · ${sizeOf(d)}`}
      </span>
      <button type="button" className="btn ghost small design-tile-more" aria-label={`More for ${d.name}`} onClick={(e) => designMenu(d, e.currentTarget.getBoundingClientRect())}>
        ⋯
      </button>
    </div>
  );
}

/**
 * Your designs, first on the page: the newest as a shelf to pick up from (the latest one
 * larger, marked Continue), and all of them, by folder, behind "All designs". A search
 * shows the ones it matches.
 */
function YourDesigns({ designs, query }: { designs: readonly Saved[]; query: string }) {
  const [all, setAll] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const folders = useMemo(() => [...new Set(designs.map((d) => d.folder))].filter(Boolean).sort((a, b) => a.localeCompare(b)), [designs]);
  const inFolder = folder !== null && folders.includes(folder) ? folder : null;
  const found = useMemo(() => (query ? designs.filter((d) => d.name.toLowerCase().includes(query) || d.folder.toLowerCase().includes(query)) : designs), [designs, query]);
  const shelf = !query && !all;
  const shown = shelf ? found.slice(0, SHELF) : inFolder === null ? found : found.filter((d) => d.folder === inFolder || d.folder.startsWith(`${inFolder}/`));
  // The shelf starts at its beginning again when a newer design takes the lead.
  const row = useRef<HTMLDivElement>(null);
  const lead = designs[0]?.id;
  useEffect(() => {
    row.current?.scrollTo({ left: 0 });
  }, [lead, shelf]);
  if (!found.length) return null;
  return (
    <section aria-labelledby="design-yours" className="design-yours">
      <div className="section-head">
        <h2 id="design-yours">
          Your designs <span className="count">{found.length}</span>
        </h2>
        {!query && designs.length > 1 && (
          <button type="button" className="btn ghost small" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show recent" : `All designs${designs.length > SHELF ? ` (${designs.length})` : ""}`}
          </button>
        )}
      </div>
      {!shelf && !query && folders.length > 0 && (
        <div className="chip-row" role="group" aria-label="Design folders">
          <button type="button" className="filter-chip" aria-pressed={inFolder === null} onClick={() => setFolder(null)}>
            All
          </button>
          {folders.map((f) => (
            <button key={f} type="button" className="filter-chip" aria-pressed={inFolder === f} onClick={() => setFolder(f)}>
              <Icon name="folders" size={12} /> {f}
            </button>
          ))}
        </div>
      )}
      <div ref={row} className={shelf ? "design-shelf" : "design-grid"}>
        {shown.map((d, i) => (
          <DesignTile key={d.id} d={d} lead={shelf && i === 0} />
        ))}
        {shelf && designs.length > SHELF && (
          <button type="button" className="design-all" onClick={() => setAll(true)}>
            All {designs.length} designs
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The Design workspace's start. What you made comes first (to pick up where you left off),
 * then sizes to begin something new from, then templates.
 */
export function DesignHome({ templates }: { templates?: (query: string) => React.ReactNode }) {
  const [group, setGroup] = useState<SizeGroup | "All">("Social");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const sizes = SIZE_PRESETS.filter((p) => (q ? [p.label, ...(p.tags ?? [])].some((t) => t.toLowerCase().includes(q)) : group === "All" || p.group === group));
  const documents = useStore(composite, (s) => s.documents);
  const designs = useMemo(() => documents.filter((d) => d.design), [documents]);
  useEffect(() => {
    void refreshDocumentList();
  }, []);
  return (
    <div className="design-home">
      <header className="design-home-head">
        <h1>Design</h1>
        <p className="faint">{designs.length ? "Pick up where you left off, or start something new." : "Posters, posts, stories, wallpapers, flyers, cards and logos, made from your photos. What you make is kept here."}</p>
        <input className="input design-search" type="search" placeholder={designs.length ? "Search your designs, sizes and templates" : "Search sizes and templates (story, flyer, wallpaper…)"} value={query} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setQuery(e.target.value)} aria-label="Search your designs, sizes and templates" />
      </header>
      <YourDesigns designs={designs} query={q} />
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
    </div>
  );
}
