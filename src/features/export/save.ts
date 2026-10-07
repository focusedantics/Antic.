import { toast } from "@/app/state";
import { type ExportSink, shareFiles } from "@/core/export/destination";

/**
 * Says an export is done. Several files exported to a phone wait in the share sheet: the
 * toast's button opens it ("Save N Images" puts them all in Photos), since only one
 * download of a burst arrives there.
 */
export function reportExport(sink: ExportSink, done: string) {
  const files = sink.toShare;
  if (!files) return toast(done);
  toast(`${files.length} files are ready.`, "info", { label: `Save all ${files.length}…`, run: () => void shareFiles(files) });
}
