import { setWorkspace, toast, ui } from "@/app/state";
import { getDocument, putDocument } from "@/core/catalog/db";
import { createDocument, flatten, groupLayer, sanitizeDocument } from "@/core/document/operations";
import type { CompositeDocument, Layer } from "@/core/document/model";
import { composite, flushDocument, openDocument, openStoredDocument, refreshDocumentList } from "@/core/document/session";
import { buildCollage, defaultLayout } from "@/core/document/collage";
import { assetData, type DesignAsset, type ElementData, saveDesignAsset, type TemplateData } from "@/core/design/assets";
import { fitLayers } from "@/core/looks/look";
import { loadFonts } from "@/core/text/fonts";
import { fitTextBoxes, insertElement, layerFonts } from "./insert";
import type { Template } from "./templates";
import { createId } from "@/lib/id";
import { importPhotosFromDevice, placePhotos } from "@/features/composite/actions";
import { design } from "./state";
import { layoutCanvas } from "@/features/composite/slide";

/** Starts a blank design of `width × height` (per slide, `slides` side by side for a carousel) and opens the editor on it. */
export function newDesign(width: number, height: number, name = "Untitled design", background: string | null = "#ffffff", slides = 1) {
  const doc = createDocument(Math.round(width) * Math.max(1, slides), Math.round(height), name, background, "design");
  openDocument(slides > 1 ? { ...doc, carousel: { slides } } : doc);
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

/** Adds the photos selected in the Library to the open design (empty frames first). */
export async function addLibraryPhotos() {
  const ids = [...ui.getState().selection];
  if (!ids.length) return toast("Select photos in the Library first, or add one from this device.", "error");
  await placePhotos(ids);
}

/**
 * Picks photos from this device, imports them into the Library (where every photo
 * lives) and places them in the open design (empty frames first).
 */
export async function addPhotosFromDevice() {
  const ids = await importPhotosFromDevice();
  if (ids.length) await placePhotos(ids);
}

// ─── Templates, collages and saved things ─────────────────────────────────────

/** Starts a design from a built-in template (fonts loaded first so text boxes fit). */
export async function startTemplate(t: Template) {
  const base = createDocument(t.width, t.height, t.name, t.background, "design");
  const doc = t.slides && t.slides > 1 ? { ...base, carousel: { slides: t.slides } } : base;
  const layers = t.build(doc);
  await loadFonts(layerFonts(layers), 3000);
  startFrom({ ...doc, layers: layers.map(fitTextBoxes) });
}

/** A collage of `ids` (Library photos) on a new design of `size`. */
export function collageFromPhotos(ids: readonly string[], size: { width: number; height: number; name?: string } = { width: 1080, height: 1080 }) {
  const doc = createDocument(size.width, size.height, size.name ?? "Collage", "#ffffff", "design");
  const layout = defaultLayout(ids.length);
  startFrom({ ...doc, layers: [buildCollage(doc, layout.id, { spacing: 0.015, photos: ids.slice(0, layout.cells.length) })] });
}

/** A copy of a layer tree with new ids (masks' component ids too). */
const freshIds = (layers: readonly Layer[]): Layer[] =>
  layers.map((l) => ({
    ...l,
    id: createId("layer"),
    mask: l.mask ? { ...l.mask, components: l.mask.components.map((c) => ({ ...c, id: createId("mc") })) } : null,
    ...(l.kind === "group" ? { children: freshIds(l.children) } : {}),
  })) as Layer[];

/** Frames lose their photos in a template (the user fills them); everything else is kept. */
const emptyFrames = (layers: readonly Layer[]): Layer[] =>
  layers.map((l) => (l.kind === "slot" ? { ...l, assetId: null, fit: { zoom: 1, x: 0, y: 0 } } : l.kind === "group" ? { ...l, children: emptyFrames(l.children) } : l)) as Layer[];

/** Saves the open design as one of my templates (with its thumbnail). */
export async function saveAsTemplate(name: string, folder: string) {
  const doc = composite.getState().doc;
  if (!doc) return;
  await flushDocument();
  const thumb = (await getDocument(doc.id))?.thumb;
  const { purpose: _p, ...rest } = doc;
  await saveDesignAsset("template", name, { document: { ...rest, layers: emptyFrames(doc.layers) } }, { folder, thumb });
  toast(`Saved the template “${name}”.`);
}

/** Starts a design from one of my templates. */
export function startMyTemplate(asset: DesignAsset) {
  const data = assetData(asset) as TemplateData | null;
  if (!data) return toast("This template could not be read.", "error");
  const d = data.document;
  startFrom({ ...d, id: createId("doc"), name: asset.name, createdAt: Date.now(), layers: freshIds(d.layers) });
}

/** Saves the selected layers as one of my elements. */
export async function saveSelectionAsElement(name: string, folder: string) {
  const { doc, selection } = composite.getState();
  if (!doc || !selection.length) return;
  const picked = flatten(doc.layers).filter((l) => selection.includes(l.id));
  // Children of a picked group come with it.
  const tops = picked.filter((l) => !picked.some((g) => g.kind === "group" && flatten(g.children).includes(l)));
  await saveDesignAsset("element", name, { width: doc.width, height: doc.height, layers: emptyFrames(tops) }, { folder });
  toast(`Saved the element “${name}”.`);
}

/** Adds one of my elements to the open design, scaled to it. */
export async function insertMyElement(asset: DesignAsset) {
  const doc = composite.getState().doc;
  const data = assetData(asset) as ElementData | null;
  if (!doc || !data) return;
  // Scaled to one slide of a carousel; insertElement puts it on the slide being worked on.
  const canvas = layoutCanvas(doc);
  const fitted = fitLayers({ width: data.width, height: data.height, items: data.layers }, canvas.width, canvas.height);
  const layer = fitted.length === 1 ? fitted[0] : { ...groupLayer(canvas, fitted, asset.name), expanded: false };
  await insertElement(layer, `Add ${asset.name}`);
}
