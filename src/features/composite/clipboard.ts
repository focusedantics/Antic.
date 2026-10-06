import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import { toast } from "@/app/state";
import { shiftLayer, slideAt, slideWidth } from "@/core/document/carousel";
import type { CompositeDocument, Layer } from "@/core/document/model";
import { canvasTransform, cloneLayer, createDocument, flatten, insertLayer, layerBounds, removeLayers, sanitizeDocument, textLayer } from "@/core/document/operations";
import { composite, editDocument } from "@/core/document/session";
import { fitLayers } from "@/core/looks/look";
import { addAssetsToComposite, importFilesToLibrary } from "./actions";
import { layoutCanvas, ontoWorkingSlide, workingSlide } from "./slide";

/**
 * Copy, cut and paste of layers, and pasting images and text from other apps. Copied
 * layers are kept relative to the slide they came from, so a paste puts them at the same
 * place on the slide being worked on (scaled when that design's slides are another size).
 * The system clipboard carries them as marked text, so they also paste into another
 * design or tab; what comes back from it is untrusted and goes through the sanitizer.
 */

const MARK = "focused-layers:";

type Clip = {
  /** The document they were copied from, and their slide in it (0 for a one-page design). */
  readonly source: string;
  readonly slide: number;
  /** One slide's size there; the layers are placed as if on slide 0. */
  readonly slideWidth: number;
  readonly height: number;
  readonly layers: readonly Layer[];
};

/** The last copied layers (this tab), and how many times they were pasted onto each slide since. */
export const layerClipboard = createStore<{ clip: Clip | null; pastes: Readonly<Record<number, number>> }>(() => ({ clip: null, pastes: {} }));

/** The selected layers, top-level ones only (a selected group brings its children), in paint order. */
function selectedLayers(doc: CompositeDocument, selection: readonly string[]): Layer[] {
  const ids = new Set(selection);
  const out: Layer[] = [];
  const walk = (list: readonly Layer[]) => {
    for (const l of list) {
      if (ids.has(l.id)) out.push(l);
      else if (l.kind === "group") walk(l.children);
    }
  };
  walk(doc.layers);
  return out;
}

/** Copies the selected layers; false when nothing is selected. */
export function copyLayers(): boolean {
  const { doc, selection } = composite.getState();
  if (!doc || !selection.length) return false;
  const layers = selectedLayers(doc, selection);
  if (!layers.length) return false;
  // Their slide: where the middle of what they show is.
  const boxes = flatten(layers).filter((l) => l.kind !== "group").map(layerBounds);
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const slide = boxes.length ? slideAt(doc, (left + right) / 2) : 0;
  const sw = slideWidth(doc);
  layerClipboard.setState({ clip: { source: doc.id, slide, slideWidth: sw, height: doc.height, layers: layers.map((l) => shiftLayer(l, -slide * sw)) }, pastes: {} });
  return true;
}

function deleteCut(selection: readonly string[]) {
  editDocument(selection.length > 1 ? `Cut ${selection.length} layers` : "Cut layer", (d) => removeLayers(d, selection), { merge: false });
  composite.setState({ selection: [] });
}

/** Copies the selected layers and deletes them (one undo step). */
export function cutLayers(): boolean {
  if (!copyLayers()) return false;
  deleteCut(composite.getState().selection);
  return true;
}

const canvasWide = (l: Layer) => l.kind === "fill" || l.kind === "adjustment" || l.kind === "effect";

/** Pastes layers onto the slide being worked on, above the selection, and selects them. */
export function pasteLayers(clip = layerClipboard.getState().clip): boolean {
  const doc = composite.getState().doc;
  if (!doc || !clip?.layers.length) return false;
  const sw = slideWidth(doc);
  const target = workingSlide(doc) ?? 0;
  const sameSize = Math.abs(clip.slideWidth / sw - 1) < 0.01 && Math.abs(clip.height / doc.height - 1) < 0.01;
  // Another slide size: scaled to fit one slide here.
  let layers = sameSize
    ? clip.layers.map((l) => (canvasWide(l) ? { ...cloneLayer(l), transform: canvasTransform(doc) } : cloneLayer(l)))
    : fitLayers({ width: clip.slideWidth, height: clip.height, items: clip.layers }, sw, doc.height).map((l) => (canvasWide(l) ? { ...l, transform: canvasTransform(doc) } : l));
  // The first paste onto a slide lands on the same spot; each further one (and any onto the
  // slide they came from, where the originals are) a step lower right, so it is seen.
  const { pastes } = layerClipboard.getState();
  const before = pastes[target] ?? 0;
  const step = (before + (clip.source === doc.id && target === clip.slide ? 1 : 0)) * Math.round(Math.min(sw, doc.height) * 0.02);
  layers = layers.map((l) => (canvasWide(l) ? l : shiftLayer(l, target * sw + step, step)));
  const { selection } = composite.getState();
  editDocument(layers.length > 1 ? `Paste ${layers.length} layers` : "Paste", (d) => {
    let next = d;
    let anchor = selection.at(-1) ?? null;
    for (const l of layers) {
      next = insertLayer(next, l, anchor);
      anchor = l.id;
    }
    return next;
  }, { merge: false });
  layerClipboard.setState({ pastes: { ...pastes, [target]: before + 1 } });
  composite.setState({ selection: layers.map((l) => l.id), tool: "move" });
  return true;
}

/** Text from another app as a text layer on the slide being worked on. */
function pasteText(text: string) {
  const doc = composite.getState().doc;
  if (!doc) return;
  const layer = ontoWorkingSlide(doc, textLayer(layoutCanvas(doc), { text: text.slice(0, 2000) }));
  const { selection } = composite.getState();
  editDocument("Paste text", (d) => insertLayer(d, layer, selection.at(-1)), { merge: false });
  composite.setState({ selection: [layer.id], tool: "move" });
}

/** Images from another app: into the Library, then onto the slide being worked on. */
async function pasteImages(files: File[]) {
  const ids = await importFilesToLibrary(files);
  if (ids.length) await addAssetsToComposite(ids);
  else toast("That image could not be read.", "error");
}

/** Layers from clipboard text written by `copy`, checked like any document from outside; null when it isn't ours. */
function readClip(text: string): Clip | null {
  if (!text.startsWith(MARK)) return null;
  try {
    const raw = JSON.parse(text.slice(MARK.length)) as Partial<Clip>;
    const width = Number(raw.slideWidth);
    const height = Number(raw.height);
    if (!(width >= 16 && width <= 30000 && height >= 16 && height <= 30000)) return null;
    const safe = sanitizeDocument({ ...createDocument(width, height), layers: raw.layers });
    if (!safe.layers.length) return null;
    return { source: typeof raw.source === "string" ? raw.source : "", slide: Math.max(0, Math.round(Number(raw.slide) || 0)), slideWidth: width, height, layers: safe.layers };
  } catch {
    return null;
  }
}

/** Typing, or text selected on the page: the browser's own copy and paste. */
function forText(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (el?.closest("input, textarea, select, [contenteditable='true']")) return true;
  return !!window.getSelection()?.toString();
}

/**
 * A Ctrl/⌘ + X or V whose cut or paste event never came (some browsers send none without
 * a text field focused): done from the keyboard instead, right after.
 */
let pendingPaste = 0;
let pendingCut = 0;

/**
 * Keyboard: Ctrl/⌘ + C, X, V. Always returns false, so the browser goes on to send the
 * copy, cut or paste event, which carries the system clipboard (images and text from
 * other apps, our layers to other tabs).
 */
export function clipboardShortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.shiftKey || e.altKey || forText(e.target)) return false;
  const key = e.key.toLowerCase();
  if (key === "c") copyLayers();
  else if (key === "x" && copyLayers()) {
    const selection = composite.getState().selection;
    window.clearTimeout(pendingCut);
    pendingCut = window.setTimeout(() => deleteCut(selection), 0);
  } else if (key === "v") {
    window.clearTimeout(pendingPaste);
    pendingPaste = window.setTimeout(() => pasteLayers(), 0);
  }
  return false;
}

/** Whether a canvas is being edited now (each workspace using the clipboard says when it is). */
const editors = new Set<() => boolean>();
const editing = () => [...editors].some((active) => active());

function onCopy(e: ClipboardEvent, cut: boolean) {
  if (cut) window.clearTimeout(pendingCut);
  if (forText(e.target) || !editing()) return;
  const { selection } = composite.getState();
  if (!selection.length || !copyLayers()) return;
  const clip = layerClipboard.getState().clip!;
  e.clipboardData?.setData("text/plain", MARK + JSON.stringify(clip));
  e.preventDefault();
  if (cut) deleteCut(selection);
}

function onPaste(e: ClipboardEvent) {
  window.clearTimeout(pendingPaste);
  if (forText(e.target) || !editing() || !composite.getState().doc) return;
  const data = e.clipboardData;
  const text = data?.getData("text/plain") ?? "";
  const ours = readClip(text);
  const images = [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  e.preventDefault();
  if (ours) pasteLayers(ours);
  else if (images.length) void pasteImages(images);
  else if (text.trim()) pasteText(text.trim());
  else pasteLayers();
}

let installed = 0;
const copy = (e: ClipboardEvent) => onCopy(e, false);
const cut = (e: ClipboardEvent) => onCopy(e, true);

/** Copy, cut and paste while a composition or design is being edited (`active` says when). */
export function useLayerClipboard(active: () => boolean) {
  useEffect(() => {
    editors.add(active);
    if (installed++ === 0) {
      window.addEventListener("copy", copy);
      window.addEventListener("cut", cut);
      window.addEventListener("paste", onPaste);
    }
    return () => {
      editors.delete(active);
      if (--installed === 0) {
        window.removeEventListener("copy", copy);
        window.removeEventListener("cut", cut);
        window.removeEventListener("paste", onPaste);
      }
    };
  }, []);
}
