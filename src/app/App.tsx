import { type DragEvent, lazy, Suspense, useEffect, useState } from "react";
import { ActivityBar } from "./ActivityBar";
import { MenuHost } from "@/components/Menu";
import { ExportHost } from "@/features/export/host";
import { LooksHost } from "@/features/looks/LooksDialog";
import { Backdrop } from "@/features/backdrop/Backdrop";
import { TopbarTools, TourHost } from "@/features/tour/TourHost";
import { importProgress, itemsFromDataTransfer } from "@/core/catalog/import";
import { catalog, loadCatalogIntoStore } from "@/core/catalog/store";
import { pulseActivity } from "@/lib/activity";
import { Filmstrip } from "@/features/library/Filmstrip";
import { LibraryCenter } from "@/features/library/Library";
import { LibraryLeftPanel } from "@/features/library/LeftPanel";
import { LibraryRightPanel } from "@/features/library/RightPanel";
import { importFolderInPlace, pickFiles, runImport } from "@/features/library/commands";
import { Icon } from "@/components/icons";
import { openMenu } from "@/components/Menu";
import { startTour } from "@/features/tour/tour";
import { useStore } from "./hooks";
import { actionsSlot, layout, openSheet } from "./layout";
import { PanelToggles, Shell } from "./Shell";
import { prefs, setPrefs } from "./prefs";
import { handleKey } from "./shortcuts";
import { setWorkspace, toast, ui, type Workspace } from "./state";

const DevelopWorkspace = lazy(() => import("@/features/develop/Develop"));
const CompositeWorkspace = lazy(() => import("@/features/composite/Composite"));
const VideoWorkspace = lazy(() => import("@/features/video/Video"));

const modules: { id: Workspace; label: string; key: string }[] = [
  { id: "library", label: "Library", key: "G" },
  { id: "develop", label: "Develop", key: "D" },
  { id: "composite", label: "Composite", key: "C" },
  { id: "video", label: "Video", key: "" },
];

function ImportStatus() {
  const p = useStore(importProgress, (s) => s);
  if (!p.active && !p.failed && !p.duplicates) return null;
  if (!p.active)
    return (
      <span className="progress-pill" title={p.errors.join("\n")}>
        Imported · {p.duplicates ? `${p.duplicates} duplicate${p.duplicates === 1 ? "" : "s"} skipped` : ""}
        {p.failed ? ` · ${p.failed} failed` : ""}
        <button type="button" className="btn ghost small" onClick={() => importProgress.setState({ failed: 0, duplicates: 0, errors: [] })}>
          ✕
        </button>
      </span>
    );
  return (
    <span className="progress-pill" role="status" aria-live="polite">
      Importing {p.done}/{p.total}
      <span className="progress-bar">
        <div style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
      </span>
    </span>
  );
}

function Toast() {
  const t = useStore(ui, (s) => s.toast);
  if (!t) return null;
  return (
    <div className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
      {t.text}
    </div>
  );
}

// Stable, so the slot is registered once rather than on every render.
const setActionsSlot = (element: HTMLDivElement | null) => actionsSlot.setState({ element });

/** A phone's top bar: the mark, the workspaces, and a menu for everything else. */
function CompactTopbar({ workspace }: { workspace: Workspace }) {
  const backdrop = useStore(prefs, (s) => s.backdrop);
  const showFilmstrip = useStore(prefs, (s) => s.showFilmstrip);
  return (
    <header className="topbar compact">
      <span className="brand-mark" aria-label="Focused" role="img" />
      {/* The workspaces fold into one switcher so the actions fit beside it. */}
      <button
        type="button"
        className="module workspace-switch"
        aria-label={`Workspace: ${modules.find((m) => m.id === workspace)?.label}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom + 4, modules.map((m) => ({ label: m.label, checked: m.id === workspace, onSelect: () => setWorkspace(m.id) })));
        }}
      >
        {modules.find((m) => m.id === workspace)?.label}
        <Icon name="chevron" size={14} />
      </button>
      <ImportStatus />
      <span className="spacer" />
      <div className="top-actions" ref={setActionsSlot} />
      <button
        type="button"
        className="tool-btn more"
        aria-label="More"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.right, r.bottom + 4, [
            { label: "Import Photos…", onSelect: () => pickFiles() },
            { label: "Import Folder…", onSelect: () => void importFolderInPlace() },
            "separator",
            ...(workspace !== "video" ? [{ label: showFilmstrip ? "Hide the filmstrip" : "Show the filmstrip", onSelect: () => setPrefs({ showFilmstrip: !showFilmstrip }) }] : []),
            { label: backdrop ? "Glow background: on" : "Glow background: off", onSelect: () => setPrefs({ backdrop: !backdrop }) },
            { label: "Replay the tour", onSelect: () => startTour(1) },
          ]);
        }}
      >
        <Icon name="more" />
      </button>
    </header>
  );
}

export function App() {
  const workspace = useStore(ui, (s) => s.workspace);
  const showFilmstrip = useStore(prefs, (s) => s.showFilmstrip);
  const backdrop = useStore(prefs, (s) => s.backdrop);
  const compact = useStore(layout, (s) => s.compact);
  // A phone's panel sheet belongs to the workspace it was opened in.
  useEffect(() => openSheet(null), [workspace]);
  // Dialogs and the effects browser render outside .app; they read the layout from the root.
  useEffect(() => {
    document.documentElement.dataset.compact = String(compact);
  }, [compact]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    loadCatalogIntoStore()
      .then(() => {
        // One-time background repair of thumbnails rendered with the old readback.
        setTimeout(() => void import("@/core/gpu/develop-engine").then((m) => m.developEngine().repairThumbnails()).catch(() => undefined), 4000);
      })
      .catch((error) => toast(`Could not open the library: ${error}`, "error"));
    window.addEventListener("keydown", handleKey);
    // Library edits (ratings, flags, keywords…) save instantly; give them a visible beat.
    const unsubscribe = catalog.subscribe((s, prev) => {
      if (s.assets !== prev.assets || s.collections !== prev.collections) pulseActivity();
    });
    return () => {
      window.removeEventListener("keydown", handleKey);
      unsubscribe();
    };
  }, []);

  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <div
      className="app"
      data-backdrop={backdrop ? "on" : "off"}
      data-compact={compact}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragging(false);
      }}
      onDrop={async (e) => {
        if (!isFileDrag(e) || e.defaultPrevented) return;
        e.preventDefault();
        setDragging(false);
        const items = await itemsFromDataTransfer(e.dataTransfer);
        if (items.length) await runImport(items);
      }}
    >
      <Backdrop />
      {compact ? (
        <CompactTopbar workspace={workspace} />
      ) : (
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden />
            FOCUSED
          </div>
          <div className="topbar-right">
            <button type="button" className="btn small" onClick={() => pickFiles()}>
              Import…
            </button>
            <button type="button" className="btn small ghost" onClick={() => void importFolderInPlace()}>
              Import Folder…
            </button>
            <ImportStatus />
          </div>
          <nav className="modules" aria-label="Workspaces">
            {modules.map((m) => (
              <button key={m.id} type="button" className="module" aria-current={workspace === m.id ? "page" : undefined} onClick={() => setWorkspace(m.id)}>
                {m.label}
                {m.key && <kbd>{m.key}</kbd>}
              </button>
            ))}
          </nav>
          <PanelToggles />
          <TopbarTools />
        </header>
      )}
      {workspace === "library" && (
        <Shell
          left={<LibraryLeftPanel />}
          center={<LibraryCenter />}
          right={<LibraryRightPanel />}
          dock={[
            { id: "folders", label: "Folders", icon: "folders", side: "left" },
            { id: "info", label: "Info", icon: "info", side: "right" },
          ]}
        />
      )}
      {workspace === "develop" && (
        <Suspense fallback={<div className="empty-state">Loading Develop…</div>}>
          <DevelopWorkspace Shell={Shell} />
        </Suspense>
      )}
      {workspace === "composite" && (
        <Suspense fallback={<div className="empty-state">Loading Composite…</div>}>
          <CompositeWorkspace Shell={Shell} />
        </Suspense>
      )}
      {workspace === "video" && (
        <Suspense fallback={<div className="empty-state">Loading Video…</div>}>
          <VideoWorkspace Shell={Shell} />
        </Suspense>
      )}
      {/* Phones show the filmstrip inside the workspace, above the dock. */}
      {!compact && showFilmstrip && workspace !== "video" ? <Filmstrip /> : <div />}
      {dragging && <div className="drop-overlay">Drop photos, videos or folders to import</div>}
      <Toast />
      <ActivityBar />
      <ExportHost />
      <LooksHost />
      <TourHost />
      <MenuHost />
    </div>
  );
}
