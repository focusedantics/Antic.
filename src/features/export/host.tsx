import { lazy, Suspense } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";

const ExportDialog = lazy(() => import("./ExportDialog").then((m) => ({ default: m.ExportDialog })));

/** Photos waiting in the Export dialog; null when it is closed. Any workspace can open it. */
export const exportRequest = createStore<{ ids: readonly string[] | null }>(() => ({ ids: null }));

export function openExport(ids: readonly string[]) {
  if (!ids.length) {
    toast("Select photos to export.");
    return;
  }
  exportRequest.setState({ ids });
}

export function ExportHost() {
  const ids = useStore(exportRequest, (s) => s.ids);
  if (!ids) return null;
  return (
    <Suspense fallback={null}>
      <ExportDialog
        ids={[...ids]}
        onClose={() => exportRequest.setState({ ids: null })}
        onDone={(n) => toast(`Exported ${n} photo${n === 1 ? "" : "s"}.`)}
      />
    </Suspense>
  );
}
