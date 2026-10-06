import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast, ui } from "@/app/state";
import { openMenu } from "@/components/Menu";
import { Icon } from "@/components/icons";
import { type DesignAsset, designAssets, loadDesignAssets, removeDesignAsset, updateDesignAsset } from "@/core/design/assets";
import { importPhotosFromDevice } from "@/features/composite/actions";
import { collageFromPhotos, startMyTemplate, startTemplate } from "./actions";
import { sizeLabel } from "./presets";
import { LayerSketch } from "./preview";
import { matchesTemplate, type Template, TEMPLATE_CATEGORIES, type TemplateCategory, TEMPLATES } from "./templates";

/** Template previews, drawn once each. */
const previews = new Map<string, React.ReactNode>();
function TemplatePreview({ t }: { t: Template }) {
  let node = previews.get(t.id);
  if (!node) {
    node = <LayerSketch className="template-sketch" width={t.width} height={t.height} background={t.background ?? "#ffffff"} layers={t.build({ width: t.width, height: t.height })} />;
    previews.set(t.id, node);
  }
  return node;
}

function TemplateCard({ t }: { t: Template }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="template-card"
      aria-busy={busy}
      title={`${t.name}, ${sizeLabel(t.width, t.height)}`}
      onClick={async () => {
        setBusy(true);
        try {
          await startTemplate(t);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="template-thumb" style={{ aspectRatio: `${t.width} / ${t.height}` }}>
        <TemplatePreview t={t} />
      </span>
      <span className="template-name">{t.name}</span>
    </button>
  );
}

/** Starts a collage from photos (the Library selection or this device). */
function CollageCard() {
  const selected = useStore(ui, (s) => s.selection.size);
  return (
    <button
      type="button"
      className="template-card collage-start"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom + 4, [
          {
            label: selected ? `Library selection (${selected} photo${selected === 1 ? "" : "s"})` : "Library selection (select photos first)",
            disabled: !selected,
            onSelect: () => collageFromPhotos([...ui.getState().selection]),
          },
          {
            label: "Photos from this device…",
            onSelect: async () => {
              const ids = await importPhotosFromDevice();
              if (ids.length) collageFromPhotos(ids);
            },
          },
        ]);
      }}
    >
      <span className="template-thumb collage-plus" style={{ aspectRatio: "1" }}>
        <Icon name="grid" size={30} />
      </span>
      <span className="template-name">Collage from your photos</span>
    </button>
  );
}

function MyTemplateCard({ asset }: { asset: DesignAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.thumb) return;
    const u = URL.createObjectURL(asset.thumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [asset.thumb]);
  return (
    <div className="template-card mine">
      <button type="button" className="template-thumb" onClick={() => startMyTemplate(asset)} aria-label={`Use ${asset.name}`}>
        {url ? <img src={url} alt="" /> : <Icon name="design" size={28} />}
      </button>
      <span className="template-name">
        {asset.name}
        {asset.folder && <span className="faint"> · {asset.folder}</span>}
      </span>
      <button
        type="button"
        className="btn ghost small design-tile-more"
        aria-label={`More for ${asset.name}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom + 4, [
            { label: "Use", onSelect: () => startMyTemplate(asset) },
            {
              label: "Rename…",
              onSelect: () => {
                const name = prompt("Template name", asset.name);
                if (name) void updateDesignAsset(asset.id, { name });
              },
            },
            {
              label: "Move to folder…",
              onSelect: () => {
                const folder = prompt("Folder (empty for none; use / for subfolders)", asset.folder);
                if (folder !== null) void updateDesignAsset(asset.id, { folder });
              },
            },
            "separator",
            { label: "Delete…", onSelect: () => confirm(`Delete the template “${asset.name}”?`) && void removeDesignAsset(asset.id).then(() => toast("Template deleted.")) },
          ]);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

/** Built-in templates by category (or search) and my templates. */
export function TemplatesSection({ query }: { query: string }) {
  const [category, setCategory] = useState<TemplateCategory | "All" | "Mine">("All");
  const items = useStore(designAssets, (s) => s.items);
  const mine = useMemo(() => items.filter((a) => a.kind === "template"), [items]);
  useEffect(() => {
    void loadDesignAssets();
  }, []);
  const q = query.trim().toLowerCase();
  const shown = q ? TEMPLATES.filter((t) => matchesTemplate(t, q)) : category === "All" ? TEMPLATES : category === "Mine" ? [] : TEMPLATES.filter((t) => t.category === category);
  const myShown = q ? mine.filter((a) => a.name.toLowerCase().includes(q) || a.folder.toLowerCase().includes(q)) : category === "Mine" || category === "All" ? mine : [];
  return (
    <section aria-labelledby="design-templates">
      <h2 id="design-templates">Templates</h2>
      {!q && (
        <div className="chip-row" role="group" aria-label="Template categories">
          {(["All", ...(mine.length ? (["Mine"] as const) : []), ...TEMPLATE_CATEGORIES] as const).map((c) => (
            <button key={c} type="button" className="filter-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c === "Mine" ? "My templates" : c}
            </button>
          ))}
        </div>
      )}
      <div className="template-grid">
        {myShown.map((a) => (
          <MyTemplateCard key={a.id} asset={a} />
        ))}
        {!q && (category === "Collages" || category === "All") && <CollageCard />}
        {shown.map((t) => (
          <TemplateCard key={t.id} t={t} />
        ))}
        {q && !shown.length && !myShown.length && <p className="faint">No template matches “{query}”.</p>}
      </div>
    </section>
  );
}
