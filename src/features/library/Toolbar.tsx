import { CompactActions, TopAction } from "@/app/Shell";
import { SelectButton } from "@/app/SelectBar";
import { photoScope } from "./commands";
import { useStore } from "@/app/hooks";
import { type LibraryView, setFilter, setQuery, targetIds, ui } from "@/app/state";
import { openExport } from "@/features/export/host";
import { openLooks } from "@/features/looks/LooksDialog";
import type { SortKey } from "@/core/catalog/query";
import type { ColorLabel, FileKind } from "@/core/catalog/types";

const views: { id: LibraryView; label: string; key: string }[] = [
  { id: "grid", label: "Grid", key: "G" },
  { id: "loupe", label: "Loupe", key: "E" },
  { id: "compare", label: "Compare", key: "Shift+C" },
  { id: "survey", label: "Survey", key: "N" },
];

const sorts: { id: SortKey; label: string }[] = [
  { id: "captureTime", label: "Capture time" },
  { id: "importedAt", label: "Import order" },
  { id: "fileName", label: "File name" },
  { id: "rating", label: "Rating" },
  { id: "camera", label: "Camera" },
  { id: "byteSize", label: "File size" },
  { id: "edited", label: "Edited" },
];

const labels: Exclude<ColorLabel, null>[] = ["red", "yellow", "green", "blue", "purple"];
const kinds: { id: FileKind; label: string }[] = [
  { id: "raw", label: "RAW" },
  { id: "jpeg", label: "JPEG" },
  { id: "heic", label: "HEIC" },
  { id: "tiff", label: "TIFF" },
  { id: "png", label: "PNG" },
  { id: "webp", label: "WebP" },
];

export function LibraryToolbar({ count, total }: { count: number; total: number }) {
  const view = useStore(ui, (s) => s.libraryView);
  const query = useStore(ui, (s) => s.query);
  const thumbSize = useStore(ui, (s) => s.thumbSize);
  const f = query.filter;
  const filtered = count !== total;
  return (
    <div className="toolbar" role="toolbar" aria-label="Library view">
      <div className="segmented" role="group" aria-label="View">
        {views.map((v) => (
          <button key={v.id} type="button" aria-pressed={view === v.id} title={`${v.label} (${v.key})`} onClick={() => ui.setState({ libraryView: v.id })}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="filterbar">
        <input
          className="input"
          type="search"
          placeholder="Search name, keyword, camera…"
          aria-label="Search photos"
          value={f.text}
          onChange={(e) => setFilter({ text: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ width: 200 }}
        />
        <label className="row" title="Rating filter">
          <select
            className="input"
            aria-label="Rating comparison"
            value={f.ratingOp}
            onChange={(e) => setFilter({ ratingOp: e.target.value as typeof f.ratingOp })}
          >
            <option value=">=">≥</option>
            <option value="=">=</option>
            <option value="<=">≤</option>
          </select>
          <select
            className="input"
            aria-label="Rating"
            value={f.minRating}
            onChange={(e) => setFilter({ minRating: Number(e.target.value) })}
          >
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <option key={r} value={r}>
                {r === 0 ? "Any ★" : "★".repeat(r)}
              </option>
            ))}
          </select>
        </label>
        <select className="input" aria-label="Flag filter" value={f.flag} onChange={(e) => setFilter({ flag: e.target.value as typeof f.flag })}>
          <option value="all">All flags</option>
          <option value="pick">Picked</option>
          <option value="unflagged">Unflagged</option>
          <option value="not-rejected">Not rejected</option>
          <option value="reject">Rejected</option>
        </select>
        <div className="row" role="group" aria-label="Color label filter">
          {labels.map((l) => {
            const on = f.labels.includes(l);
            return (
              <button
                key={l}
                type="button"
                className="btn ghost small icon"
                aria-pressed={on}
                title={`${l[0].toUpperCase()}${l.slice(1)} label`}
                onClick={() => setFilter({ labels: on ? f.labels.filter((x) => x !== l) : [...f.labels, l] })}
              >
                <span className={`label-chip ${l}`} style={{ opacity: on || !f.labels.length ? 1 : 0.35 }} />
              </button>
            );
          })}
        </div>
        <select
          className="input"
          aria-label="File type filter"
          value={f.kinds[0] ?? ""}
          onChange={(e) => setFilter({ kinds: e.target.value ? [e.target.value as FileKind] : [] })}
        >
          <option value="">All types</option>
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Edited filter" value={f.edited} onChange={(e) => setFilter({ edited: e.target.value as typeof f.edited })}>
          <option value="all">Edited & unedited</option>
          <option value="edited">Edited</option>
          <option value="unedited">Unedited</option>
        </select>
      </div>
      <div className="spacer" />
      <span className="dim num">{filtered ? `${count} of ${total}` : `${total} photo${total === 1 ? "" : "s"}`}</span>
      <label className="row dim">
        Sort
        <select className="input" aria-label="Sort by" value={query.sort} onChange={(e) => setQuery({ sort: e.target.value as SortKey })}>
          {sorts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn small icon"
          title={query.descending ? "Descending" : "Ascending"}
          aria-label="Toggle sort direction"
          onClick={() => setQuery({ descending: !query.descending })}
        >
          {query.descending ? "↓" : "↑"}
        </button>
      </label>
      <label className="check dim" title="Show only the top photo of each stack">
        <input type="checkbox" checked={query.collapseStacks} onChange={(e) => setQuery({ collapseStacks: e.target.checked })} />
        Stacks
      </label>
      <button type="button" className="btn small" title="Save and apply looks: develop settings, masks and effect layers" onClick={() => openLooks({ kind: "library", ids: targetIds() })}>
        Looks…
      </button>
      <button type="button" className="btn small primary wide-only" title="Export the selected photos (Ctrl+Shift+E)" onClick={() => openExport(targetIds())}>
        Export…
      </button>
      <CompactActions>
        <SelectButton scope={photoScope} icon />
        <TopAction icon="export" label="Export" title="Export the selected photos" primary onClick={() => openExport(targetIds())} />
      </CompactActions>
      {view === "grid" && (
        <input
          type="range"
          aria-label="Thumbnail size"
          min={110}
          max={360}
          value={thumbSize}
          onChange={(e) => ui.setState({ thumbSize: Number(e.target.value) })}
          style={{ width: 90, accentColor: "var(--text-dim)" }}
        />
      )}
    </div>
  );
}
