import { createStore } from "zustand/vanilla";
import { deleteDocument, getDocument, listDocuments, putDocument } from "@/core/catalog/db";
import { createHistory, type History } from "@/core/history/history";
import type { CompositeDocument } from "./model";
import { sanitizeDocument } from "./operations";

export type CompositeTool = "move" | "mask";

export type CompositeState = {
  readonly doc: CompositeDocument | null;
  /** Selected layer ids; the last one is the primary (Properties panel). */
  readonly selection: readonly string[];
  readonly tool: CompositeTool;
  readonly view: { readonly fit: boolean; readonly zoom: number; readonly centerX: number; readonly centerY: number };
  readonly snap: boolean;
  readonly showGuides: boolean;
  /** Layer whose mask the canvas tools edit. */
  readonly maskLayerId: string | null;
  readonly maskComponentId: string | null;
  readonly documents: readonly { id: string; name: string; updatedAt: number }[];
};

export const composite = createStore<CompositeState>(() => ({
  doc: null,
  selection: [],
  tool: "move",
  view: { fit: true, zoom: 1, centerX: 0.5, centerY: 0.5 },
  snap: true,
  showGuides: true,
  maskLayerId: null,
  maskComponentId: null,
  documents: [],
}));

let history: History<CompositeDocument> | null = null;
let unsubscribe: (() => void) | null = null;
export const compositeHistory = () => history;

export async function refreshDocumentList() {
  const docs = await listDocuments();
  composite.setState({ documents: docs.map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt) });
}

export function openDocument(doc: CompositeDocument) {
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
  if (record) openDocument(sanitizeDocument(record.data));
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
    thumb ??= (await getDocument(doc.id))?.thumb;
    await putDocument({ id: doc.id, name: doc.name, updatedAt: Date.now(), data: doc, thumb });
    await refreshDocumentList();
  }, 800);
}

export function flushDocument() {
  const doc = composite.getState().doc;
  if (saveTimer && doc) {
    clearTimeout(saveTimer);
    saveTimer = null;
    void putDocument({ id: doc.id, name: doc.name, updatedAt: Date.now(), data: doc });
  }
}
