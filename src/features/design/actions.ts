import { setWorkspace, toast, ui } from "@/app/state";
import { chooseFiles, pickerAccept } from "@/lib/files";
import { acceptAttribute } from "@/core/image/formats";
import { fingerprint, importItems, itemsFromFileList } from "@/core/catalog/import";
import { catalog } from "@/core/catalog/store";
import { getDocument, putDocument } from "@/core/catalog/db";
import { createDocument, sanitizeDocument } from "@/core/document/operations";
import type { CompositeDocument } from "@/core/document/model";
import { composite, openDocument, openStoredDocument, refreshDocumentList } from "@/core/document/session";
import { createId } from "@/lib/id";
import { addAssetsToComposite } from "@/features/composite/actions";
import { design } from "./state";

/** Starts a blank design of `width × height` and opens the editor on it. */
export function newDesign(width: number, height: number, name = "Untitled design", background: string | null = "#ffffff") {
  openDocument(createDocument(Math.round(width), Math.round(height), name, background, "design"));
  design.setState({ home: false });
}

/** Opens a document as the design to edit (it already is one, or comes from a template). */
export function startFrom(doc: CompositeDocument) {
  openDocument({ ...doc, purpose: "design" });
  design.setState({ home: false });
}

export async function openDesign(id: string) {
  await openStoredDocument(id);
  design.setState({ home: false });
}

/** A copy of a saved design, opened. */
export async function duplicateDesign(id: string) {
  const record = await getDocument(id);
  if (!record) return;
  const doc = sanitizeDocument(record.data);
  startFrom({ ...doc, id: createId("doc"), name: `${doc.name} copy`, createdAt: Date.now() });
}

/** Moves a design to the Composite workspace (it becomes a composition there). */
export async function moveToComposite(id: string) {
  const record = await getDocument(id);
  if (!record) return;
  const { purpose: _purpose, ...doc } = sanitizeDocument(record.data);
  await putDocument({ ...record, data: doc, updatedAt: Date.now() });
  if (composite.getState().doc?.id === id) openDocument(doc);
  await refreshDocumentList();
  setWorkspace("composite");
}

/** Moves a composition here (it becomes a design). */
export async function moveToDesign(doc: CompositeDocument) {
  await putDocument({ id: doc.id, name: doc.name, updatedAt: Date.now(), data: { ...doc, purpose: "design" }, thumb: (await getDocument(doc.id))?.thumb });
  await refreshDocumentList();
  setWorkspace("design");
  await openDesign(doc.id);
}

/** Adds the photos selected in the Library to the open design. */
export async function addLibraryPhotos() {
  const ids = [...ui.getState().selection];
  if (!ids.length) return toast("Select photos in the Library first, or add one from this device.", "error");
  await addAssetsToComposite(ids);
}

/**
 * Picks photos from this device, imports them into the Library (where every photo
 * lives) and adds them to the open design. Photos already in the Library are reused.
 */
export async function addPhotosFromDevice() {
  const files = await chooseFiles({ multiple: true, accept: pickerAccept(acceptAttribute, { images: true }) });
  if (!files.length) return;
  const prints = await Promise.all(files.map((f) => fingerprint(f)));
  await importItems(itemsFromFileList(files));
  const byPrint = new Map([...catalog.getState().assets.values()].map((a) => [a.fingerprint, a.id]));
  const ids = prints.map((p) => byPrint.get(p)).filter((id): id is string => !!id);
  if (ids.length) await addAssetsToComposite(ids);
}
