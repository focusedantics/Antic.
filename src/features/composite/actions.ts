import { device } from "@/lib/device";
import { track } from "@/lib/activity";
import type { Watermark } from "@/core/export/watermark";
import { setWorkspace, toast, ui } from "@/app/state";
import { getAsset } from "@/core/catalog/store";
import { outputSize } from "@/core/develop/geometry";
import { recipeFor } from "@/core/develop/session";
import type { CompositeDocument, Layer } from "@/core/document/model";
import { createDocument, documentAssets, flatten, imageLayer, insertLayer, updateLayer, updateLayers } from "@/core/document/operations";
import { chooseFiles, pickerAccept } from "@/lib/files";
import { acceptAttribute } from "@/core/image/formats";
import { fingerprint, importItems, itemsFromFileList } from "@/core/catalog/import";
import { catalog } from "@/core/catalog/store";
import { composite, editDocument, openDocument, setDocumentThumbnailer } from "@/core/document/session";
import { docAnimation, isAnimated, loopFrames } from "@/core/document/animation";
import { encodeGif, encodeLoopVideo } from "@/core/export/animated";
import { type ExportFrame, frameLayout } from "@/core/export/frame";
import { fontShorthand } from "@/core/text/draw";
import { loadFonts } from "@/core/text/fonts";
import { loadCustomFonts } from "@/core/text/custom-fonts";
import { developEngine, encodePixels } from "@/core/gpu/develop-engine";

/** Developed pixel size of a photo, from its recipe crop and the catalog dimensions. */
export function photoSize(assetId: string) {
  const asset = getAsset(assetId);
  const recipe = recipeFor(assetId);
  // Prefer the decoded photo's real size; fall back to the catalog, then to 3:2.
  const source = developEngine().sourceFor(assetId);
  const w = source?.size.width || asset?.width || 3000;
  const h = source?.size.height || asset?.height || 2000;
  return recipe ? outputSize({ width: w, height: h }, recipe.geometry) : { width: w, height: h };
}

export function newDocument(width: number, height: number, name: string, background: string | null) {
  openDocument(createDocument(Math.round(width), Math.round(height), name, background));
  setWorkspace("composite");
}

/**
 * Adds photos to the open composition as image layers (a new document sized
 * to the first photo is created when none is open). Layers follow each photo's
 * live develop settings.
 */
export async function addAssetsToComposite(ids: readonly string[], at?: { x: number; y: number }) {
  if (!ids.length) return;
  let { doc } = composite.getState();
  if (!doc) {
    const first = photoSize(ids[0]);
    const scale = Math.min(1, 6000 / Math.max(first.width, first.height));
    const name = getAsset(ids[0])?.fileName.replace(/\.[^.]+$/, "") ?? "Composition";
    openDocument(createDocument(Math.round(first.width * scale), Math.round(first.height * scale), name, "#ffffff"));
    doc = composite.getState().doc!;
  }
  const added: Layer[] = [];
  editDocument(ids.length > 1 ? `Add ${ids.length} photos` : "Add photo", (d) => {
    let next = d;
    const top = composite.getState().selection.at(-1) ?? null;
    ids.forEach((id, i) => {
      const size = photoSize(id);
      const first = d.layers.length === 0 && i === 0;
      let layer = imageLayer(next, id, getAsset(id)?.fileName.replace(/\.[^.]+$/, "") ?? "Photo", size.width, size.height, first);
      if (at && !first) layer = { ...layer, transform: { ...layer.transform, x: at.x + i * 24, y: at.y + i * 24 } };
      added.push(layer);
      next = insertLayer(next, layer, i === 0 ? top : added[i - 1].id);
    });
    return next;
  });
  composite.setState({ selection: added.map((l) => l.id).slice(-1) });
  // Design edits the same documents: stay there when adding to a design.
  if (ui.getState().workspace !== "design") setWorkspace("composite");
}

/**
 * Picks photos on this device and imports them into the Library (where every photo
 * lives; ones already there are reused). Returns their asset ids, in the order picked.
 */
export async function importPhotosFromDevice(multiple = true): Promise<string[]> {
  const files = await chooseFiles({ multiple, accept: pickerAccept(acceptAttribute, { images: true }) });
  if (!files.length) return [];
  const prints = await Promise.all(files.map((f) => fingerprint(f)));
  await importItems(itemsFromFileList(files));
  const byPrint = new Map([...catalog.getState().assets.values()].map((a) => [a.fingerprint, a.id]));
  return prints.map((p) => byPrint.get(p)).filter((id): id is string => !!id);
}

/** Puts a photo in a frame (replacing the one there), centred and unzoomed. */
/**
 * Puts a photo in a frame. With `pair`, empty "before edits" frames get the same photo
 * (one undoable step), so one photo fills a before/after design.
 */
export function fillSlot(slotId: string, assetId: string, pair = true) {
  editDocument("Photo in frame", (d) => {
    const before = pair ? flatten(d.layers).filter((l) => l.kind === "slot" && l.original && !l.assetId && !l.locked && l.id !== slotId).map((l) => l.id) : [];
    return updateLayers(d, [slotId, ...before], (l) => (l.kind === "slot" ? { ...l, assetId, fit: { zoom: 1, x: 0, y: 0 } } : l));
  });
}

/**
 * Replaces a photo layer's photo, keeping its place, width, rotation, clipping,
 * mask and styles; the height follows the new photo's proportions.
 */
export function replaceImage(layerId: string, assetId: string) {
  const size = photoSize(assetId);
  editDocument("Replace photo", (d) =>
    updateLayer(d, layerId, (l) =>
      l.kind === "image"
        ? { ...l, assetId, develop: "asset", name: getAsset(assetId)?.fileName.replace(/\.[^.]+$/, "") ?? l.name, crop: { left: 0, top: 0, right: 1, bottom: 1 }, transform: { ...l.transform, corners: undefined, height: (l.transform.width * size.height) / size.width } }
        : l,
    ),
  );
}

/**
 * Places photos in a design: the selected empty frame first, then the other empty
 * frames from the top of the layer list down; photos left over become photo layers.
 */
export async function placePhotos(ids: readonly string[]) {
  const { doc, selection } = composite.getState();
  if (!doc || !ids.length) return addAssetsToComposite(ids);
  const empty = flatten(doc.layers)
    .filter((l) => l.kind === "slot" && !l.assetId && !l.locked)
    .reverse()
    .map((l) => l.id);
  const first = selection.at(-1);
  const order = first && empty.includes(first) ? [first, ...empty.filter((id) => id !== first)] : empty;
  const queue = [...ids];
  // One photo pairs with "before edits" frames; several go one per frame.
  const pair = ids.length === 1;
  for (const slot of order) {
    const id = queue.shift();
    if (!id) break;
    fillSlot(slot, id, pair);
  }
  if (queue.length) await addAssetsToComposite(queue);
}

/**
 * Starts a new composition from one photo (sized to it, the photo filling the
 * canvas) and opens the Effects browser on it.
 */
export async function startEffects(assetId: string) {
  const size = photoSize(assetId);
  const scale = Math.min(1, 6000 / Math.max(size.width, size.height));
  const name = getAsset(assetId)?.fileName.replace(/\.[^.]+$/, "") ?? "Composition";
  openDocument(createDocument(Math.round(size.width * scale), Math.round(size.height * scale), `${name} effects`, "#ffffff"));
  await addAssetsToComposite([assetId]);
  const { openEffectsBrowser } = await import("@/features/effects/EffectsBrowser");
  openEffectsBrowser();
}

export function usedAssets(doc: CompositeDocument) {
  return documentAssets(doc.layers);
}

export type DocFormat = "png" | "jpeg" | "webp" | "gif" | "mp4";
export type DocExport = {
  format: DocFormat;
  scale: number;
  quality: number;
  /** Behind transparent areas for formats without alpha (JPEG, GIF, MP4). */
  background: string;
  /** Still formats: seconds into the animation loop to capture. */
  time: number;
  /** GIF: error-diffusion dithering (smoother gradients, larger files). */
  dither: boolean;
  /** MP4: how many times the loop plays. */
  repeats: number;
};

export const ANIMATED_FORMATS: ReadonlySet<DocFormat> = new Set(["gif", "mp4"]);
/** GIFs balloon with size, and MP4 encoders top out around 4K. */
const MAX_LONG_SIDE: Record<DocFormat, number> = { png: 8192, jpeg: 8192, webp: 8192, gif: 1600, mp4: 3840 };

/** Pixel size of an export: the chosen scale, capped per format. */
export function exportSize(doc: CompositeDocument, options: Pick<DocExport, "format" | "scale">) {
  const scale = Math.min(options.scale, Math.min(MAX_LONG_SIDE[options.format], device.maxSide) / Math.max(doc.width, doc.height));
  return { scale, width: Math.max(1, Math.round(doc.width * scale)), height: Math.max(1, Math.round(doc.height * scale)) };
}

export type DocProgress = (fraction: number, stage: string) => void;

export function exportDocument(doc: CompositeDocument, options: DocExport, watermark?: Watermark, onProgress?: DocProgress, signal?: AbortSignal, frame?: ExportFrame): Promise<Blob> {
  return track(renderDocumentExport(doc, options, watermark, onProgress ?? (() => {}), signal ?? new AbortController().signal, frame));
}

async function renderDocumentExport(doc: CompositeDocument, options: DocExport, watermark: Watermark | undefined, onProgress: DocProgress, signal: AbortSignal, frame?: ExportFrame): Promise<Blob> {
  // Fonts the user imported must be registered before text is measured and drawn.
  await loadCustomFonts();
  const engine = developEngine();
  // Wait for every photo in the composition to be decoded at full quality.
  for (let i = 0; i < 600 && usedAssets(doc).some((id) => !engine.hasSource(id) || engine.hasSource(id, "preview")); i++) {
    for (const id of usedAssets(doc)) engine.ensureSource(id);
    await new Promise((r) => setTimeout(r, 100));
  }
  // Text layers draw with bundled fonts that download on first use.
  await loadFonts(flatten(doc.layers).flatMap((l) => (l.kind === "text" && l.visible ? [fontShorthand(l.style)] : [])));
  signal.throwIfAborted();
  const { scale, width, height } = exportSize(doc, options);
  const animation = docAnimation(doc);
  if (!ANIMATED_FORMATS.has(options.format)) {
    const time = isAnimated(doc) ? Math.min(Math.max(0, options.time), animation.duration) % animation.duration : 0;
    const pixels = engine.exportDocument(doc, scale, time);
    const type = options.format === "png" ? "image/png" : options.format === "webp" ? "image/webp" : "image/jpeg";
    return encodePixels(pixels, type, options.quality, options.background, watermark, frame);
  }

  // Animated: one seamless loop. A composition without animated effects is a single frame (GIF) or a still clip (MP4).
  const times = isAnimated(doc) ? loopFrames(animation) : options.format === "gif" ? [0] : loopFrames(animation).map(() => 0);
  const release = engine.holdAnimation();
  try {
    // The first frame is verified against a reference render; the rest reuse its warm caches.
    let verified = false;
    let still: ImageData | null = null;
    const render = (i: number) => {
      if (!isAnimated(doc) && still) return still;
      const pixels = verified ? engine.renderDocument(doc, scale, times[i]) : engine.exportDocument(doc, scale, times[i]);
      verified = true;
      if (!isAnimated(doc)) still = pixels;
      return pixels;
    };
    const framed = frameLayout(width, height, frame);
    const common = {
      width: framed.width,
      height: framed.height,
      frame,
      fps: animation.fps,
      frames: times.length,
      background: doc.background ?? options.background,
      watermark,
      signal,
      onProgress: (done: number, total: number, stage: string) => onProgress(done / total, stage),
    };
    if (options.format === "gif") return await encodeGif(render, { ...common, dither: options.dither });
    // Quality 92 (the default) ≈ 0.33 bits per pixel: visually lossless H.264.
    const bitrate = Math.round(Math.min(100e6, Math.max(2e6, width * height * animation.fps * (0.1 + options.quality * 0.25))));
    return await encodeLoopVideo(render, { ...common, repeats: Math.max(1, Math.round(options.repeats)), bitrate, quality: options.quality });
  } finally {
    release();
  }
}

// Saved compositions get a small preview in the documents list.
setDocumentThumbnailer(async (doc) => {
  const engine = developEngine();
  if (engine.mode !== "composite") return undefined;
  // Wait for the photos, or the thumbnail would show an empty canvas.
  for (let i = 0; i < 100 && usedAssets(doc).some((id) => !engine.hasSource(id)); i++) {
    for (const id of usedAssets(doc)) engine.ensureSource(id);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (usedAssets(doc).some((id) => !engine.hasSource(id))) return undefined;
  const scale = Math.min(1, 320 / Math.max(doc.width, doc.height));
  return encodePixels(engine.renderDocument(doc, scale), "image/webp", 0.8);
});

export function notifyLoading() {
  toast("Photos in this composition are still loading.");
}
