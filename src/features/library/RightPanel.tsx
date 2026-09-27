import { useState } from "react";
import { useStore } from "@/app/hooks";
import { targetIds, ui } from "@/app/state";
import { Panel } from "@/components/Panel";
import { addKeywords, allKeywords, catalog, removeKeyword, setFlag, setLabel, setRating, updateAssets } from "@/core/catalog/store";
import type { Asset, ColorLabel } from "@/core/catalog/types";
import { formatBytes, formatDate, formatExposure } from "./format";

const labels: Exclude<ColorLabel, null>[] = ["red", "yellow", "green", "blue", "purple"];

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="star-input" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} data-on={n <= value} onClick={() => onChange(value === n ? 0 : n)}>
          ★
        </button>
      ))}
    </span>
  );
}

export function RatingControls({ assets }: { assets: Asset[] }) {
  const ids = assets.map((a) => a.id);
  const first = assets[0];
  const mixed = (f: (a: Asset) => unknown) => assets.some((a) => f(a) !== f(first));
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <StarInput value={mixed((a) => a.rating) ? 0 : first.rating} onChange={(r) => setRating(ids, r)} />
        <span className="spacer" />
        <button type="button" className="btn small" aria-pressed={!mixed((a) => a.flag) && first.flag === "pick"} onClick={() => setFlag(ids, first.flag === "pick" ? null : "pick")}>
          Pick
        </button>
        <button type="button" className="btn small" aria-pressed={!mixed((a) => a.flag) && first.flag === "reject"} onClick={() => setFlag(ids, first.flag === "reject" ? null : "reject")}>
          Reject
        </button>
      </div>
      <div className="row" role="group" aria-label="Color label">
        {labels.map((l) => (
          <button key={l} type="button" className="btn ghost small icon" aria-pressed={!mixed((a) => a.label) && first.label === l} title={l} onClick={() => setLabel(ids, l)}>
            <span className={`label-chip ${l}`} />
          </button>
        ))}
      </div>
    </>
  );
}

function Keywords({ assets }: { assets: Asset[] }) {
  const [text, setText] = useState("");
  const ids = assets.map((a) => a.id);
  const shared = assets[0].keywords.filter((k) => assets.every((a) => a.keywords.includes(k)));
  const partial = [...new Set(assets.flatMap((a) => a.keywords))].filter((k) => !shared.includes(k));
  const suggestions = text.length > 0 ? allKeywords().filter(([k]) => k.toLowerCase().startsWith(text.toLowerCase()) && !shared.includes(k)).slice(0, 6) : [];
  const add = (value: string) => {
    addKeywords(ids, value.split(","));
    setText("");
  };
  return (
    <>
      <div className="keyword-chips">
        {shared.map((k) => (
          <span key={k} className="chip">
            {k}
            <button type="button" aria-label={`Remove keyword ${k}`} onClick={() => removeKeyword(ids, k)}>
              ✕
            </button>
          </span>
        ))}
        {partial.map((k) => (
          <span key={k} className="chip" style={{ opacity: 0.6 }} title="On some of the selected photos">
            {k}*
            <button type="button" aria-label={`Remove keyword ${k}`} onClick={() => removeKeyword(ids, k)}>
              ✕
            </button>
          </span>
        ))}
        {!shared.length && !partial.length && <span className="faint">No keywords.</span>}
      </div>
      <input
        className="input"
        style={{ width: "100%" }}
        placeholder="Add keywords, comma separated"
        aria-label="Add keywords"
        value={text}
        list="keyword-suggestions"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && text.trim()) add(text);
        }}
      />
      <datalist id="keyword-suggestions">
        {suggestions.map(([k]) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </>
  );
}

function TextField({ assets, field, label }: { assets: Asset[]; field: "title" | "caption"; label: string }) {
  const value = assets.every((a) => a[field] === assets[0][field]) ? (assets[0][field] ?? "") : "";
  const [draft, setDraft] = useState<string | null>(null);
  const ids = assets.map((a) => a.id);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        value={draft ?? value}
        placeholder={assets.length > 1 && !value ? "Mixed" : ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) updateAssets(ids, () => ({ [field]: draft.trim() || undefined }));
          setDraft(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function ExifTable({ asset }: { asset: Asset }) {
  const e = asset.exif;
  const rows: [string, string | undefined][] = [
    ["File", asset.fileName],
    ["Folder", asset.folder || undefined],
    ["Stored", asset.original.kind === "stored" ? "Copied into library" : `Referenced: ${asset.original.path}`],
    ["Size", `${formatBytes(asset.byteSize)}`],
    ["Dimensions", asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined],
    ["Captured", formatDate(asset.captureTime)],
    ["Camera", [e.make, e.model].filter(Boolean).join(" ") || undefined],
    ["Lens", e.lens],
    ["Exposure", e.exposureTime ? `${formatExposure(e.exposureTime)} s` : undefined],
    ["Aperture", e.fNumber ? `ƒ/${e.fNumber}` : undefined],
    ["ISO", e.iso ? String(e.iso) : undefined],
    ["Focal length", e.focalLength ? `${Math.round(e.focalLength * 10) / 10} mm${e.focalLength35 ? ` (${e.focalLength35} mm eq.)` : ""}` : undefined],
    ["Exp. bias", e.exposureBias !== undefined ? `${e.exposureBias > 0 ? "+" : ""}${Math.round(e.exposureBias * 100) / 100} EV` : undefined],
    ["Flash", e.flash],
    ["Metering", e.meteringMode],
    ["White bal.", e.whiteBalance],
    ["Color space", e.iccProfile ?? e.colorSpace],
    ["Location", e.latitude !== undefined && e.longitude !== undefined ? `${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}` : undefined],
    ["Altitude", e.altitude !== undefined ? `${Math.round(e.altitude)} m` : undefined],
    ["Software", e.software],
    ["Artist", e.artist],
    ["Copyright", e.copyright],
    ["Imported", formatDate(asset.importedAt)],
  ];
  return (
    <dl className="meta-grid">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      {e.latitude !== undefined && e.longitude !== undefined && (
        <>
          <dt />
          <dd>
            <a href={`https://www.openstreetmap.org/?mlat=${e.latitude}&mlon=${e.longitude}#map=15/${e.latitude}/${e.longitude}`} target="_blank" rel="noreferrer" style={{ color: "var(--focus)" }}>
              Open in map ↗
            </a>
          </dd>
        </>
      )}
      {asset.error && (
        <>
          <dt>Note</dt>
          <dd style={{ color: "var(--danger)" }}>{asset.error}</dd>
        </>
      )}
    </dl>
  );
}

export function LibraryRightPanel() {
  const selection = useStore(ui, (s) => s.selection);
  const activeId = useStore(ui, (s) => s.activeId);
  const assetsMap = useStore(catalog, (s) => s.assets);
  const ids = selection.size ? [...selection] : activeId ? [activeId] : [];
  const assets = ids.map((id) => assetsMap.get(id)).filter((a): a is Asset => !!a);
  const active = (activeId && assetsMap.get(activeId)) || assets[0];
  if (!assets.length || !active) {
    return (
      <Panel id="lib-info" title="Metadata">
        <p className="faint">Select a photo to see its metadata.</p>
      </Panel>
    );
  }
  return (
    <>
      <Panel id="lib-rating" title={assets.length > 1 ? `${assets.length} Selected` : "Rating & Labels"}>
        <RatingControls assets={assets} />
      </Panel>
      <Panel id="lib-keywords" title="Keywording">
        <Keywords assets={assets} key={targetIds().join()} />
      </Panel>
      <Panel id="lib-text" title="Title & Caption" defaultOpen={false}>
        <TextField assets={assets} field="title" label="Title" key={`t${ids.join()}`} />
        <TextField assets={assets} field="caption" label="Caption" key={`c${ids.join()}`} />
      </Panel>
      <Panel id="lib-exif" title="EXIF">
        <ExifTable asset={active} />
      </Panel>
    </>
  );
}
