import { prefersReducedMotion } from "@/lib/pacing";
import { placeClear } from "@/lib/fit";
import { device, viewDpr } from "@/lib/device";
import { beginActivity } from "@/lib/activity";
import { similarImages } from "./verify";
import { composeExport, type ExportFrame } from "@/core/export/frame";
import { type Watermark, watermarkFont } from "@/core/export/watermark";
import { getRaster, getSetting, getThumb, putSetting, putThumb } from "@/core/catalog/db";
import { catalog, getAsset, updateAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { fullCrop } from "@/core/develop/defaults";
import { outputSize, type Size } from "@/core/develop/geometry";
import type { DevelopRecipe } from "@/core/develop/recipe";
import { currentHistory, develop, type Histogram, recipeFor } from "@/core/develop/session";
import { type LoadedSource, loadSource } from "@/core/develop/source-loader";
import type { CompositeDocument } from "@/core/document/model";
import { effectById } from "@/core/effects/registry";
import { EffectRunner } from "@/core/effects/runtime";
import type { EffectInstance } from "@/core/effects/types";
import { docAnimation, isAnimated } from "@/core/document/animation";
import { documentAssets, flatten, layerAsset, locate, updateLayer } from "@/core/document/operations";
import { fontLoads, loadFonts } from "@/core/text/fonts";
import { composite } from "@/core/document/session";
import { type Mat3, toGlMat3 } from "@/lib/math";
import { Compositor } from "./compositor";
import { Gpu, type Target } from "./gl";
import * as CS from "./shaders/composite";
import { MaskRenderer } from "./masks";
import { DevelopPipeline, type GpuSource, type MaskStage } from "./pipeline";
import * as S from "./shaders/passes";

type Loaded = { gpu: GpuSource; quality: "preview" | "raw" | "rendered" };

/** Frees decoded pixels once they are on the GPU: nothing of a photo is kept on the CPU. */
function releaseDecoded(data: LoadedSource) {
  if (data.data.kind === "image" && data.data.image instanceof ImageBitmap) data.data.image.close();
}

/**
 * Renders the photo open in Develop into one persistent canvas. The canvas is
 * moved between containers rather than recreated, so GPU resources survive
 * workspace switches. Frame state (textures, histograms) never enters React.
 */
export class DevelopEngine {
  readonly canvas: HTMLCanvasElement;
  private gpu: Gpu;
  private pipeline: DevelopPipeline;
  private sources = new Map<AssetId, Loaded>();
  /**
   * The view render: `content` says what it shows (photo, recipe, draft, mask overlay),
   * `key` also how (size, window); `window` is the part of the photo it holds (uv x, y, w, h).
   */
  private result: { target: Target; key: unknown[]; content: unknown[]; window: number[] } | null = null;
  /** A render of the whole photo kept while the view shows a zoomed-in window: shown around it while moving. */
  private overview: { target: Target; content: unknown[] } | null = null;
  /** Until when view changes count as motion (pinch, pan, glide): drawn from the renders at hand, sharpened after. */
  private motionUntil = 0;
  private settleTimer = 0;
  private overviewTimer = 0;
  /** Phones: the photo alone, edge to edge (tap to hide the interface). */
  private immersive = false;
  /** A glide waiting for the next resize: where the photo was on screen before the layout changed. */
  private pendingGlide: { rect: DOMRect; at: number } | null = null;
  /** A histogram update skipped while the interface was hidden. */
  private deferredHistogram: { whole: { source: GpuSource; recipe: DevelopRecipe } | null } | null = null;
  private before: { target: Target; key: unknown[] } | null = null;
  private frameRequested = false;
  private histogramTimer: ReturnType<typeof setTimeout> | null = null;
  private thumbTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: ResizeObserver | null = null;
  private lost = false;
  masks: MaskStage;
  maskRenderer: MaskRenderer;
  /** Only the on-screen render keeps the edited mask's coverage for the overlay. */
  private viewRender = false;
  /** Draws tool overlays (crop frame, mask pins) after each frame. */
  onFrame: (() => void) | null = null;
  /** Which workspace the canvas currently shows. */
  mode: "develop" | "composite" = "develop";
  compositor: Compositor;
  /**
   * A second compositor for renders other than the view (thumbnails, the eyedropper, effect
   * previews, exports). Its layer caches are its own: a small thumbnail no longer replaces
   * every layer's view-sized raster and developed photo, which then had to be made again.
   * Freed a few seconds after its last use.
   */
  private offscreen: Compositor | null = null;
  private offscreenTimer = 0;
  private compositeResult: { target: Target; key: unknown[] } | null = null;
  private loadingSources = new Set<AssetId>();
  private previewEffects: EffectRunner | null = null;
  private previewGeneration = 0;
  /** Live animation of the composite view: clock origin and the pending tick. */
  private animationStart = performance.now();
  private pausedTime = 0;
  private animationTick = 0;
  private animationHolds = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "develop-canvas";
    this.gpu = new Gpu(this.canvas);
    // Exports borrow the canvas to read pixels back; redraw the view afterwards.
    this.gpu.onCanvasBorrowed = () => this.redrawNow();
    this.pipeline = new DevelopPipeline(this.gpu);
    this.maskRenderer = this.createMaskRenderer();
    this.compositor = this.createCompositor();
    this.masks = (input, ctx) => {
      const s = develop.getState();
      const overlay = s.tool === "mask" && (s.maskOverlay || s.maskBw);
      return this.maskRenderer.stage(input, ctx, s.activeMaskId, this.viewRender ? (overlay ? "view-overlay" : "view") : "offscreen");
    };
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener("webglcontextrestored", () => this.restore());
    // Phones: a backgrounded tab gives back its idle GPU memory, so the OS is less
    // likely to discard the page (it would otherwise reload with the work lost).
    if (device.lite)
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden || this.lost) return;
        // Preloaded neighbours are decoded again when the next photo is opened.
        this.setWarm([]);
        this.freeMemory();
        this.maskRenderer.trim(0);
      });
    develop.subscribe((s, prev) => {
      if (s.view !== prev.view) this.motion();
      if (s.recipe !== prev.recipe || s.view !== prev.view || s.compare !== prev.compare || s.peek !== prev.peek || s.splitPosition !== prev.splitPosition || s.clipping !== prev.clipping || s.assetId !== prev.assetId || s.tool !== prev.tool || s.activeMaskId !== prev.activeMaskId || s.maskOverlay !== prev.maskOverlay || s.maskBw !== prev.maskBw)
        this.requestRender();
      if (s.recipe !== prev.recipe && s.assetId === prev.assetId) this.scheduleThumbnails();
    });
    composite.subscribe((s, prev) => {
      if (s.playing !== prev.playing) {
        // Resume from the paused frame instead of jumping.
        if (s.playing) this.animationStart = performance.now() - this.pausedTime * 1000;
      }
      // Cropping draws its photo whole: redraw when it starts, ends or moves to another layer.
      const cropping = s.tool !== prev.tool || (s.tool === "crop" && s.selection !== prev.selection);
      if (this.mode === "composite" && (s.doc !== prev.doc || s.view !== prev.view || s.playing !== prev.playing || cropping)) this.requestRender();
    });
    // Text rasters wait for their font; redraw when one arrives.
    fontLoads.subscribe(() => {
      if (this.mode === "composite") {
        this.pipeline.release(this.compositeResult?.target);
        this.compositeResult = null;
        this.requestRender();
      }
    });
    // Recipe edits in Develop change image layers that follow them.
    catalog.subscribe(() => {
      if (this.mode === "composite") this.requestRender();
    });
  }

  get pipelineRef() {
    return this.pipeline;
  }

  /** Memory the engine holds, for diagnostics and the memory benchmark (bench/). */
  stats() {
    // Decoded pixels are not kept on the CPU (see `releaseDecoded`): cpuBytes stays 0.
    return { gpuBytes: this.gpu.textureBytes, textures: this.gpu.textureCount, sources: this.sources.size, cpuBytes: 0 };
  }

  private createCompositor() {
    return new Compositor(this.gpu, this.pipeline, this.maskRenderer, (id) => this.compositeSource(id));
  }

  /** Decoded photo for a composite image layer; starts decoding (full quality) when missing. */
  ensureSource(assetId: AssetId): GpuSource | null {
    return this.compositeSource(assetId);
  }

  private compositeSource(assetId: AssetId): GpuSource | null {
    const loaded = this.sources.get(assetId);
    if (loaded && loaded.quality !== "preview") return loaded.gpu;
    if (!this.loadingSources.has(assetId)) {
      const asset = getAsset(assetId);
      if (asset) {
        this.loadingSources.add(assetId);
        void loadSource(asset)
          .then((data) => this.setSource(assetId, data, data.quality))
          .catch((error) => console.warn(`Could not load ${asset.fileName} for the composition:`, error))
          .finally(() => this.loadingSources.delete(assetId));
      }
    }
    return loaded?.gpu ?? null;
  }

  private createMaskRenderer() {
    const renderer = new MaskRenderer(this.gpu, getRaster);
    renderer.onRasterLoaded = () => {
      // Rasters load asynchronously: cached renders made without them are stale.
      this.compositor?.dispose();
      this.offscreen?.dispose();
      this.invalidate();
      this.requestRender();
    };
    return renderer;
  }

  private restore() {
    this.gpu = new Gpu(this.canvas);
    // Exports borrow the canvas to read pixels back; redraw the view afterwards.
    this.gpu.onCanvasBorrowed = () => this.redrawNow();
    this.pipeline = new DevelopPipeline(this.gpu);
    this.maskRenderer = this.createMaskRenderer();
    this.compositor = this.createCompositor();
    this.offscreen = null;
    this.previewEffects = null;
    this.result = this.before = null;
    this.compositeResult = null;
    // Nothing decoded is kept on the CPU: photos still needed are read again from their originals.
    const wanted = [...this.sources.keys()];
    this.sources.clear();
    this.lost = false;
    this.requestRender();
    void this.reloadSources(wanted);
  }

  /** Decodes photos again after a lost context, one at a time, those still in use first. */
  private async reloadSources(ids: readonly AssetId[]) {
    const open = develop.getState().assetId;
    const ordered = [...ids].sort((a, b) => (b === open ? 1 : 0) - (a === open ? 1 : 0));
    for (const id of ordered) {
      const asset = getAsset(id);
      if (!asset || this.lost || this.sources.has(id)) continue;
      const stillUsed = id === develop.getState().assetId || this.warm.has(id) || this.inComposition().has(id);
      if (!stillUsed) continue;
      try {
        const loaded = await loadSource(asset, undefined, true);
        if (this.lost) {
          releaseDecoded(loaded);
          return;
        }
        this.setSource(id, loaded, loaded.quality);
      } catch (error) {
        console.warn(`Could not reload ${asset.fileName} after the GPU was reset:`, error);
      }
    }
  }

  private inComposition(): Set<AssetId> {
    const doc = composite.getState().doc;
    return new Set(doc ? documentAssets(doc.layers) : []);
  }

  attach(container: HTMLElement) {
    // First child: tool overlays rendered by React stack above the canvas.
    container.prepend(this.canvas);
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.resize(container));
    this.observer.observe(container);
    this.resize(container);
  }

  detach() {
    this.observer?.disconnect();
    this.observer = null;
    this.canvas.remove();
  }

  private resize(container: HTMLElement) {
    const dpr = viewDpr();
    const w = Math.max(1, Math.round(container.clientWidth * dpr));
    const h = Math.max(1, Math.round(container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${container.clientWidth}px`;
      this.canvas.style.height = `${container.clientHeight}px`;
      // Resizing cleared the canvas: draw it again before it is shown, from the renders at hand.
      this.motion();
      if (!this.lost && !this.drawing) {
        try {
          this.frame();
        } catch (error) {
          console.error(error);
        }
      }
      this.glide();
    }
    this.requestRender();
  }

  hasSource(assetId: AssetId, quality?: Loaded["quality"]) {
    const s = this.sources.get(assetId);
    return !!s && (!quality || s.quality === quality);
  }

  sourceFor(assetId: AssetId) {
    return this.sources.get(assetId)?.gpu ?? null;
  }

  /** Puts a decoded photo on the GPU (the decoded pixels are freed). */
  setSource(assetId: AssetId, data: LoadedSource, quality: Loaded["quality"]) {
    if (this.lost) return releaseDecoded(data);
    const old = this.sources.get(assetId);
    let gpu: GpuSource;
    try {
      gpu = this.pipeline.upload(assetId, data.data, data.info);
    } finally {
      releaseDecoded(data);
    }
    this.sources.set(assetId, { gpu, quality });
    if (old) this.pipeline.disposeSource(old.gpu);
    this.evict(assetId);
    this.invalidate();
    this.requestRender();
  }

  /** Neighbours of the open photo decoded ahead of time (see `prefetchNeighbours`); kept on the GPU. */
  private warm = new Set<AssetId>();

  /**
   * Before heavy work beside the engine (AI selection): phones drop the preloaded
   * neighbours and idle pooled targets. Both come back by themselves when needed.
   */
  makeRoom() {
    if (!device.lite || this.lost) return;
    this.setWarm([]);
    this.pipeline.trim();
  }

  /** Leaving Develop: phones give back idle GPU memory (pooled targets, mask caches no longer drawn). */
  relax() {
    if (!device.lite || this.lost) return;
    this.pipeline.trim();
    this.maskRenderer.trim(0);
  }

  /** Which photos to keep decoded besides the open one; others beyond the budget are freed now. */
  setWarm(ids: readonly AssetId[]) {
    this.warm = new Set(ids);
    this.evict(null);
  }

  isWarm = (id: AssetId) => this.warm.has(id);

  /** Uploads a photo decoded ahead of time without touching what is on screen. */
  preloadSource(assetId: AssetId, data: LoadedSource, quality: Loaded["quality"]) {
    if (!this.warm.has(assetId) || this.lost) return releaseDecoded(data);
    const old = this.sources.get(assetId);
    let gpu: GpuSource;
    try {
      gpu = this.pipeline.upload(assetId, data.data, data.info);
    } finally {
      releaseDecoded(data);
    }
    this.sources.set(assetId, { gpu, quality });
    if (old) this.pipeline.disposeSource(old.gpu);
    this.evict(assetId);
  }

  // Keep few decoded photos on the GPU: the one in Develop, those in the open composition,
  // and either its warm neighbours (exactly those) or, with none, the last one used.
  private evict(justSet: AssetId | null) {
    const inDoc = this.inComposition();
    const open = develop.getState().assetId;
    const keep = (id: AssetId) => id === justSet || id === open || inDoc.has(id) || this.warm.has(id);
    // Phones keep nothing beyond what is in use; computers also the last photo used.
    const limit = this.warm.size ? 0 : Math.max(device.lite ? 1 : 2, inDoc.size + 1);
    for (const id of [...this.sources.keys()]) {
      if (this.sources.size <= limit) break;
      if (keep(id)) continue;
      this.pipeline.disposeSource(this.sources.get(id)!.gpu);
      this.sources.delete(id);
    }
  }

  invalidate() {
    this.pipeline.release(this.overview?.target);
    this.overview = null;
    this.pipeline.release(this.result?.target);
    this.pipeline.release(this.before?.target);
    this.pipeline.release(this.compositeResult?.target);
    this.result = this.before = this.compositeResult = null;
  }

  requestRender() {
    if (this.frameRequested) return;
    this.frameRequested = true;
    const end = beginActivity();
    requestAnimationFrame(() => {
      this.frameRequested = false;
      try {
        this.frame();
      } catch (error) {
        console.error(error);
        develop.setState({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        end();
      }
    });
  }

  private uncropped = new WeakMap<DevelopRecipe, DevelopRecipe>();

  /** The recipe as drawn: while cropping, the whole straightened frame is shown. */
  displayRecipe(): DevelopRecipe | null {
    const { recipe, tool } = develop.getState();
    if (!recipe || tool !== "crop") return recipe;
    let r = this.uncropped.get(recipe);
    if (!r) {
      r = { ...recipe, geometry: { ...recipe.geometry, crop: fullCrop }, effects: { ...recipe.effects, vignetteAmount: 0 } };
      this.uncropped.set(recipe, r);
    }
    return r;
  }

  // ─── View math ───────────────────────────────────────────────────────────

  /** Full-resolution size of the developed (cropped) photo. */
  outputSize(): Size | null {
    const { assetId } = develop.getState();
    const recipe = this.displayRecipe();
    const src = assetId ? this.sources.get(assetId) : null;
    if (!src || !recipe) return null;
    return outputSize(this.fullSourceSize(src), recipe.geometry);
  }

  /**
   * Full-resolution source size. While the catalog preview stands in for a RAW,
   * scale it up to the photo's real dimensions so crops and zoom stay true.
   */
  private fullSourceSize(src: Loaded): Size {
    return src.gpu.size;
  }

  /** Device pixels per full-resolution output pixel. */
  displayScale(size = this.outputSize(), region = this.regions()[0]): number {
    const { view } = develop.getState();
    if (!size || !region) return 1;
    const fit = Math.min(region.width / size.width, region.height / size.height);
    return view.fit ? fit : view.zoom;
  }

  fitScale(size = this.outputSize()) {
    const region = this.regions()[0];
    if (!size || !region) return 1;
    return Math.min(region.width / size.width, region.height / size.height);
  }

  /** CSS px at the bottom of the viewer that a translucent panel floats over (phones). */
  private cover = 0;

  setCover(cssPx: number) {
    if (Math.abs(cssPx - this.cover) < 0.5) return;
    this.cover = cssPx;
    this.motion();
    this.requestRender();
  }

  /**
   * Phones' tap-to-hide view: the photo fills the screen edge to edge. `from` is where
   * the photo was on screen (`photoRect()` before the layout changed): it glides from
   * there to its new place once the viewer has its new size.
   */
  setImmersive(on: boolean, from?: DOMRect | null) {
    if (this.immersive === on) return;
    this.immersive = on;
    if (!on && this.deferredHistogram) {
      const { whole } = this.deferredHistogram;
      this.deferredHistogram = null;
      this.scheduleHistogram(whole);
    }
    this.pendingGlide = from && !prefersReducedMotion() ? { rect: from, at: performance.now() } : null;
    this.motion();
    this.requestRender();
  }

  /** Where the developed photo is drawn, in client px (null when nothing is open). */
  photoRect(): DOMRect | null {
    if (this.mode !== "develop" || !this.outputSize()) return null;
    const [x0, y0] = this.outputToClient(0, 0);
    const [x1, y1] = this.outputToClient(1, 1);
    return new DOMRect(x0, y0, x1 - x0, y1 - y0);
  }

  /**
   * Marks the view as moving (zoom, pan, a panel or the viewer resizing): until it rests
   * for SETTLE_MS, frames redraw the renders at hand under the new mapping (one cheap
   * pass, like Lightroom's), then a sharp render replaces them.
   */
  private motion() {
    this.motionUntil = performance.now() + SETTLE_MS;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.requestRender(), SETTLE_MS + 16);
  }

  /** Starts a pending glide: the canvas is moved and scaled so the photo sits where it was, then eases into place. */
  private glide() {
    const pending = this.pendingGlide;
    this.pendingGlide = null;
    if (!pending || performance.now() - pending.at > 500) return;
    const to = this.photoRect();
    if (!to || to.width < 1 || pending.rect.width < 1) return;
    const canvas = this.canvas;
    const box = canvas.getBoundingClientRect();
    const k = pending.rect.width / to.width;
    const tx = pending.rect.x - box.x - k * (to.x - box.x);
    const ty = pending.rect.y - box.y - k * (to.y - box.y);
    canvas.style.transition = "none";
    canvas.style.transformOrigin = "0 0";
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    void canvas.offsetWidth; // apply it before the transition starts
    canvas.style.transition = `transform ${GLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    canvas.style.transform = "";
    window.setTimeout(() => {
      if (!canvas.style.transform) canvas.style.transition = "";
    }, GLIDE_MS + 50);
  }

  /** Canvas regions (device px) the photo is drawn into: one, or two for side-by-side. */
  regions(): { x: number; y: number; width: number; height: number }[] {
    const pad = this.immersive ? 0 : Math.round(16 * viewDpr());
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.cover > 0 && develop.getState().compare !== "side-by-side") {
      // A panel floats over the bottom (Lightroom mobile). Editing, the photo keeps the
      // size that fits the whole viewer but sits clear of the panel when it fits above
      // it, and otherwise starts at the top so as much as possible stays uncovered.
      const region = { x: pad, y: pad, width: w - pad * 2, height: h - pad * 2 };
      // Crop, masks and heal work up to the photo's edges: it fits whole above the panel.
      if (develop.getState().tool !== "adjust") return [{ ...region, height: Math.max(1, h - this.cover * viewDpr() - pad * 2) }];
      const size = this.outputSize();
      if (!size) return [region];
      const shown = size.height * Math.min(region.width / size.width, region.height / size.height);
      const top = placeClear(shown, h, this.cover * viewDpr(), pad);
      return [{ ...region, y: Math.round(top - (region.height - shown) / 2) }];
    }
    if (develop.getState().compare === "side-by-side") {
      const half = Math.floor(w / 2);
      return [
        { x: half + pad / 2, y: pad, width: half - pad * 1.5, height: h - pad * 2 },
        { x: pad, y: pad, width: half - pad * 1.5, height: h - pad * 2 },
      ];
    }
    return [{ x: pad, y: pad, width: w - pad * 2, height: h - pad * 2 }];
  }

  /** Canvas device px → output uv, for the main region. */
  canvasToOutput(region = this.regions()[0]): Mat3 {
    const size = this.outputSize() ?? { width: 1, height: 1 };
    const s = this.displayScale(size, region);
    const { view } = develop.getState();
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    const center = develop.getState().view.fit ? { x: 0.5, y: 0.5 } : { x: view.centerX, y: view.centerY };
    const sx = 1 / (s * size.width);
    const sy = 1 / (s * size.height);
    return [sx, 0, center.x - cx * sx, 0, sy, center.y - cy * sy, 0, 0, 1];
  }

  /** Client (CSS px) coordinates → output uv. */
  clientToOutput(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const m = this.canvasToOutput();
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;
    return [m[0] * x + m[2], m[4] * y + m[5]];
  }

  /** Output uv → client (CSS px). */
  outputToClient(u: number, v: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const m = this.canvasToOutput();
    return [rect.left + (u - m[2]) / m[0] / dpr, rect.top + (v - m[5]) / m[4] / dpr];
  }

  // ─── Frame ───────────────────────────────────────────────────────────────

  /** True while `frame` runs: a read-back during it is painted over by the frame itself. */
  private drawing = false;

  /**
   * After a read-back borrowed the canvas: paint the view again at once from what is
   * already rendered, before the browser shows the borrowed pixels. Anything that needs
   * rendering waits for the next frame (exports read back many times in a row).
   */
  private redrawNow() {
    if (this.drawing || this.lost) return;
    try {
      this.frame(false);
    } catch {
      this.requestRender();
    }
  }

  /** `render`: false repaints only from cached renders (else it schedules a frame). */
  private frame(render = true) {
    if (this.lost) return;
    this.drawing = true;
    try {
      this.drawFrame(render);
    } finally {
      this.drawing = false;
    }
  }

  private drawFrame(render: boolean) {
    if (this.mode === "composite") {
      if (this.compositeFrame(render)) this.onFrame?.();
      return;
    }
    const state = develop.getState();
    const { gl } = this.gpu;
    const src = state.assetId ? this.sources.get(state.assetId) : null;
    const recipe = this.displayRecipe();
    if (!src || !recipe) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const size = outputSize(src.gpu.size, recipe.geometry);
    const regions = this.regions();
    const scale = this.displayScale(size, regions[0]);
    const draft = currentHistory()?.status().editing ?? false;
    const quality = Math.min(1, scale) * (draft ? 0.5 : 1);
    const max = Math.min(this.gpu.maxTextureSize, 8192);
    let width = Math.max(1, Math.round(size.width * quality));
    let height = Math.max(1, Math.round(size.height * quality));
    const over = Math.max(width / max, height / max, 1);
    width = Math.round(width / over);
    height = Math.round(height / over);

    // Zoomed in: render only what the canvas shows (see `viewWindow`).
    const win = state.view.fit ? null : this.viewWindow(regions, width, height, state.compare === "side-by-side", DevelopPipeline.windowMargin(recipe, width, height));
    const window = win ? { x: win.x, y: win.y, fullWidth: width, fullHeight: height } : undefined;
    const renderSize = { width: win?.width ?? width, height: win?.height ?? height, window };
    const imageWindow = win ? [win.x / width, win.y / height, win.width / width, win.height / height] : [0, 0, 1, 1];

    const overlayMode = state.tool === "mask" && state.activeMaskId ? (state.maskBw ? 2 : state.maskOverlay ? 1 : 0) : 0;
    const content = [src.gpu, recipe, draft, state.activeMaskId, overlayMode > 0];
    const key = [...content, width, height, win?.x, win?.y, win?.width, win?.height];
    const beforeKey = [src.gpu, recipe.geometry, width, height, win?.x, win?.y, win?.width, win?.height];
    const comparing = state.compare !== "off" || state.peek;

    // Moving (pinch, pan, a glide): the same picture under a new mapping. Draw what is
    // rendered (the window, and the whole photo around it) and sharpen once it rests.
    if (this.result && !comparing && sameKey(this.result.content, content) && !sameKey(this.result.key, key) && performance.now() < this.motionUntil) {
      const overview = this.overview && sameKey(this.overview.content, content) ? this.overview.target : null;
      this.present(regions, recipe, this.result.target, this.result.window, null, overview, overlayMode);
      return;
    }

    const stale = !this.result || !sameKey(this.result.key, key) || (comparing && (!this.before || !sameKey(this.before.key, beforeKey)));
    if (!render && stale) return this.requestRender();
    if (!this.result || !sameKey(this.result.key, key)) {
      const previous = this.result;
      this.viewRender = true;
      const target = this.pipeline.render(src.gpu, recipe, { ...renderSize, draft, masks: this.masks });
      this.viewRender = false;
      this.result = { target, key, content, window: imageWindow };
      if (!previous) {
        // Nothing to keep.
      } else if (win && previous.window[2] === 1 && previous.window[3] === 1 && sameKey(previous.content, content)) {
        // Zooming in: the whole-photo render stays, to show around the window while moving.
        this.pipeline.release(this.overview?.target);
        this.overview = { target: previous.target, content };
      } else this.pipeline.release(previous.target);
      if (!win) {
        this.pipeline.release(this.overview?.target);
        this.overview = null;
      } else if (!this.overview || !sameKey(this.overview.content, content)) this.scheduleOverview();
      // A window shows part of the photo; the histogram is of all of it.
      if (!draft) this.scheduleHistogram(win ? { source: src.gpu, recipe } : null);
    }
    let beforeTarget: Target | null = null;
    if (state.compare !== "off" || state.peek) {
      if (!this.before || !sameKey(this.before.key, beforeKey)) {
        this.pipeline.release(this.before?.target);
        const target = this.pipeline.render(src.gpu, DevelopPipeline.beforeRecipe(recipe, src.gpu.info), { ...renderSize, draft });
        this.before = { target, key: beforeKey };
      }
      beforeTarget = this.before.target;
    }

    this.present(regions, recipe, this.result.target, imageWindow, beforeTarget, null, overlayMode);
  }

  /**
   * Draws the view: `image` holds the `window` part of the photo (uv), `overview` (if any)
   * all of it, shown where the window does not reach (while moving).
   */
  private present(regions: ReturnType<DevelopEngine["regions"]>, recipe: DevelopRecipe, image: Target, window: number[], beforeTarget: Target | null, overview: Target | null, overlayMode: number) {
    const state = develop.getState();
    const { gl } = this.gpu;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Transparent around the image: .develop-view paints the surround (or the glow backdrop shows through).
    const background = [0, 0, 0, 0];
    const overlay = this.maskRenderer.overlay?.target ?? null;
    const drawRegion = (region: (typeof regions)[number], shown: Target, split: boolean) => {
      const m = this.canvasToOutput(region);
      this.gpu.pass("display", S.display, {
        target: null,
        viewport: [0, 0, this.canvas.width, this.canvas.height],
        textures: { uImage: shown, uBefore: beforeTarget ?? shown, uOverlay: overlay, uOverview: overview ?? shown },
        uniforms: {
          uCanvasToImage: toGlMat3(m),
          uBackground: background,
          uClipping: state.clipping ? 1 : 0,
          uSplit: split ? 1 : 0,
          uSplitX: region.x + region.width * state.splitPosition,
          uCanvasSize: [this.canvas.width, this.canvas.height],
          uOverlayMode: overlay ? overlayMode : 0,
          uOverlayInvert: recipe.masks.find((m) => m.id === state.activeMaskId)?.invert ? 1 : 0,
          uImageWindow: window,
          uHasOverview: overview ? 1 : 0,
        },
      });
    };
    if (state.compare === "side-by-side" && beforeTarget) {
      gl.enable(gl.SCISSOR_TEST);
      for (const [i, region] of regions.entries()) {
        gl.scissor(region.x - 4, this.canvas.height - (region.y + region.height) - 4, region.width + 8, region.height + 8);
        drawRegion(region, i === 0 ? image : beforeTarget, false);
      }
      gl.disable(gl.SCISSOR_TEST);
    } else {
      // Held on the photo: the original in place of the edit.
      const shown = state.peek && beforeTarget && state.compare === "off" ? beforeTarget : image;
      drawRegion(regions[0], shown, state.compare === "split" && !!beforeTarget);
    }
    this.onFrame?.();
  }

  /**
   * Zoomed in after an edit: renders the whole photo again at the size it fits the view,
   * shortly after, for the next pinch or pan to show around the window.
   */
  private scheduleOverview() {
    clearTimeout(this.overviewTimer);
    this.overviewTimer = window.setTimeout(() => {
      const state = develop.getState();
      const result = this.result;
      const src = state.assetId ? this.sources.get(state.assetId) : null;
      const recipe = this.displayRecipe();
      if (!result || !src || !recipe || this.lost || this.mode !== "develop" || (result.window[2] === 1 && result.window[3] === 1)) return;
      if (currentHistory()?.status().editing) return this.scheduleOverview();
      if (this.overview && sameKey(this.overview.content, result.content)) return;
      const size = outputSize(src.gpu.size, recipe.geometry);
      const scale = Math.min(1, this.fitScale(size));
      const target = this.pipeline.render(src.gpu, recipe, { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), draft: result.content[2] as boolean, masks: this.masks });
      this.pipeline.release(this.overview?.target);
      this.overview = { target, content: result.content };
    }, 120);
  }

  /**
   * The part of a `width × height` view render that the canvas shows when zoomed in
   * (working px, top-left origin), with a margin for blurs (`DevelopPipeline.windowMargin`)
   * and snapped to a 128 px grid so small pans reuse the render. Null when most
   * of the photo is visible anyway. At 100 % a 4096 px photo on a phone shows about a
   * fifth of its pixels: every pass, the before image and the mask overlay shrink alike.
   */
  private viewWindow(regions: ReturnType<DevelopEngine["regions"]>, width: number, height: number, sideBySide: boolean, margin: number) {
    // The photo is drawn over the whole canvas (under floating panels too); side by side, each region is clipped.
    const rects = sideBySide ? regions.map((r) => ({ x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 })) : [{ x: 0, y: 0, width: this.canvas.width, height: this.canvas.height }];
    let u0 = 1;
    let v0 = 1;
    let u1 = 0;
    let v1 = 0;
    rects.forEach((rect, i) => {
      const m = this.canvasToOutput(sideBySide ? regions[i] : regions[0]);
      u0 = Math.min(u0, m[0] * rect.x + m[2]);
      v0 = Math.min(v0, m[4] * rect.y + m[5]);
      u1 = Math.max(u1, m[0] * (rect.x + rect.width) + m[2]);
      v1 = Math.max(v1, m[4] * (rect.y + rect.height) + m[5]);
    });
    u0 = Math.max(0, u0);
    v0 = Math.max(0, v0);
    u1 = Math.min(1, u1);
    v1 = Math.min(1, v1);
    if (u1 <= u0 || v1 <= v0 || (u1 - u0) * (v1 - v0) > 0.6) return null;
    const grid = 128;
    const x0 = Math.max(0, Math.floor((u0 * width - margin) / grid) * grid);
    const y0 = Math.max(0, Math.floor((v0 * height - margin) / grid) * grid);
    const x1 = Math.min(width, Math.ceil((u1 * width + margin) / grid) * grid);
    const y1 = Math.min(height, Math.ceil((v1 * height + margin) / grid) * grid);
    if ((x1 - x0) * (y1 - y0) > 0.75 * width * height) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  // ─── Composite ───────────────────────────────────────────────────────────

  /** Device pixels per document pixel in the composite view. */
  compositeScale(): number {
    const { doc, view } = composite.getState();
    if (!doc) return 1;
    return view.fit ? this.compositeFitScale() : view.zoom;
  }

  /** Height (device px) the document fits in: the canvas, less a panel floating over its bottom. */
  private compositeRoom(): number {
    return Math.max(1, this.canvas.height - this.cover * viewDpr());
  }

  compositeFitScale(): number {
    const { doc } = composite.getState();
    if (!doc) return 1;
    return this.compositeFitFor(doc.width, doc.height);
  }

  /** The scale that fits a `width × height` part of the document in the view (a carousel slide). */
  compositeFitFor(width: number, height: number): number {
    const pad = 40 * viewDpr();
    return Math.min((this.canvas.width - pad * 2) / width, (this.compositeRoom() - pad * 2) / height);
  }

  /** Screen device px → document px. */
  screenToDoc(): Mat3 {
    const { doc, view } = composite.getState();
    const s = this.compositeScale();
    if (!doc) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const cx = view.fit ? doc.width / 2 : view.centerX * doc.width;
    const cy = view.fit ? doc.height / 2 : view.centerY * doc.height;
    // The view centres in the part of the canvas a floating panel leaves free (phones):
    // layer handles reach the document's edges, so it fits whole above the panel.
    const screenY = this.compositeRoom() / 2;
    return [1 / s, 0, cx - this.canvas.width / 2 / s, 0, 1 / s, cy - screenY / s, 0, 0, 1];
  }

  clientToDoc(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const m = this.screenToDoc();
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;
    return { x: m[0] * x + m[2], y: m[4] * y + m[5] };
  }

  docToClient(x: number, y: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const m = this.screenToDoc();
    return { x: rect.left + (x - m[2]) / m[0] / dpr, y: rect.top + (y - m[5]) / m[4] / dpr };
  }

  private wholeWhileCropping = new WeakMap<CompositeDocument, { id: string; doc: CompositeDocument }>();
  /** The document as drawn: a photo being cropped shows whole (the crop tool dims what is cut away). */
  private shownDocument(doc: CompositeDocument | null): CompositeDocument | null {
    const { tool, selection } = composite.getState();
    const id = selection[selection.length - 1];
    if (!doc || tool !== "crop" || !id) return doc;
    const layer = locate(doc.layers, id)?.layer;
    if (!layer || (layer.kind !== "image" && layer.kind !== "slot")) return doc;
    const hit = this.wholeWhileCropping.get(doc);
    if (hit?.id === id) return hit.doc;
    const shown = updateLayer(doc, id, (l) => ({ ...l, crop: { left: 0, top: 0, right: 1, bottom: 1 } }));
    this.wholeWhileCropping.set(doc, { id, doc: shown });
    return shown;
  }

  /** Draws the composite view; false when it needed rendering and `render` was false (a frame is scheduled). */
  private compositeFrame(render = true): boolean {
    const { gl } = this.gpu;
    const doc = this.shownDocument(composite.getState().doc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!doc) return true;
    const scale = Math.min(this.compositeScale(), 1, 8192 / Math.max(doc.width, doc.height));
    const assets = catalog.getState().assets;
    const revisions = flatten(doc.layers).map((l) => {
      const id = layerAsset(l);
      return id ? `${id}:${assets.get(id)?.developRevision}:${this.sources.get(id)?.quality}` : "";
    });
    const time = this.viewTime(doc);
    const key = [doc, scale, revisions.join("|"), this.sources.size, time];
    if (!this.compositeResult || !sameKey(this.compositeResult.key, key)) {
      if (!render) {
        this.requestRender();
        return false;
      }
      this.pipeline.release(this.compositeResult?.target);
      this.compositeResult = { target: this.compositor.render(doc, scale, time), key };
    }
    this.gpu.pass("composite-display", CS.compositeDisplay, {
      target: null,
      textures: { uImage: this.compositeResult.target },
      uniforms: {
        uScreenToDoc: toGlMat3(this.screenToDoc()),
        uDocSize: [doc.width, doc.height],
        uCanvasSize: [this.canvas.width, this.canvas.height],
      },
    });
    return true;
  }

  /**
   * Animation time for the composite view, quantised to the document's frame
   * rate. While playing it schedules the next tick (outside `requestRender`, so
   * the activity bar stays quiet); a tick stops once nothing animates.
   */
  private viewTime(doc: CompositeDocument): number {
    if (!isAnimated(doc)) return 0;
    const { duration, fps } = docAnimation(doc);
    if (!composite.getState().playing || this.animationHolds > 0) return this.pausedTime;
    const elapsed = (performance.now() - this.animationStart) / 1000;
    const time = (Math.floor((elapsed % duration) * fps) / fps) % duration;
    this.pausedTime = time;
    if (!this.animationTick) {
      this.animationTick = window.setTimeout(() => {
        this.animationTick = 0;
        requestAnimationFrame(() => {
          if (this.mode !== "composite" || this.lost || this.frameRequested) return;
          try {
            this.frame();
          } catch (error) {
            console.error(error);
          }
        });
      }, 1000 / fps);
    }
    return time;
  }

  /** Freezes the live view animation (e.g. while exporting frames); call the returned function to resume. */
  holdAnimation(): () => void {
    this.animationHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.animationHolds--;
      this.animationStart = performance.now() - this.pausedTime * 1000;
      this.requestRender();
    };
  }

  /** The compositor for renders other than the view, kept while in use. */
  private offscreenCompositor(): Compositor {
    this.offscreen ??= this.createCompositor();
    clearTimeout(this.offscreenTimer);
    this.offscreenTimer = window.setTimeout(() => {
      this.offscreen?.dispose();
      this.offscreen = null;
    }, 5000);
    return this.offscreen;
  }

  /** Renders a document for export or thumbnails: display-encoded, straight alpha. */
  renderDocument(doc: CompositeDocument, scale: number, time = 0): ImageData {
    const target = this.offscreenCompositor().render(doc, scale, time);
    const out = this.pipeline.acquire(target.width, target.height, "rgba8");
    this.gpu.pass("unpremultiply", unpremultiply, { target: out, textures: { uInput: target } });
    const image = this.gpu.readImage(out);
    this.pipeline.release(out);
    this.pipeline.release(target);
    return image;
  }

  /**
   * Renders small previews of `effects` applied to `doc` (the layers the effect
   * would sit on), one at a time so the UI stays responsive. A newer call
   * cancels an older one. Returns object URLs the caller revokes.
   */
  async effectPreviews(source: CompositeDocument | ImageBitmap, longSide: number, effects: readonly EffectInstance[], onPreview: (index: number, url: string) => void): Promise<void> {
    const generation = ++this.previewGeneration;
    const end = beginActivity();
    try {
      if (source instanceof ImageBitmap) {
        const scale = Math.min(1, longSide / Math.max(source.width, source.height));
        const w = Math.max(1, Math.round(source.width * scale));
        const h = Math.max(1, Math.round(source.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext("2d")!.drawImage(source, 0, 0, w, h);
        const texture = this.gpu.texture(w, h, "rgba8", canvas);
        const base = this.pipeline.acquire(w, h);
        this.gpu.pass("preview-premultiply", premultiply, { target: base, textures: { uInput: texture } });
        this.gpu.dispose(texture);
        await this.runPreviews(generation, base, Math.max(w, h) / 1000, effects, onPreview);
      } else {
        await this.renderPreviews(generation, source, longSide, effects, onPreview);
      }
    } finally {
      end();
    }
  }

  private async renderPreviews(generation: number, doc: CompositeDocument, longSide: number, effects: readonly EffectInstance[], onPreview: (index: number, url: string) => void) {
    // Previews need the photos: wait (up to a minute) for every image layer to decode.
    const ids = documentAssets(doc.layers, true);
    for (let i = 0; i < 600 && ids.some((id) => !this.hasSource(id)); i++) {
      if (generation !== this.previewGeneration) return;
      for (const id of ids) this.ensureSource(id);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.lost || generation !== this.previewGeneration) return;
    const scale = Math.min(1, longSide / Math.max(doc.width, doc.height));
    const base = this.offscreenCompositor().render(doc, scale);
    await this.runPreviews(generation, base, (Math.max(doc.width, doc.height) * scale) / 1000, effects, onPreview);
  }

  /** Runs each effect on `base` (released at the end) and reports encoded previews. */
  private async runPreviews(generation: number, base: Target, unit: number, effects: readonly EffectInstance[], onPreview: (index: number, url: string) => void) {
    this.previewEffects ??= new EffectRunner(this.gpu, this.pipeline);
    const runner = this.previewEffects;
    const canvas = new OffscreenCanvas(base.width, base.height);
    const ctx = canvas.getContext("2d")!;
    try {
      for (let i = 0; i < effects.length; i++) {
        if (generation !== this.previewGeneration || this.lost) return;
        // Animated effects are shown mid-loop: at time 0 some are indistinguishable from the photo.
        const result = effectById(effects[i].id)?.animated ? runner.apply(base, effects[i], unit, 1.1, 3) : runner.apply(base, effects[i], unit);
        const out = this.pipeline.acquire(base.width, base.height, "rgba8");
        this.gpu.pass("unpremultiply", unpremultiply, { target: out, textures: { uInput: result } });
        const image = this.gpu.readImage(out);
        this.pipeline.release(out);
        this.pipeline.release(result);
        ctx.putImageData(image, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
        if (generation !== this.previewGeneration) return;
        onPreview(i, URL.createObjectURL(blob));
      }
    } finally {
      this.pipeline.release(base);
    }
  }

  /** Stops an in-flight `effectPreviews`. */
  cancelEffectPreviews() {
    this.previewGeneration++;
  }

  /** Releases cached GPU memory (idle targets, layer and effect caches); it is rebuilt on demand. */
  freeMemory() {
    this.pipeline.release(this.compositeResult?.target);
    this.compositeResult = null;
    this.compositor.dispose();
    this.offscreen?.dispose();
    this.offscreen = null;
    this.previewEffects?.dispose();
    this.previewEffects = null;
    this.pipeline.trim();
  }

  /**
   * Renders a full-size export and checks it: the result must look like a small
   * reference render of the same thing. Drivers that run out of memory can fail
   * silently and return blank or stale pixels; in that case caches are freed and
   * the render is retried once before giving up with a clear error.
   */
  private verifiedRender<T extends ImageData | OffscreenCanvas>(full: () => T, reference: () => ImageData): T {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.freeMemory();
      this.gpu.drainErrors();
      let pixels: T | null = null;
      try {
        pixels = full();
      } catch (error) {
        console.warn("Export render failed", error);
      }
      const failed = this.gpu.failed() || !pixels;
      this.freeMemory();
      if (!failed && pixels) {
        const ref = reference();
        if (similarImages(pixels instanceof ImageData ? pixels : smallCopy(pixels, 512), ref)) {
          this.requestRender();
          return pixels;
        }
        console.warn("Export render did not match its reference; retrying after freeing GPU memory.");
      }
      if (this.lost) break;
    }
    this.freeMemory();
    this.requestRender();
    throw new Error("The graphics card couldn't render this export correctly (it may be out of memory). Try a smaller size, or close other tabs and try again.");
  }

  /** Export of a composition at `time` seconds into its animation, verified (see `verifiedRender`). */
  exportDocument(doc: CompositeDocument, scale: number, time = 0): ImageData {
    const long = Math.max(doc.width, doc.height) * scale;
    if (long <= 640) return this.renderDocument(doc, scale, time);
    return this.verifiedRender(
      () => this.renderDocument(doc, scale, time),
      () => this.renderDocument(doc, (512 / long) * scale, time),
    );
  }

  /** Export of a developed photo, verified (see `verifiedRender`), in a canvas (see `renderCanvas`). */
  exportPixels(source: GpuSource, recipe: DevelopRecipe, longSide: number): OffscreenCanvas {
    if (longSide <= 640) return this.renderCanvas(source, recipe, longSide);
    return this.verifiedRender(
      () => this.renderCanvas(source, recipe, longSide),
      () => this.renderPixels(source, recipe, 512),
    );
  }

  /** True while any photo of the composition is still decoding. */
  get compositeLoading() {
    return this.loadingSources.size > 0;
  }

  /** Updates the histogram from the view render, or (`whole`: the view is a zoomed-in window) a small render of the whole photo. */
  private scheduleHistogram(whole: { source: GpuSource; recipe: DevelopRecipe } | null = null) {
    if (this.histogramTimer) clearTimeout(this.histogramTimer);
    // Not shown while the interface is hidden: worked out when it comes back (each one
    // waits for the GPU to finish the render, a pause in a pinch).
    if (this.immersive) {
      this.deferredHistogram = { whole };
      return;
    }
    this.histogramTimer = setTimeout(() => {
      this.histogramTimer = null;
      if (!this.result || this.lost) return;
      if (!whole) return develop.setState({ histogram: this.histogram(this.result.target) });
      const size = outputSize(whole.source.size, whole.recipe.geometry);
      const scale = Math.min(1, 320 / Math.max(size.width, size.height));
      const target = this.pipeline.render(whole.source, whole.recipe, { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), masks: this.masks });
      try {
        develop.setState({ histogram: this.histogram(target) });
      } finally {
        this.pipeline.release(target);
      }
    }, 60);
  }

  private histogram(target: Target): Histogram {
    const scale = Math.min(1, 320 / Math.max(target.width, target.height));
    const w = Math.max(1, Math.round(target.width * scale));
    const h = Math.max(1, Math.round(target.height * scale));
    const px = this.pipeline.encode(target, w, h);
    const r = new Uint32Array(256);
    const g = new Uint32Array(256);
    const b = new Uint32Array(256);
    const l = new Uint32Array(256);
    let high = 0;
    let low = 0;
    let count = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      count++;
      r[px[i]]++;
      g[px[i + 1]]++;
      b[px[i + 2]]++;
      l[Math.round(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722)]++;
      if (px[i] >= 255 || px[i + 1] >= 255 || px[i + 2] >= 255) high++;
      if (px[i] <= 0 && px[i + 1] <= 0 && px[i + 2] <= 0) low++;
    }
    return { r, g, b, l, clippedHigh: high / Math.max(1, count), clippedLow: low / Math.max(1, count) };
  }

  // ─── Derived images ──────────────────────────────────────────────────────

  private scheduleThumbnails() {
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null;
      void this.refreshThumbnails();
    }, 1500);
  }

  /** Re-renders the catalog thumbnail and preview of the open photo from its recipe. */
  async refreshThumbnails(assetId = develop.getState().assetId) {
    if (!assetId || this.lost) return;
    const src = this.sources.get(assetId);
    const asset = getAsset(assetId);
    if (!src || src.quality === "preview" || !asset) return;
    if (currentHistory()?.status().editing) {
      this.scheduleThumbnails();
      return;
    }
    const recipe = develop.getState().assetId === assetId ? develop.getState().recipe : null;
    if (!recipe) return;
    const revision = catalog.getState().assets.get(assetId)?.developRevision ?? 0;
    if (asset.thumbRevision === revision) return;
    // Cutouts keep their transparency in the Library.
    const type = recipe.masks.some((m) => m.cutout && m.visible) ? "image/webp" : "image/jpeg";
    const [thumb, preview] = await Promise.all([this.renderBlob(src.gpu, recipe, 480, type, 0.85), this.renderBlob(src.gpu, recipe, 2560, type, 0.88)]);
    await putThumb(assetId, { thumb, preview, previewSource: "developed", revision });
    const { invalidateImage } = await import("@/app/thumbs");
    invalidateImage(assetId);
    updateAsset(assetId, { thumbRevision: revision, thumbState: "ready" });
  }

  private thumbQueue: AssetId[] = [];
  private thumbWorking = false;

  /**
   * Re-renders the Library thumbnail and preview of photos whose edits changed without
   * being open in Develop (pasted edits), one at a time in the background. A photo not
   * already on the GPU is decoded, rendered and freed again, so memory stays flat.
   */
  refreshThumbnailsOf(ids: readonly AssetId[]) {
    for (const id of ids) if (!this.thumbQueue.includes(id)) this.thumbQueue.push(id);
    void this.drainThumbnails();
  }

  private async drainThumbnails() {
    if (this.thumbWorking) return;
    this.thumbWorking = true;
    const end = beginActivity();
    try {
      while (this.thumbQueue.length && !this.lost) {
        const id = this.thumbQueue.shift()!;
        // The open photo refreshes itself once its edit settles.
        if (id === develop.getState().assetId) {
          this.scheduleThumbnails();
          continue;
        }
        const asset = getAsset(id);
        const recipe = recipeFor(id);
        if (!asset || !recipe || asset.thumbRevision === asset.developRevision) continue;
        const revision = asset.developRevision;
        try {
          const kept = this.sources.get(id);
          let gpu = kept && kept.quality !== "preview" ? kept.gpu : null;
          let temporary: typeof gpu = null;
          if (!gpu) {
            const loaded = await loadSource(asset);
            if (this.lost) break;
            try {
              gpu = temporary = this.pipeline.upload(id, loaded.data, loaded.info);
            } finally {
              releaseDecoded(loaded);
            }
          }
          const type = recipe.masks.some((m) => m.cutout && m.visible) ? "image/webp" : "image/jpeg";
          try {
            const thumb = await this.renderBlob(gpu, recipe, 480, type, 0.85);
            const preview = await this.renderBlob(gpu, recipe, 2560, type, 0.88);
            await putThumb(id, { thumb, preview, previewSource: "developed", revision });
          } finally {
            if (temporary) this.pipeline.disposeSource(temporary);
          }
          const { invalidateImage } = await import("@/app/thumbs");
          invalidateImage(id);
          updateAsset(id, { thumbRevision: revision, thumbState: "ready" });
        } catch (error) {
          console.warn(`Could not update the thumbnail of ${asset.fileName}`, error);
        }
      }
    } finally {
      this.thumbWorking = false;
      end();
    }
  }

  /**
   * Re-renders developed thumbnails saved before readback moved to the canvas path
   * (on some GPUs those came out blank or wrong). Runs once per catalog, in the background.
   */
  async repairThumbnails() {
    const flag = "thumbs-readback-v2";
    if (await getSetting(flag)) return;
    const { invalidateImage } = await import("@/app/thumbs");
    for (const asset of [...catalog.getState().assets.values()]) {
      const record = await getThumb(asset.id);
      const recipe = recipeFor(asset.id);
      if (record?.previewSource !== "developed" || !recipe || this.lost) continue;
      try {
        if (!this.hasSource(asset.id) || this.hasSource(asset.id, "preview")) {
          const loaded = await loadSource(asset);
          this.setSource(asset.id, loaded, loaded.quality);
        }
        const src = this.sources.get(asset.id)!.gpu;
        const type = recipe.masks.some((m) => m.cutout && m.visible) ? "image/webp" : "image/jpeg";
        const thumb = await this.renderBlob(src, recipe, 480, type, 0.85);
        const preview = await this.renderBlob(src, recipe, 2560, type, 0.88);
        await putThumb(asset.id, { thumb, preview, previewSource: "developed", revision: record.revision });
        invalidateImage(asset.id);
      } catch (error) {
        console.warn(`Could not repair the thumbnail of ${asset.fileName}`, error);
      }
    }
    await putSetting(flag, true);
  }

  /** Renders a recipe to an encoded image whose long side is at most `longSide`. */
  async renderBlob(source: GpuSource, recipe: DevelopRecipe, longSide: number, type: string, quality: number, background?: string): Promise<Blob> {
    return encodePixels(this.renderCanvas(source, recipe, longSide), type, quality, background, undefined, undefined, isOpaque(recipe));
  }

  /**
   * Renders a recipe into a canvas (straight alpha, display-encoded) whose long side is at
   * most `longSide`. Large renders are made in tiles (`RenderOptions.window`, with a margin
   * for blurs, so tiles join seamlessly): a phone renders a 4096 px export as 1536 px
   * tiles instead of the whole photo through every pass at once, and each tile goes
   * straight into the canvas, the only full-size copy on the CPU.
   */
  renderCanvas(source: GpuSource, recipe: DevelopRecipe, longSide: number): OffscreenCanvas {
    const size = outputSize(source.size, recipe.geometry);
    const scale = Math.min(1, longSide / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    // Tiles and margins are multiples of 64 px (see `DevelopPipeline.windowMargin`).
    const tile = device.lite ? 1536 : 4096;
    if (width * height <= tile * tile * 1.5) {
      const target = this.pipeline.render(source, recipe, { width, height, masks: this.masks });
      try {
        ctx.putImageData(this.pipeline.encodeImage(target), 0, 0);
      } finally {
        this.pipeline.release(target);
      }
      return canvas;
    }
    const margin = DevelopPipeline.windowMargin(recipe, width, height);
    for (let ty = 0; ty < height; ty += tile)
      for (let tx = 0; tx < width; tx += tile) {
        const x0 = Math.max(0, tx - margin);
        const y0 = Math.max(0, ty - margin);
        const x1 = Math.min(width, tx + tile + margin);
        const y1 = Math.min(height, ty + tile + margin);
        const target = this.pipeline.render(source, recipe, { width: x1 - x0, height: y1 - y0, masks: this.masks, window: { x: x0, y: y0, fullWidth: width, fullHeight: height } });
        try {
          const pixels = this.pipeline.encodeImage(target);
          // Only the tile itself: its margin overlaps the neighbours.
          ctx.putImageData(pixels, x0, y0, tx - x0, ty - y0, Math.min(tile, width - tx), Math.min(tile, height - ty));
        } finally {
          this.pipeline.release(target);
        }
      }
    return canvas;
  }

  renderPixels(source: GpuSource, recipe: DevelopRecipe, longSide: number): ImageData {
    const size = outputSize(source.size, recipe.geometry);
    const scale = Math.min(1, longSide / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const target = this.pipeline.render(source, recipe, { width, height, masks: this.masks });
    try {
      return this.pipeline.encodeImage(target);
    } finally {
      this.pipeline.release(target);
    }
  }
}

/**
 * Encodes export pixels: flattened for JPEG (no alpha), then framed and
 * watermarked (`composeExport`; the watermark sits inside the frame).
 */
export async function encodePixels(pixels: ImageData | OffscreenCanvas, type: string, quality: number, background?: string, watermark?: Watermark, frame?: ExportFrame, opaque = false): Promise<Blob> {
  let canvas: OffscreenCanvas;
  if (pixels instanceof OffscreenCanvas) canvas = pixels;
  else {
    canvas = new OffscreenCanvas(pixels.width, pixels.height);
    canvas.getContext("2d")!.putImageData(pixels, 0, 0);
  }
  const flatten = (src: OffscreenCanvas) => {
    // JPEG has no alpha: flatten against the chosen background.
    const flat = new OffscreenCanvas(src.width, src.height);
    const fctx = flat.getContext("2d")!;
    fctx.fillStyle = background ?? "#ffffff";
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(src, 0, 0);
    return flat;
  };
  // An opaque image needs no flattening (one full-size copy fewer).
  let out = type === "image/jpeg" && !opaque ? flatten(canvas) : canvas;
  if (watermark?.enabled || frame?.enabled) {
    if (watermark?.enabled) await loadFonts([watermarkFont(watermark)]);
    out = composeExport(out, frame, watermark);
    if (type === "image/jpeg" && frame?.enabled) out = flatten(out);
  }
  return out.convertToBlob({ type, quality });
}

const unpremultiply = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vUv);
  outColor = vec4(c.a > 0.0 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

/** True when a recipe leaves every pixel opaque (no cutout). */
export const isOpaque = (recipe: DevelopRecipe) => !recipe.masks.some((m) => m.cutout && m.visible);

/** A small copy of a canvas's pixels (for comparing renders). */
function smallCopy(canvas: OffscreenCanvas, longSide: number): ImageData {
  const scale = Math.min(1, longSide / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = new OffscreenCanvas(w, h);
  const ctx = small.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** How long the view must rest after moving before it is rendered sharp again. */
const SETTLE_MS = 140;
/** The photo's glide into and out of the tap-to-hide view. */
const GLIDE_MS = 260;

function sameKey(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

let engine: DevelopEngine | null = null;
export function developEngine() {
  engine ??= new DevelopEngine();
  return engine;
}

const premultiply = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vUv);
  outColor = vec4(c.rgb * c.a, c.a);
}`;

