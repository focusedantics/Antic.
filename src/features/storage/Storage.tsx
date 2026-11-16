import { type ComponentType, useEffect, useState } from "react";
import { useStore } from "@/app/hooks";
import type { ShellProps } from "@/app/Shell";
import { setQuery, setWorkspace, selectAsset, toast } from "@/app/state";
import { Panel } from "@/components/Panel";
import { importProgress } from "@/core/catalog/import";
import { type BigItem, formatBytes, type Usage, type UsageId } from "@/core/catalog/usage";
import { engineRef } from "@/core/gpu/events";
import { ago } from "@/lib/ago";
import { askToKeep, clearLeftovers, clearModels, measure, storage } from "./state";
import "@/styles/storage.css";

/** How each category is named and explained. The colours are the bar's and the list's. */
const KINDS: Record<UsageId, { name: string; unit: [string, string]; color: string; about: string }> = {
  originals: { name: "Original photos", unit: ["photo", "photos"], color: "#d9a441", about: "The files you imported, kept exactly as they were. Remove photos in Library to free this." },
  videos: { name: "Videos", unit: ["clip", "clips"], color: "#ff5a6e", about: "Clips imported into Video, with their edits. Remove clips in Video to free this." },
  previews: { name: "Previews", unit: ["preview", "previews"], color: "#3d9bff", about: "A large, quick-to-open picture of each photo, for the loupe, Compare and Survey." },
  thumbnails: { name: "Thumbnails", unit: ["thumbnail", "thumbnails"], color: "#2ec4b6", about: "The small pictures of the Library grid and the filmstrip." },
  designs: { name: "Designs", unit: ["design", "designs"], color: "#b8f03d", about: "What you made in Design: layers, text and a thumbnail each. Photos in them are counted once, above." },
  compositions: { name: "Compositions", unit: ["composition", "compositions"], color: "#9b5cff", about: "What you made in Composite." },
  masks: { name: "Masks and cutouts", unit: ["raster", "rasters"], color: "#ff8a3d", about: "Brushed and AI masks, removed backgrounds and painted layers, stored as pixels." },
  things: { name: "Your things", unit: ["item", "items"], color: "#ff6ad5", about: "Templates, elements, palettes, brushes and fonts you saved in Design." },
  models: { name: "AI models", unit: ["file", "files"], color: "#8fa3b8", about: "Downloaded the first time Remove Background, Select Sky or Select Object ran. Removing them is safe: each downloads again when next used." },
  records: { name: "Catalog", unit: ["record", "records"], color: "#6b7a8c", about: "Ratings, keywords, edits, presets, snapshots, collections and settings. Small, and the heart of the library." },
  leftover: { name: "Leftover files", unit: ["file", "files"], color: "#c0564b", about: "Files that nothing in the library refers to any more, such as from an import that was interrupted. Safe to clean up." },
};

const count = (n: number, [one, many]: [string, string]) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The rows as coloured segments of one bar, widest first as listed. */
function UsageBar({ usage }: { usage: Usage }) {
  const total = Math.max(1, usage.counted);
  return (
    <div className="usage-bar" role="img" aria-label={usage.rows.filter((r) => r.bytes > 0).map((r) => `${KINDS[r.id].name} ${formatBytes(r.bytes)}`).join(", ")}>
      {usage.rows
        .filter((r) => r.bytes > 0)
        .map((r) => (
          <span key={r.id} style={{ flexGrow: r.bytes / total, background: KINDS[r.id].color }} title={`${KINDS[r.id].name}: ${formatBytes(r.bytes)}`} />
        ))}
    </div>
  );
}

function Row({ usage, id, action }: { usage: Usage; id: UsageId; action?: React.ReactNode }) {
  const row = usage.rows.find((r) => r.id === id)!;
  const kind = KINDS[id];
  const share = usage.counted ? row.bytes / usage.counted : 0;
  return (
    <li className="usage-row" data-empty={row.bytes === 0 || undefined}>
      <span className="usage-dot" style={{ background: kind.color }} aria-hidden="true" />
      <div className="usage-what">
        <span className="usage-name">{kind.name}</span>
        <span className="usage-count">{row.count ? count(row.count, kind.unit) : "none"}</span>
        <p className="usage-about">
          {kind.about}
          {id === "originals" && usage.linked > 0 && ` ${usage.linked.toLocaleString()} more ${usage.linked === 1 ? "is" : "are"} read from folders on this computer and take${usage.linked === 1 ? "s" : ""} no space here.`}
        </p>
      </div>
      <div className="usage-size">
        <strong>{formatBytes(row.bytes)}</strong>
        <span className="usage-share" aria-hidden="true">
          <i style={{ width: `${Math.max(row.bytes ? 2 : 0, share * 100)}%`, background: kind.color }} />
        </span>
        {action}
      </div>
    </li>
  );
}

const KIND_LABEL: Record<BigItem["kind"], string> = { photo: "Photo", video: "Video", design: "Design", composition: "Composition" };

/** Takes you to one of the largest things, where it can be looked at and removed. */
async function show(item: BigItem) {
  if (item.kind === "photo") {
    setQuery({ source: { kind: "all" } });
    selectAsset(item.id);
    setWorkspace("library");
  } else if (item.kind === "video") {
    setWorkspace("video");
    void (await import("@/core/video/session")).openClip(item.id);
  } else if (item.kind === "design") {
    setWorkspace("design");
    void (await import("@/features/design/actions")).openDesign(item.id);
  } else {
    setWorkspace("composite");
    void (await import("@/core/document/session")).openStoredDocument(item.id);
  }
}

function StorageView() {
  const { usage, phase, stage, error, at } = useStore(storage, (s) => s);
  const importing = useStore(importProgress, (s) => s.active);
  const [confirming, setConfirming] = useState<"models" | "leftover" | null>(null);
  useEffect(() => {
    // Counted when the tab opens; kept for the session, so coming back is instant.
    if (!storage.getState().usage && storage.getState().phase === "idle") void measure();
  }, []);
  const working = phase === "working";
  const models = usage?.rows.find((r) => r.id === "models");
  const leftover = usage?.rows.find((r) => r.id === "leftover");
  // What the browser reports beyond what was counted: its own indexes, and space it has not yet reclaimed.
  const other = usage?.browser ? Math.max(0, usage.browser.usage - usage.counted) : 0;
  const total = usage ? Math.max(usage.counted, usage.browser?.usage ?? 0) : 0;
  return (
    <div className="storage-view">
      <header className="storage-head">
        <div>
          <h1>Storage</h1>
          <p className="faint">What Focused keeps on this device. Nothing here is uploaded anywhere.</p>
        </div>
        <button type="button" className="btn small" disabled={working} onClick={() => void measure()}>
          Measure again
        </button>
      </header>

      <section className="storage-total" aria-live="polite" data-phase={phase}>
        {usage ? (
          <>
            <p className="storage-figure">
              <strong>{formatBytes(total)}</strong> on this device
              {usage.browser && usage.browser.quota > 0 && (
                <span className="faint">
                  {" "}
                  of the {formatBytes(usage.browser.quota)} this browser allows the site ({Math.max(0.1, (total / usage.browser.quota) * 100).toFixed(1)}%)
                </span>
              )}
            </p>
            <UsageBar usage={usage} />
          </>
        ) : (
          <>
            <p className="storage-figure">
              <strong>Counting…</strong>
            </p>
            <div className="usage-bar" aria-hidden="true" />
          </>
        )}
        <p className="storage-status" data-phase={phase}>
          {working ? `Counting ${stage}…` : phase === "done" ? "Counted." : error ? `Could not count everything: ${error}` : usage ? `Counted ${ago(at)}.` : ""}
        </p>
      </section>

      {usage && (
        <>
          <ul className="usage-list" aria-label="Storage by category">
            {/* What takes the most comes first; what takes nothing goes last, in its usual order. */}
            {usage.rows
              .filter((r) => r.id !== "models" && r.id !== "leftover")
              .sort((x, y) => y.bytes - x.bytes)
              .map((r) => (
                <Row key={r.id} usage={usage} id={r.id} />
              ))}
            <Row
              usage={usage}
              id="models"
              action={
                models && models.bytes > 0 ? (
                  confirming === "models" ? (
                    <span className="usage-confirm">
                      <button type="button" className="btn small danger" disabled={working} onClick={() => (setConfirming(null), void clearModels().then(() => toast("AI models removed. They download again when next used.")))}>
                        Remove {formatBytes(models.bytes)}
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn small" disabled={working} onClick={() => setConfirming("models")}>
                      Remove…
                    </button>
                  )
                ) : undefined
              }
            />
            {leftover && leftover.bytes > 0 && (
              <Row
                usage={usage}
                id="leftover"
                action={
                  confirming === "leftover" ? (
                    <span className="usage-confirm">
                      <button type="button" className="btn small danger" disabled={working || importing} onClick={() => (setConfirming(null), void clearLeftovers().then(() => toast("Leftover files cleaned up.")))}>
                        Delete {formatBytes(leftover.bytes)}
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn small" disabled={working || importing} title={importing ? "Wait for the import to finish" : undefined} onClick={() => setConfirming("leftover")}>
                      Clean up…
                    </button>
                  )
                }
              />
            )}
            {other > usage.counted * 0.02 && other > 1e6 && (
              <li className="usage-row">
                <span className="usage-dot" style={{ background: "#3d3d3d" }} aria-hidden="true" />
                <div className="usage-what">
                  <span className="usage-name">Browser bookkeeping</span>
                  <p className="usage-about">The browser's own indexes, and space from deleted things it has not handed back yet. It shrinks by itself.</p>
                </div>
                <div className="usage-size">
                  <strong>{formatBytes(other)}</strong>
                </div>
              </li>
            )}
          </ul>

          {usage.largest.length > 0 && (
            <section aria-labelledby="storage-largest" className="storage-largest">
              <h2 id="storage-largest">Largest</h2>
              <ol>
                {usage.largest.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <span className="largest-name">{item.name}</span>
                    <span className="faint">{KIND_LABEL[item.kind]}</span>
                    <strong>{formatBytes(item.bytes)}</strong>
                    <button type="button" className="btn small ghost" onClick={() => void show(item)} aria-label={`Show ${item.name}`}>
                      Show
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Memory in use right now (not storage): what the graphics card and the page hold while you work. */
function useMemory() {
  const read = () => {
    const engine = engineRef.current?.stats() ?? null;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    return { engine, heap };
  };
  const [memory, setMemory] = useState(read);
  useEffect(() => {
    const timer = window.setInterval(() => !document.hidden && setMemory(read()), 2000);
    return () => clearInterval(timer);
  }, []);
  return [memory, () => setMemory(read())] as const;
}

function StorageSide() {
  const usage = useStore(storage, (s) => s.usage);
  const [memory, refresh] = useMemory();
  return (
    <>
      <Panel id="storage-safe" title="Kept safe?">
        {usage?.persisted ? (
          <p className="dim">Yes. The browser has promised not to clear Focused's data to make room for other sites.</p>
        ) : (
          <>
            <p className="dim">{usage?.persisted === false ? "Not yet: when the device runs low on space, a browser may clear a site's data by itself." : "Browsers may clear a site's data when the device runs low on space."}</p>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void askToKeep().then((kept) =>
                  toast(kept ? "The browser will keep Focused's data." : "The browser did not agree yet. It usually does once the site is used often, bookmarked or installed.", kept ? "info" : "error"),
                )
              }
            >
              Ask the browser to keep it
            </button>
          </>
        )}
        <p className="faint">Either way, exported photos and .focused project files are the copies to back up.</p>
      </Panel>
      <Panel id="storage-memory" title="Memory right now">
        <dl className="memory-list">
          <dt>Graphics card</dt>
          <dd>{memory.engine ? `${formatBytes(memory.engine.gpuBytes)} in ${memory.engine.textures} textures` : "Nothing yet"}</dd>
          <dt>Photos open</dt>
          <dd>{memory.engine ? memory.engine.sources : 0}</dd>
          {memory.heap !== null && (
            <>
              <dt>Page</dt>
              <dd>{formatBytes(memory.heap)}</dd>
            </>
          )}
        </dl>
        <button
          type="button"
          className="btn"
          disabled={!memory.engine}
          onClick={() => {
            engineRef.current?.freeMemory();
            refresh();
            toast("Working memory freed. Pictures are drawn again as you open them.");
          }}
        >
          Free working memory
        </button>
        <p className="faint">This is not storage: it is what editing holds while the page is open, and it empties when the tab closes.</p>
      </Panel>
      <Panel id="storage-about" title="About these numbers" defaultOpen={false}>
        <p className="dim">Browsers report one total for a site, so Focused counts its own stores. Photos, videos and pictures are exact; records are close.</p>
        <p className="dim">Photos imported with Import Folder stay where they are on this computer: only their previews and thumbnails are kept here.</p>
      </Panel>
    </>
  );
}

export default function StorageWorkspace({ Shell }: { Shell: ComponentType<ShellProps> }) {
  return <Shell left={<StorageSide />} center={<StorageView />} right={null} dock={[{ id: "storage-memory", label: "Memory & safety", icon: "info", side: "left" }]} />;
}
