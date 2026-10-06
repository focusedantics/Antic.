import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast, ui } from "@/app/state";
import { Dialog, openMenu } from "@/components/Menu";
import { Icon } from "@/components/icons";
import { getThumb } from "@/core/catalog/db";
import { assetData, type DesignAsset, type DesignAssetKind, designAssets, type ElementData, type FontData, type GradientData, loadDesignAssets, type PaletteData, removeDesignAsset, saveDesignAsset, updateDesignAsset } from "@/core/design/assets";
import { exportBundle, importBundle } from "@/core/design/bundle";
import { forgetTip } from "@/core/document/brush-tips";
import { composite, moveDocumentToFolder, refreshDocumentList, removeStoredDocument } from "@/core/document/session";
import { forgetFont, importFonts, loadCustomFonts } from "@/core/text/custom-fonts";
import { FONTS } from "@/core/text/fonts";
import { ColorField } from "@/features/color/ColorField";
import { paletteFromBlob } from "@/features/color/extract";
import { readPaletteFile, writeAse, writeGpl, writeHexList, writeJson } from "@/features/color/formats";
import { chooseFiles, downloadBlob, pickerAccept } from "@/lib/files";
import { duplicateDesign, openDesign, startMyTemplate } from "./actions";
import { LayerSketch } from "./preview";

/**
 * Everything a designer keeps, in folders: designs, templates, elements, palettes,
 * gradients, brushes and fonts. Rename, file in folders, duplicate, delete, import and
 * export (`.focusedkit`; palettes also as GIMP, Adobe swatch, JSON or hex files).
 */
type Tab = "designs" | DesignAssetKind;
const TABS: { id: Tab; label: string }[] = [
  { id: "designs", label: "Designs" },
  { id: "template", label: "Templates" },
  { id: "element", label: "Elements" },
  { id: "palette", label: "Palettes" },
  { id: "gradient", label: "Gradients" },
  { id: "brush", label: "Brushes" },
  { id: "font", label: "Fonts" },
];

type Item = { id: string; name: string; folder: string; asset?: DesignAsset };

const askFolder = (current: string) => prompt("Folder (empty for none; use / for subfolders)", current);

export function ManagerDialog({ onClose, initialTab = "designs" }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [folder, setFolder] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const assets = useStore(designAssets, (s) => s.items);
  const documents = useStore(composite, (s) => s.documents);
  useEffect(() => {
    void loadDesignAssets();
    void refreshDocumentList();
  }, []);
  useEffect(() => {
    setFolder(null);
    setPicked(new Set());
    setEditing(null);
  }, [tab]);
  const items: Item[] = useMemo(
    () => (tab === "designs" ? documents.filter((d) => d.design).map((d) => ({ id: d.id, name: d.name, folder: d.folder })) : assets.filter((a) => a.kind === tab).map((a) => ({ id: a.id, name: a.name, folder: a.folder, asset: a }))),
    [tab, assets, documents],
  );
  const folders = useMemo(() => [...new Set(items.map((i) => i.folder))].filter(Boolean).sort((a, b) => a.localeCompare(b)), [items]);
  const shown = folder === null ? items : items.filter((i) => i.folder === folder || i.folder.startsWith(`${folder}/`));
  const chosen = items.filter((i) => picked.has(i.id));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const moveTo = async (targets: Item[]) => {
    const f = askFolder(targets[0]?.folder ?? "");
    if (f === null) return;
    for (const t of targets) await (tab === "designs" ? moveDocumentToFolder(t.id, f) : updateDesignAsset(t.id, { folder: f }));
    setPicked(new Set());
  };
  const remove = async (targets: Item[]) => {
    if (!confirm(`Delete ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`}? This can't be undone.`)) return;
    for (const t of targets) {
      if (tab === "designs") await removeStoredDocument(t.id);
      else {
        await removeDesignAsset(t.id);
        if (tab === "font") forgetFont(t.id);
        if (tab === "brush") forgetTip(t.id);
      }
    }
    setPicked(new Set());
  };
  const duplicate = async (targets: Item[]) => {
    for (const t of targets) {
      if (tab === "designs") await duplicateDesign(t.id);
      else if (t.asset) await saveDesignAsset(t.asset.kind, `${t.name} copy`, t.asset.data, { folder: t.folder, thumb: t.asset.thumb });
    }
    if (tab === "designs") onClose();
  };
  const rename = async (t: Item) => {
    const name = prompt("Name", t.name);
    if (!name) return;
    if (tab === "designs") {
      const { getDocument, putDocument } = await import("@/core/catalog/db");
      const record = await getDocument(t.id);
      if (record) await putDocument({ ...record, name, data: { ...(record.data as object), name } });
      await refreshDocumentList();
    } else await updateDesignAsset(t.id, { name });
  };
  const exportKit = async (targets: Item[]) => {
    const list = targets.flatMap((t) => (t.asset ? [t.asset] : []));
    if (!list.length) return;
    downloadBlob(await exportBundle(list), `${list.length === 1 ? list[0].name : "Focused kit"}.focusedkit`);
  };

  const importInto = async () => {
    const target = folder ?? "";
    if (tab === "font") {
      const files = await chooseFiles({ multiple: true, accept: pickerAccept(".ttf,.otf,.woff,.woff2", {}) });
      if (!files.length) return;
      try {
        const added = await importFonts(files, FONTS.map((f) => f.label));
        if (target) for (const f of added) await updateDesignAsset(f.id, { folder: target });
        toast(`Added ${added.length} font${added.length === 1 ? "" : "s"}.`);
      } catch (error) {
        toast(error instanceof Error ? error.message : "That font could not be read.", "error");
      }
      return;
    }
    const palettes = tab === "palette";
    const files = await chooseFiles({ multiple: true, accept: pickerAccept(palettes ? ".focusedkit,.gpl,.ase,.json,.txt,.hex,application/zip" : ".focusedkit,application/zip", {}) });
    let added = 0;
    for (const file of files) {
      try {
        if (file.name.toLowerCase().endsWith(".focusedkit") || file.type === "application/zip") added += await importBundle(file, target);
        else {
          const p = await readPaletteFile(file);
          await saveDesignAsset("palette", p.name, { colors: p.colors }, { folder: target });
          added++;
        }
      } catch (error) {
        toast(`${file.name}: ${error instanceof Error ? error.message : "could not be read"}`, "error");
      }
    }
    if (added) {
      toast(`Imported ${added} item${added === 1 ? "" : "s"}.`);
      await loadCustomFonts(true);
    }
  };

  const newPalette = async (colors: string[], name = "My palette") => {
    const a = await saveDesignAsset("palette", name, { colors }, { folder: folder ?? "" });
    setEditing(a.id);
  };
  const paletteFromPhoto = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const selected = [...ui.getState().selection];
    openMenu(r.left, r.bottom + 4, [
      {
        label: "A photo on this device…",
        onSelect: async () => {
          const [file] = await chooseFiles({ accept: pickerAccept("image/*", { images: true }) });
          if (file) await newPalette(await paletteFromBlob(file, 6), file.name.replace(/\.[^.]+$/, ""));
        },
      },
      {
        label: selected.length ? "The selected Library photo" : "The selected Library photo (select one first)",
        disabled: !selected.length,
        onSelect: async () => {
          const t = await getThumb(selected[0]);
          const blob = t?.preview ?? t?.thumb;
          if (blob) await newPalette(await paletteFromBlob(blob, 6), "From photo");
          else toast("That photo has no preview yet.", "error");
        },
      },
    ]);
  };

  return (
    <Dialog
      title="Your things"
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="manager">
        <div className="chip-row" role="tablist" aria-label="Kinds">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="filter-chip" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="manager-bar">
          <div className="chip-row" role="group" aria-label="Folders">
            <button type="button" className="filter-chip" aria-pressed={folder === null} onClick={() => setFolder(null)}>
              All
            </button>
            {folders.map((f) => (
              <button key={f} type="button" className="filter-chip" aria-pressed={folder === f} onClick={() => setFolder(f)}>
                <Icon name="folders" size={12} /> {f}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {tab === "palette" && (
            <>
              <button type="button" className="btn small" onClick={() => void newPalette(["#111111", "#ffffff"])}>
                New palette
              </button>
              <button type="button" className="btn small" onClick={paletteFromPhoto}>
                From a photo…
              </button>
            </>
          )}
          {tab !== "designs" && (
            <button type="button" className="btn small" onClick={() => void importInto()}>
              Import…
            </button>
          )}
        </div>
        {chosen.length > 0 && (
          <div className="manager-bar selection">
            <span>{chosen.length} selected</span>
            <button type="button" className="btn small" onClick={() => void moveTo(chosen)}>
              Move to folder…
            </button>
            <button type="button" className="btn small" onClick={() => void duplicate(chosen)}>
              Duplicate
            </button>
            {tab !== "designs" && (
              <button type="button" className="btn small" onClick={() => void exportKit(chosen)}>
                Export…
              </button>
            )}
            <button type="button" className="btn small" onClick={() => void remove(chosen)}>
              Delete…
            </button>
            <button type="button" className="btn ghost small" onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </div>
        )}
        {!shown.length ? (
          <p className="faint">{emptyNote(tab)}</p>
        ) : (
          <div className="manager-grid">
            {shown.map((item) => (
              <div key={item.id} className="manager-item" data-picked={picked.has(item.id) || undefined}>
                <label className="manager-check">
                  <input type="checkbox" checked={picked.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${item.name}`} />
                </label>
                <button
                  type="button"
                  className="manager-preview"
                  aria-label={`Open ${item.name}`}
                  onClick={() => {
                    if (tab === "designs") {
                      void openDesign(item.id);
                      onClose();
                    } else if (tab === "template" && item.asset) {
                      startMyTemplate(item.asset);
                      onClose();
                    } else if (tab === "palette") setEditing(editing === item.id ? null : item.id);
                    else toggle(item.id);
                  }}
                >
                  <Preview tab={tab} item={item} />
                </button>
                <span className="manager-name" title={item.folder ? `${item.folder}/${item.name}` : item.name}>
                  {item.name}
                </span>
                <button
                  type="button"
                  className="btn ghost small manager-more"
                  aria-label={`More for ${item.name}`}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu(r.left, r.bottom + 4, [
                      { label: "Rename…", onSelect: () => void rename(item) },
                      { label: "Move to folder…", onSelect: () => void moveTo([item]) },
                      { label: "Duplicate", onSelect: () => void duplicate([item]) },
                      ...(tab !== "designs" ? [{ label: "Export as kit…", onSelect: () => void exportKit([item]) }] : []),
                      ...(tab === "palette" && item.asset ? paletteExports(item.asset) : []),
                      "separator" as const,
                      { label: "Delete…", onSelect: () => void remove([item]) },
                    ]);
                  }}
                >
                  ⋯
                </button>
                {tab === "palette" && editing === item.id && item.asset && <PaletteEditor asset={item.asset} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const emptyNote = (tab: Tab) =>
  ({
    designs: "Designs you make appear here.",
    template: "Save a design as a template from its More menu.",
    element: "Select layers in a design, then More → Save selection as element.",
    palette: "Make a palette, take one from a photo, or import GIMP, Adobe swatch, JSON or hex files.",
    gradient: "Save a gradient from any gradient editor.",
    brush: "Make a brush from an image in the drawing options (+ Brush).",
    font: "Import TTF, OTF, WOFF or WOFF2 files; they stay on this device.",
  })[tab];

function paletteExports(asset: DesignAsset) {
  const data = assetData(asset) as PaletteData | null;
  if (!data) return [];
  const p = { name: asset.name, colors: [...data.colors] };
  const text = (s: string, type: string) => new Blob([s], { type });
  return [
    { label: "Export as GIMP palette (.gpl)", onSelect: () => downloadBlob(text(writeGpl(p), "text/plain"), `${asset.name}.gpl`) },
    { label: "Export as Adobe swatches (.ase)", onSelect: () => downloadBlob(new Blob([writeAse(p) as BlobPart], { type: "application/octet-stream" }), `${asset.name}.ase`) },
    { label: "Export as JSON", onSelect: () => downloadBlob(text(writeJson(p), "application/json"), `${asset.name}.json`) },
    { label: "Export as hex list (.txt)", onSelect: () => downloadBlob(text(writeHexList(p), "text/plain"), `${asset.name}.txt`) },
  ];
}

/** A palette's colours: remove one, or add one with the picker. */
function PaletteEditor({ asset }: { asset: DesignAsset }) {
  const data = assetData(asset) as PaletteData | null;
  const [adding, setAdding] = useState("#d9a441");
  if (!data) return null;
  const save = (colors: string[]) => void saveDesignAsset("palette", asset.name, { colors }, { id: asset.id });
  return (
    <div className="palette-editor">
      {data.colors.map((c, i) => (
        <span key={`${c}-${i}`} className="palette-chip" style={{ background: c }} title={c}>
          <button type="button" aria-label={`Remove ${c}`} onClick={() => save(data.colors.filter((_, k) => k !== i))}>
            ×
          </button>
        </span>
      ))}
      <ColorField label="New colour" value={adding} onChange={setAdding} />
      <button type="button" className="btn small" onClick={() => !data.colors.includes(adding) && save([...data.colors, adding])}>
        Add
      </button>
    </div>
  );
}

function Preview({ tab, item }: { tab: Tab; item: Item }) {
  const a = item.asset;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let blob: Blob | undefined;
    let live = true;
    const show = (b: Blob | undefined) => {
      if (!b || !live) return;
      const u = URL.createObjectURL(b);
      setUrl(u);
      blob = b;
    };
    if (tab === "designs") void import("@/core/catalog/db").then(({ getDocument }) => getDocument(item.id)).then((r) => show(r?.thumb));
    else if (a?.thumb) show(a.thumb);
    else if (tab === "brush") show((a?.data as { tip?: Blob })?.tip);
    return () => {
      live = false;
      if (blob) setUrl((u) => (u && URL.revokeObjectURL(u), null));
    };
  }, [tab, item.id, a]);
  if (url) return <img src={url} alt="" className={tab === "brush" ? "tip-preview" : undefined} />;
  if (!a) return <Icon name="design" size={26} />;
  const data = assetData(a);
  switch (tab) {
    case "element": {
      const d = data as ElementData;
      return <LayerSketch className="element-sketch" width={d.width} height={d.height} layers={d.layers} />;
    }
    case "palette":
      return (
        <span className="palette-strip">
          {(data as PaletteData).colors.slice(0, 12).map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </span>
      );
    case "gradient": {
      const g = (data as GradientData).gradient;
      return <span className="gradient-strip" style={{ background: `linear-gradient(90deg, ${g.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(", ")})` }} />;
    }
    case "font":
      return <span className="font-sample" style={{ fontFamily: `'${(data as FontData).family}', sans-serif` }}>Aa Bb 123</span>;
    default:
      return <Icon name="design" size={26} />;
  }
}
