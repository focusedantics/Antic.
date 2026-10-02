import { chooseFiles, pickerAccept } from "@/lib/files";
import { openLooks } from "@/features/looks/LooksDialog";
import { isVideoFile } from "@/core/video/model";
import { openExport } from "@/features/export/host";
import { selectAsset, setWorkspace, targetIds, toast, ui } from "@/app/state";
import {
  canReferenceFiles,
  importItems,
  importProgress,
  itemsFromDirectoryPicker,
  itemsFromFileList,
} from "@/core/catalog/import";
import {
  addToCollection,
  catalog,
  createCollection,
  removeAssets,
  removeFromCollection,
  setFlag,
  setLabel,
  setRating,
  stackAssets,
  unstackAssets,
} from "@/core/catalog/store";
import type { Asset, ColorLabel } from "@/core/catalog/types";
import { acceptAttribute } from "@/core/image/formats";
import { openMenu } from "@/components/Menu";
import { currentOrder } from "./results";

export async function pickFiles(options: { directory?: boolean } = {}) {
  const files = await chooseFiles({
    multiple: true,
    directory: options.directory,
    accept: pickerAccept(`${acceptAttribute},video/mp4,video/quicktime,.mp4,.mov,.m4v,.focused`, { images: true, videos: true }),
  });
  if (files.length) await runImport(itemsFromFileList(files));
}

export async function importFolderInPlace() {
  if (!canReferenceFiles()) {
    pickFiles({ directory: true });
    return;
  }
  try {
    const items = await itemsFromDirectoryPicker();
    if (!items.length) toast("No supported photos in that folder.");
    else await runImport(items);
  } catch (error) {
    if ((error as DOMException)?.name !== "AbortError") toast(String(error), "error");
  }
}

/** Adds looks to the Looks list and opens projects in Composite. */
async function openFocusedFiles(files: File[]) {
  const [{ readLookFile }, { saveLook }, { openProject }, { openDocument }] = await Promise.all([
    import("@/core/looks/look"),
    import("@/core/looks/store"),
    import("@/core/document/project"),
    import("@/core/document/session"),
  ]);
  let looksAdded = 0;
  for (const file of files) {
    try {
      const look = await readLookFile(file);
      if (look) {
        await saveLook(look);
        looksAdded++;
        continue;
      }
      const { document, missing } = await openProject(file);
      openDocument(document);
      setWorkspace("composite");
      if (missing.length) toast(`Opened “${document.name}”. ${missing.length} photo(s) are missing.`, "error");
    } catch (error) {
      toast(`${file.name}: ${error instanceof Error ? error.message : error}`, "error");
    }
  }
  if (looksAdded) {
    toast(`Added ${looksAdded} look${looksAdded === 1 ? "" : "s"}.`);
    openLooks({ kind: "library", ids: targetIds() });
  }
}

export async function runImport(items: Parameters<typeof importItems>[0]) {
  // .focused files are looks or projects; videos go to the Video workspace; the rest are photos.
  const focused = items.filter((i) => i.file.name.toLowerCase().endsWith(".focused")).map((i) => i.file);
  if (focused.length) void openFocusedFiles(focused);
  const rest = items.filter((i) => !i.file.name.toLowerCase().endsWith(".focused"));
  const videos = rest.filter((i) => isVideoFile(i.file)).map((i) => i.file);
  const photos = rest.filter((i) => !isVideoFile(i.file));
  if (videos.length) {
    const { importVideos } = await import("@/core/video/session");
    setWorkspace("video");
    importVideos(videos).catch((error) => toast(error instanceof Error ? error.message : String(error), "error"));
  }
  if (!photos.length) return;
  const source = ui.getState().query.source;
  const before = importProgress.getState();
  const wasRunning = before.active;
  await importItems(photos, { collectionId: source.kind === "collection" ? source.id : undefined });
  // Say what went wrong in words: the status pill's details are a tooltip, which phones can't show.
  const after = importProgress.getState();
  const failed = after.failed - (wasRunning ? before.failed : 0);
  const skipped = after.skipped - (wasRunning ? before.skipped : 0);
  if (failed > 0) toast(`${failed} photo${failed === 1 ? "" : "s"} could not be imported. ${after.errors.at(-1) ?? ""}`.trim(), "error");
  else if (skipped > 0) toast(`${skipped} file${skipped === 1 ? " isn't a" : "s aren't"} supported photo format${skipped === 1 ? "" : "s"} and ${skipped === 1 ? "was" : "were"} skipped.`, "error");
}

export function rate(rating: number) {
  const ids = targetIds();
  if (ids.length) setRating(ids, rating);
}
export function flag(value: Asset["flag"]) {
  const ids = targetIds();
  if (ids.length) setFlag(ids, value);
}
export function label(value: Exclude<ColorLabel, null>) {
  const ids = targetIds();
  if (ids.length) setLabel(ids, value);
}

/** Moves the active photo by `delta` in the current order. */
export function step(delta: number, extend = false) {
  const order = currentOrder();
  if (!order.length) return;
  const { activeId } = ui.getState();
  const index = activeId ? order.indexOf(activeId) : -1;
  const next = order[Math.max(0, Math.min(order.length - 1, index + delta))];
  if (next) selectAsset(next, extend ? "toggle" : "replace", order);
}

export async function removeSelected() {
  const ids = targetIds();
  if (!ids.length) return;
  const stored = ids.filter((id) => catalog.getState().assets.get(id)?.original.kind === "stored").length;
  const message =
    ids.length === 1
      ? `Remove this photo from the library?`
      : `Remove ${ids.length} photos from the library?`;
  const detail = stored
    ? `\n\nCopies stored in the library will be deleted. Files referenced on disk are never touched.`
    : `\n\nFiles on disk are not touched.`;
  if (!confirm(message + detail)) return;
  const order = currentOrder();
  const nextActive = order.find((id) => !ids.includes(id) && order.indexOf(id) > order.indexOf(ids[0])) ?? null;
  await removeAssets(ids);
  ui.setState({ selection: new Set(nextActive ? [nextActive] : []), activeId: nextActive });
  toast(`Removed ${ids.length} photo${ids.length === 1 ? "" : "s"}.`);
}

export function selectAll() {
  const order = currentOrder();
  ui.setState({ selection: new Set(order), activeId: ui.getState().activeId ?? order[0] ?? null });
}

export function assetMenu(x: number, y: number) {
  const ids = targetIds();
  const { collections } = catalog.getState();
  const source = ui.getState().query.source;
  const regular = [...collections.values()].filter((c) => c.kind === "collection");
  const inStack = ids.some((id) => catalog.getState().assets.get(id)?.stackId);
  openMenu(x, y, [
    { label: "Open in Develop", shortcut: "D", onSelect: () => setWorkspace("develop") },
    { label: ids.length > 1 ? `Export ${ids.length} photos…` : "Export…", shortcut: "Ctrl+Shift+E", onSelect: () => openExport(ids) },
    { label: ids.length > 1 ? `Apply a Look to ${ids.length} photos…` : "Apply a Look…", onSelect: () => openLooks({ kind: "library", ids }) },
    { label: "Add to Composite", onSelect: () => void addToComposite(ids) },
    ...(ids.length === 1 ? [{ label: "Apply an Effect…", onSelect: () => void startEffectsFor(ids[0]) }] : []),
    "separator",
    { label: "Pick", shortcut: "P", onSelect: () => flag("pick") },
    { label: "Reject", shortcut: "X", onSelect: () => flag("reject") },
    { label: "Unflag", shortcut: "U", onSelect: () => flag(null) },
    "separator",
    ...(ids.length > 1 ? [{ label: `Stack ${ids.length} photos`, shortcut: "Ctrl+G", onSelect: () => stackAssets(ids) }] : []),
    ...(inStack ? [{ label: "Unstack", onSelect: () => unstackAssets(ids) }] : []),
    ...(ids.length === 2 ? [{ label: "Compare these two", onSelect: () => compare(ids) }] : []),
    ...(ids.length > 1 ? [{ label: `Survey ${ids.length} photos`, shortcut: "N", onSelect: () => ui.setState({ libraryView: "survey" }) }] : []),
    "separator",
    {
      label: "Add to new collection…",
      onSelect: () => {
        const name = prompt("Collection name");
        if (!name) return;
        const c = createCollection(name, "collection");
        addToCollection(ids, c.id);
        toast(`Added to “${c.name}”.`);
      },
    },
    ...regular.slice(0, 12).map((c) => ({ label: `Add to “${c.name}”`, onSelect: () => addToCollection(ids, c.id) })),
    ...(source.kind === "collection" && collections.get(source.id)?.kind === "collection"
      ? [{ label: "Remove from this collection", onSelect: () => removeFromCollection(ids, source.id) }]
      : []),
    "separator",
    { label: ids.length > 1 ? `Remove ${ids.length} photos…` : "Remove photo…", shortcut: "Del", danger: true, onSelect: () => void removeSelected() },
  ]);
}

/** Sweep selection over photos (grid and filmstrip): live selection, then the batch menu. */
export const sweepAssets = {
  initial: () => [...ui.getState().selection],
  onSelect: (ids: string[]) =>
    ui.setState((s) => ({ selection: new Set(ids), activeId: ids.length && !ids.includes(s.activeId ?? "") ? ids[ids.length - 1] : s.activeId })),
  onDone: (ids: string[], x: number, y: number) => {
    if (ids.length) assetMenu(x, y);
  },
};

export function compare(ids: string[]) {
  if (ids.length < 2) return;
  ui.setState({ activeId: ids[0], compareId: ids[1], libraryView: "compare", workspace: "library" });
}

async function startEffectsFor(id: string) {
  const { startEffects } = await import("@/features/composite/actions");
  await startEffects(id);
}

async function addToComposite(ids: string[]) {
  const { addAssetsToComposite } = await import("@/features/composite/actions");
  await addAssetsToComposite(ids);
}
