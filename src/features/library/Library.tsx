import { useEffect } from "react";
import { useStore } from "@/app/hooks";
import { ui } from "@/app/state";
import { canReferenceFiles } from "@/core/catalog/import";
import { catalog } from "@/core/catalog/store";
import { importFolderInPlace, pickFiles } from "./commands";
import { Grid } from "./Grid";
import { rememberOrder, useResults } from "./results";
import { LibraryToolbar } from "./Toolbar";
import { CompareView, LoupeView, SurveyView } from "./Views";

export function LibraryCenter() {
  const { ids, stacks } = useResults();
  const view = useStore(ui, (s) => s.libraryView);
  const activeId = useStore(ui, (s) => s.activeId);
  const compareId = useStore(ui, (s) => s.compareId);
  const selection = useStore(ui, (s) => s.selection);
  const total = useStore(catalog, (s) => s.assets.size);
  const ready = useStore(catalog, (s) => s.ready);
  useEffect(() => rememberOrder(ids), [ids]);

  if (ready && total === 0) return <EmptyLibrary />;
  return (
    <>
      <LibraryToolbar count={ids.length} total={total} />
      {view === "grid" && <Grid ids={ids} stacks={stacks} />}
      {view === "loupe" && <LoupeView id={activeId ?? ids[0] ?? null} />}
      {view === "compare" && (
        <CompareView selectId={activeId} candidateId={compareId ?? [...selection].find((id) => id !== activeId) ?? null} />
      )}
      {view === "survey" && <SurveyView ids={ids.filter((id) => selection.has(id))} />}
    </>
  );
}

function EmptyLibrary() {
  return (
    <div className="empty-state">
      <h2>Your library is empty</h2>
      <p>
        Import photographs to start. Camera RAW (ARW, CR2, CR3, NEF, DNG, RAF, RW2, ORF and more), JPEG, HEIC, TIFF, PNG and WebP are
        supported. Originals are never modified.
      </p>
      <div className="row" style={{ justifyContent: "center" }}>
        <button type="button" className="btn primary" onClick={() => pickFiles()}>
          Import Photos…
        </button>
        <button type="button" className="btn" onClick={() => void importFolderInPlace()}>
          Import Folder…
        </button>
      </div>
      <p className="faint" style={{ marginTop: 16, fontSize: 11 }}>
        Or drop files and folders anywhere in this window.
        {canReferenceFiles()
          ? " Folders chosen with Import Folder are referenced where they are, without copying."
          : " Imported files are copied into this browser's private library storage."}
      </p>
    </div>
  );
}
