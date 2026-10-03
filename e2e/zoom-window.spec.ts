import { expect, test } from "@playwright/test";

/**
 * Zoomed in, Develop renders only the part of the photo on screen (plus a margin for
 * blurs). That part must look exactly like the same part of a render of the whole
 * photo: grain, vignette, local contrast, dehaze and masks are all positioned in the
 * whole photo's coordinates.
 */
test("a zoomed-in window renders like the same part of the whole photo", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false })));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(2400, 1600);
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 2400, 1600);
    gr.addColorStop(0, "#1c2a48");
    gr.addColorStop(0.5, "#b07040");
    gr.addColorStop(1, "#e8e0c8");
    g.fillStyle = gr;
    g.fillRect(0, 0, 2400, 1600);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `hsl(${i * 37} 70% ${30 + (i % 5) * 10}%)`;
      g.fillRect((i * 173) % 2300, (i * 97) % 1500, 90, 60);
    }
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "scene.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click();
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 30_000 });

  const result = await page.evaluate(async () => {
    const { develop, editRecipe } = await import("/src/core/develop/session.ts" as string);
    const { addMask } = await import("/src/core/develop/masks.ts" as string);
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    editRecipe("Look", (r: any) => {
      let next = {
        ...r,
        basic: { ...r.basic, exposure: 0.4, clarity: 40, texture: 25, dehaze: 30, contrast: 20 },
        detail: { ...r.detail, sharpenAmount: 60, noiseLuminance: 30 },
        effects: { ...r.effects, vignetteAmount: -40, grainAmount: 50 },
      };
      const radial = addMask(next, { kind: "radial", center: { x: 0.6, y: 0.4 }, radiusX: 0.25, radiusY: 0.2, angle: 0, feather: 50 }, "Radial");
      next = { ...radial.recipe, masks: radial.recipe.masks.map((m: any) => (m.id === radial.mask.id ? { ...m, adjustments: { ...m.adjustments, exposure: 1 } } : m)) };
      const points = Array.from({ length: 50 }, (_, i) => [0.3 + i * 0.008, 0.6 + Math.sin(i / 6) * 0.1, 1]);
      const brush = addMask(next, { kind: "brush", strokes: [{ points, size: 0.06, feather: 0.5, flow: 1, density: 1, mode: "paint" }] }, "Brush");
      return { ...brush.recipe, masks: brush.recipe.masks.map((m: any) => (m.id === brush.mask.id ? { ...m, adjustments: { ...m.adjustments, saturation: -80 } } : m)) };
    });
    const engine = developEngine();
    const pipeline = engine.pipelineRef;
    const source = engine.sourceFor(develop.getState().assetId);
    const recipe = develop.getState().recipe;
    const W = 2400;
    const H = 1600;
    const whole = pipeline.render(source, recipe, { width: W, height: H, masks: engine.masks });
    const all = pipeline.encode(whole);
    pipeline.release(whole);
    const win = { x: 1152, y: 384, width: 768, height: 640 };
    const part = pipeline.render(source, recipe, { width: win.width, height: win.height, masks: engine.masks, window: { x: win.x, y: win.y, fullWidth: W, fullHeight: H } });
    const some = pipeline.encode(part);
    pipeline.release(part);
    // Compare the part of the window the view shows: inside its blur margin.
    const margin = Math.ceil(0.06 * W) + 8;
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let y = margin; y < win.height - margin; y++)
      for (let x = margin; x < win.width - margin; x++)
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(some[(y * win.width + x) * 4 + c] - all[((win.y + y) * W + win.x + x) * 4 + c]);
          max = Math.max(max, d);
          sum += d;
          n++;
        }
    return { max, mean: sum / n };
  });
  // Identical up to rounding and the blurs' far tails.
  expect(result.mean).toBeLessThan(0.6);
  expect(result.max).toBeLessThanOrEqual(6);

  // On screen at 100 %: the view renders a window, and it shows the same picture as a full render would.
  const shot = async () => page.locator("canvas.develop-canvas").screenshot();
  await page.evaluate(async () => {
    const { develop } = await import("/src/core/develop/session.ts" as string);
    develop.setState({ view: { fit: false, zoom: 1, centerX: 0.55, centerY: 0.45 } });
  });
  await page.waitForTimeout(600);
  const windowed = await shot();
  const sizes = await page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const e = developEngine() as any;
    const windowSize = [e.result.target.width, e.result.target.height];
    // The same view without windowing.
    e.viewWindow = () => null;
    e.invalidate();
    e.requestRender();
    await new Promise((r) => setTimeout(r, 600));
    return { windowSize, fullSize: [e.result.target.width, e.result.target.height] };
  });
  const full = await shot();
  expect(sizes.windowSize[0] * sizes.windowSize[1]).toBeLessThan(0.6 * sizes.fullSize[0] * sizes.fullSize[1]);
  const diff = await page.evaluate(
    async ({ a, b }) => {
      const load = async (s: string) => {
        const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
        const c = new OffscreenCanvas(bm.width, bm.height);
        const g = c.getContext("2d")!;
        g.drawImage(bm, 0, 0);
        return g.getImageData(0, 0, bm.width, bm.height).data;
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
      return sum / x.length;
    },
    { a: windowed.toString("base64"), b: full.toString("base64") },
  );
  expect(diff).toBeLessThan(0.8);
});
