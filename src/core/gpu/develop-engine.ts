import { putThumb } from "@/core/catalog/db";
import { catalog, getAsset, updateAsset } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { fullCrop } from "@/core/develop/defaults";
import { outputSize, type Size } from "@/core/develop/geometry";
import type { DevelopRecipe } from "@/core/develop/recipe";
import { currentHistory, develop, type Histogram } from "@/core/develop/session";
import type { LoadedSource } from "@/core/develop/source-loader";
import { type Mat3, toGlMat3 } from "@/lib/math";
import { Gpu, type Target } from "./gl";
import { getRaster } from "@/core/catalog/db";
import { MaskRenderer } from "./masks";
import { DevelopPipeline, type GpuSource, type MaskStage } from "./pipeline";
import * as S from "./shaders/passes";

type Loaded = { gpu: GpuSource; quality: "preview" | "raw" | "rendered"; data: LoadedSource };

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
  private result: { target: Target; key: unknown[] } | null = null;
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

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "develop-canvas";
    this.gpu = new Gpu(this.canvas);
    this.pipeline = new DevelopPipeline(this.gpu);
    this.maskRenderer = this.createMaskRenderer();
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
    develop.subscribe((s, prev) => {
      if (s.recipe !== prev.recipe || s.view !== prev.view || s.compare !== prev.compare || s.splitPosition !== prev.splitPosition || s.clipping !== prev.clipping || s.assetId !== prev.assetId || s.tool !== prev.tool || s.activeMaskId !== prev.activeMaskId || s.maskOverlay !== prev.maskOverlay || s.maskBw !== prev.maskBw)
        this.requestRender();
      if (s.recipe !== prev.recipe && s.assetId === prev.assetId) this.scheduleThumbnails();
    });
  }

  get pipelineRef() {
    return this.pipeline;
  }

  private createMaskRenderer() {
    const renderer = new MaskRenderer(this.gpu, getRaster);
    renderer.onRasterLoaded = () => {
      this.invalidate();
      this.requestRender();
    };
    return renderer;
  }

  private restore() {
    this.gpu = new Gpu(this.canvas);
    this.pipeline = new DevelopPipeline(this.gpu);
    this.maskRenderer = this.createMaskRenderer();
    this.result = this.before = null;
    const sources = [...this.sources.entries()];
    this.sources.clear();
    for (const [id, loaded] of sources) this.setSource(id, loaded.data, loaded.quality);
    this.lost = false;
    this.requestRender();
  }

  attach(container: HTMLElement) {
    container.appendChild(this.canvas);
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
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(container.clientWidth * dpr));
    const h = Math.max(1, Math.round(container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${container.clientWidth}px`;
      this.canvas.style.height = `${container.clientHeight}px`;
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

  setSource(assetId: AssetId, data: LoadedSource, quality: Loaded["quality"]) {
    const old = this.sources.get(assetId);
    const gpu = this.pipeline.upload(assetId, data.data, data.info);
    if (data.data.kind === "image" && "close" in data.data.image && quality !== "preview") {
      // Keep nothing on the CPU for rendered files; RAW data stays for context-loss recovery.
    }
    this.sources.set(assetId, { gpu, quality, data });
    if (old) this.pipeline.disposeSource(old.gpu);
    // Keep at most two decoded photos on the GPU.
    for (const id of [...this.sources.keys()]) {
      if (this.sources.size <= 2) break;
      if (id !== assetId && id !== develop.getState().assetId) {
        this.pipeline.disposeSource(this.sources.get(id)!.gpu);
        this.sources.delete(id);
      }
    }
    this.invalidate();
    this.requestRender();
  }

  invalidate() {
    this.pipeline.release(this.result?.target);
    this.pipeline.release(this.before?.target);
    this.result = this.before = null;
  }

  requestRender() {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      try {
        this.frame();
      } catch (error) {
        console.error(error);
        develop.setState({ error: error instanceof Error ? error.message : String(error) });
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

  /** Canvas regions (device px) the photo is drawn into: one, or two for side-by-side. */
  regions(): { x: number; y: number; width: number; height: number }[] {
    const pad = Math.round(16 * (window.devicePixelRatio || 1));
    const w = this.canvas.width;
    const h = this.canvas.height;
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

  private frame() {
    if (this.lost) return;
    const state = develop.getState();
    const { gl } = this.gpu;
    const src = state.assetId ? this.sources.get(state.assetId) : null;
    const recipe = this.displayRecipe();
    if (!src || !recipe) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.05, 0.05, 0.05, 1);
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

    const overlayMode = state.tool === "mask" && state.activeMaskId ? (state.maskBw ? 2 : state.maskOverlay ? 1 : 0) : 0;
    const key = [src.gpu, recipe, width, height, draft, state.activeMaskId, overlayMode > 0];
    if (!this.result || !sameKey(this.result.key, key)) {
      this.pipeline.release(this.result?.target);
      this.viewRender = true;
      const target = this.pipeline.render(src.gpu, recipe, { width, height, draft, masks: this.masks });
      this.viewRender = false;
      this.result = { target, key };
      if (!draft) this.scheduleHistogram();
    }
    let beforeTarget: Target | null = null;
    if (state.compare !== "off") {
      const beforeKey = [src.gpu, recipe.geometry, width, height];
      if (!this.before || !sameKey(this.before.key, beforeKey)) {
        this.pipeline.release(this.before?.target);
        const target = this.pipeline.render(src.gpu, DevelopPipeline.beforeRecipe(recipe, src.gpu.info), { width, height, draft });
        this.before = { target, key: beforeKey };
      }
      beforeTarget = this.before.target;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.05, 0.05, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const background = [0.05, 0.05, 0.05];
    const drawRegion = (region: (typeof regions)[number], image: Target, split: boolean) => {
      const m = this.canvasToOutput(region);
      this.gpu.pass("display", S.display, {
        target: null,
        viewport: [0, 0, this.canvas.width, this.canvas.height],
        textures: { uImage: image, uBefore: beforeTarget ?? image, uOverlay: overlay },
        uniforms: {
          uCanvasToImage: toGlMat3(m),
          uBackground: background,
          uClipping: state.clipping ? 1 : 0,
          uSplit: split ? 1 : 0,
          uSplitX: region.x + region.width * state.splitPosition,
          uCanvasSize: [this.canvas.width, this.canvas.height],
          uOverlayMode: overlay ? overlayMode : 0,
          uOverlayInvert: recipe.masks.find((m) => m.id === state.activeMaskId)?.invert ? 1 : 0,
        },
      });
    };
    const overlay = this.maskRenderer.overlay?.target ?? null;
    const { gl: g } = this.gpu;
    if (state.compare === "side-by-side" && beforeTarget) {
      g.enable(g.SCISSOR_TEST);
      for (const [i, region] of regions.entries()) {
        g.scissor(region.x - 4, this.canvas.height - (region.y + region.height) - 4, region.width + 8, region.height + 8);
        drawRegion(region, i === 0 ? this.result.target : beforeTarget, false);
      }
      g.disable(g.SCISSOR_TEST);
    } else {
      drawRegion(regions[0], this.result.target, state.compare === "split" && !!beforeTarget);
    }
    this.onFrame?.();
  }

  private scheduleHistogram() {
    if (this.histogramTimer) clearTimeout(this.histogramTimer);
    this.histogramTimer = setTimeout(() => {
      this.histogramTimer = null;
      if (!this.result || this.lost) return;
      develop.setState({ histogram: this.histogram(this.result.target) });
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

  /** Renders a recipe to an encoded image whose long side is at most `longSide`. */
  async renderBlob(source: GpuSource, recipe: DevelopRecipe, longSide: number, type: string, quality: number, background?: string): Promise<Blob> {
    const pixels = this.renderPixels(source, recipe, longSide);
    return encodePixels(pixels, type, quality, background);
  }

  renderPixels(source: GpuSource, recipe: DevelopRecipe, longSide: number): ImageData {
    const size = outputSize(source.size, recipe.geometry);
    const scale = Math.min(1, longSide / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const target = this.pipeline.render(source, recipe, { width, height, masks: this.masks });
    const data = this.pipeline.encode(target);
    this.pipeline.release(target);
    return new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer), width, height);
  }
}

export async function encodePixels(pixels: ImageData, type: string, quality: number, background?: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(pixels, 0, 0);
  if (type === "image/jpeg") {
    // JPEG has no alpha: flatten against the chosen background.
    const flat = new OffscreenCanvas(pixels.width, pixels.height);
    const fctx = flat.getContext("2d")!;
    fctx.fillStyle = background ?? "#ffffff";
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(canvas, 0, 0);
    return flat.convertToBlob({ type, quality });
  }
  return canvas.convertToBlob({ type, quality });
}

function sameKey(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

let engine: DevelopEngine | null = null;
export function developEngine() {
  engine ??= new DevelopEngine();
  return engine;
}
