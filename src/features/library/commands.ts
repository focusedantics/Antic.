import { selectAsset, setWorkspace, targetIds, toast, ui } from "@/app/state";
import {
  canReferenceFiles,
  importItems,
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

export function pickFiles(options: { directory?: boolean } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = acceptAttribute;
  if (options.directory) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  input.onchange = () => {
    if (input.files?.length) void runImport(itemsFromFileList(input.files));
  };
  input.click();
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

export async function runImport(items: Parameters<typeof importItems>[0]) {
  const source = ui.getState().query.source;
  await importItems(items, { collectionId: source.kind === "collection" ? source.id : undefined });
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

export function compare(ids: string[]) {
  if (ids.length < 2) return;
  ui.setState({ activeId: ids[0], compareId: ids[1], libraryView: "compare", workspace: "library" });
}
