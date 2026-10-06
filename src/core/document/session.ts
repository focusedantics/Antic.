import { createStore } from "zustand/vanilla";
import { deleteDocument, getDocument, listDocuments, putDocument } from "@/core/catalog/db";
import { createHistory, type History } from "@/core/history/history";
import type { CompositeDocument } from "./model";
import { sanitizeDocument } from "./operations";

/** move: select and transform · mask: paint a layer mask · pen: draw a new path · nodes: edit a path · paint: brushes and fill. */
export type CompositeTool = "move" | "mask" | "pen" | "nodes" | "paint";

export type CompositeState = {
  readonly doc: CompositeDocument | null;
  /** Selected layer ids; the last one is the primary (Properties panel). */
  readonly selection: readonly string[];
  readonly tool: CompositeTool;
  readonly view: { readonly fit: boolean; readonly zoom: number; readonly centerX: number; readonly centerY: number };
  readonly snap: boolean;
  readonly showGuides: boolean;
  /** Whether animated effects move in the canvas view (they always export animated). */
  readonly playing: boolean;
  /** Layer whose mask the canvas tools edit. */
  readonly maskLayerId: string | null;
  readonly maskComponentId: string | null;
  /** Saved documents, newest first; `design`: made in the Design workspace. */
  readonly documents: readonly { id: string; name: string; updatedAt: number; design: boolean; folder: string }[];
};

export const composite = createStore<CompositeState>(() => ({
  doc: null,
  selection: [],
  tool: "move",
  view: { fit: true, zoom: 1, centerX: 0.5, centerY: 0.5 },
  snap: true,
  showGuides: true,
  playing: true,
  maskLayerId: null,
  maskComponentId: null,
  documents: [],
}));

let history: History<CompositeDocument> | null = null;
let unsubscribe: (() => void) | null = null;
export const compositeHistory = () => history;

export async function refreshDocumentList() {
  const docs = await listDocuments();
  composite.setState({
    documents: docs
      .map((d) => {
        const data = d.data as { purpose?: unknown; folder?: unknown } | null;
        return { id: d.id, name: d.name, updatedAt: d.updatedAt, design: data?.purpose === "design", folder: typeof data?.folder === "string" ? data.folder : "" };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

/** True when `doc` belongs to the Design workspace (Composite lists the others). */
export const isDesign = (doc: { purpose?: string } | null | undefined) => doc?.purpose === "design";

/**
 * Composite and Design share the open document (one engine, one history); each opens
 * its own kind. Opens the newest saved document of that kind, or closes the open one
 * when there is none. Does nothing if one of that kind is already open.
 */
export async function openLatest(design: boolean) {
  const open = composite.getState().doc;
  if (open && isDesign(open) === design) return;
  await flushDocument();
  await refreshDocumentList();
  const latest = composite.getState().documents.find((d) => d.design === design);
  if (latest) await openStoredDocument(latest.id);
  else closeDocument();
}

/** Closes the open document (it stays saved). */
export function closeDocument() {
  flushDocument();
  unsubscribe?.();
  unsubscribe = null;
  history = null;
  composite.setState({ doc: null, selection: [], maskLayerId: null, maskComponentId: null, tool: "move" });
}

export function openDocument(doc: CompositeDocument) {
  // Save the document being replaced first (its pending save would be cancelled).
  if (composite.getState().doc?.id !== doc.id) flushDocument();
  unsubscribe?.();
  history = createHistory(doc, { label: "Open" });
  const h = history;
  unsubscribe = h.subscribe(() => {
    composite.setState({ doc: h.get() });
    scheduleSave(h.get());
  });
  composite.setState({ doc, selection: doc.layers.length ? [doc.layers[doc.layers.length - 1].id] : [], view: { fit: true, zoom: 1, centerX: 0.5, centerY: 0.5 }, maskLayerId: null, maskComponentId: null, tool: "move" });
  scheduleSave(doc);
}

export async function openStoredDocument(id: string) {
  const record = await getDocument(id);
  if (!record) return;
  lastThumb = { id, thumb: record.thumb };
  openDocument(sanitizeDocument(record.data));
}

export async function removeStoredDocument(id: string) {
  await deleteDocument(id);
  if (composite.getState().doc?.id === id) {
    unsubscribe?.();
    history = null;
    composite.setState({ doc: null, selection: [] });
  }
  await refreshDocumentList();
}

/** One undoable document change. */
export function editDocument(label: string, change: (doc: CompositeDocument) => CompositeDocument) {
  if (!history) return;
  history.set(change(history.get()), label);
}

export const beginDocGesture = (label: string) => history?.begin(label);
export const endDocGesture = () => history?.commit();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The open document's stored thumbnail, so a flush can save without reading it first. */
let lastThumb: { id: string; thumb: Blob | undefined } | null = null;
let thumbnailer: ((doc: CompositeDocument) => Promise<Blob | undefined>) | null = null;
/** The renderer registers a thumbnail maker so saved documents show a preview. */
export const setDocumentThumbnailer = (fn: typeof thumbnailer) => {
  thumbnailer = fn;
};

function scheduleSave(doc: CompositeDocument) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    let thumb: Blob | undefined;
    try {
      thumb = await thumbnailer?.(doc);
    } catch {
      // A thumbnail is optional.
    }
    // Keep the last good thumbnail when a new one couldn't be made (photos still loading).
    thumb ??= lastThumb?.id === doc.id ? lastThumb.thumb : (await getDocument(doc.id))?.thumb;
    lastThumb = { id: doc.id, thumb };
    await putDocument({ id: doc.id, name: doc.name, updatedAt: Date.now(), data: doc, thumb });
    await refreshDocumentList();
  }, 800);
}

/** Saves the open document now if a save is pending; resolves once it is stored and listed. */
export function flushDocument(): Promise<void> {
  const doc = composite.getState().doc;
  if (!saveTimer || !doc) return Promise.resolve();
  clearTimeout(saveTimer);
  saveTimer = null;
  // Keep its thumbnail (making a new one needs the renderer, which may be gone). The
  // write starts synchronously so it survives the page closing.
  const record = (thumb: Blob | undefined) => ({ id: doc.id, name: doc.name, updatedAt: Date.now(), data: doc, thumb });
  const saved = lastThumb?.id === doc.id ? putDocument(record(lastThumb.thumb)) : getDocument(doc.id).then((old) => putDocument(record(old?.thumb)));
  return saved.then(refreshDocumentList);
}

// Edits made in the last moment before the page closes or is hidden are saved too.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushDocument());
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDocument());
}

/** Files a saved document in a folder (the open one is updated in place, without an undo step). */
export async function moveDocumentToFolder(id: string, folder: string) {
  const clean = folder.split("/").map((p) => p.trim()).filter(Boolean).join("/").slice(0, 80);
  if (composite.getState().doc?.id === id) {
    // The open design: an ordinary edit (saved with it).
    editDocument("Move to folder", (d) => {
      const { folder: _f, ...rest } = d;
      return clean ? { ...rest, folder: clean } : rest;
    });
    await flushDocument();
    return;
  }
  const record = await getDocument(id);
  if (!record) return;
  const { folder: _old, ...data } = record.data as CompositeDocument;
  await putDocument({ ...record, data: clean ? { ...data, folder: clean } : data });
  await refreshDocumentList();
}
