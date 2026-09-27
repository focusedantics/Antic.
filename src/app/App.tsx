import { type DragEvent, lazy, Suspense, useEffect, useState } from "react";
import { MenuHost } from "@/components/Menu";
import { importProgress, itemsFromDataTransfer } from "@/core/catalog/import";
import { loadCatalogIntoStore } from "@/core/catalog/store";
import { Filmstrip } from "@/features/library/Filmstrip";
import { LibraryCenter } from "@/features/library/Library";
import { LibraryLeftPanel } from "@/features/library/LeftPanel";
import { LibraryRightPanel } from "@/features/library/RightPanel";
import { importFolderInPlace, pickFiles, runImport } from "@/features/library/commands";
import { useStore } from "./hooks";
import { handleKey } from "./shortcuts";
import { setWorkspace, toast, ui, type Workspace } from "./state";

const DevelopWorkspace = lazy(() => import("@/features/develop/Develop"));

const modules: { id: Workspace; label: string; key: string }[] = [
  { id: "library", label: "Library", key: "G" },
  { id: "develop", label: "Develop", key: "D" },
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

function Shell({ left, center, right }: { left: React.ReactNode; center: React.ReactNode; right: React.ReactNode }) {
  const showLeft = useStore(ui, (s) => s.showLeft);
  const showRight = useStore(ui, (s) => s.showRight);
  return (
    <main className="workspace">
      {showLeft ? <aside className="side left">{left}</aside> : <div />}
      <section className="center">{center}</section>
      {showRight ? <aside className="side right">{right}</aside> : <div />}
    </main>
  );
}

export function App() {
  const workspace = useStore(ui, (s) => s.workspace);
  const showFilmstrip = useStore(ui, (s) => s.showFilmstrip);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    loadCatalogIntoStore().catch((error) => toast(`Could not open the library: ${error}`, "error"));
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <div
      className="app"
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
              <kbd>{m.key}</kbd>
            </button>
          ))}
        </nav>
      </header>
      {workspace === "library" && <Shell left={<LibraryLeftPanel />} center={<LibraryCenter />} right={<LibraryRightPanel />} />}
      {workspace === "develop" && (
        <Suspense fallback={<div className="empty-state">Loading Develop…</div>}>
          <DevelopWorkspace Shell={Shell} />
        </Suspense>
      )}
      {showFilmstrip ? <Filmstrip /> : <div />}
      {dragging && <div className="drop-overlay">Drop photos or folders to import</div>}
      <Toast />
      <MenuHost />
    </div>
  );
}
