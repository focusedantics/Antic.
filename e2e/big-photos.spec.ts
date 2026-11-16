import { expect, type Page, test } from "@playwright/test";
import { testDng } from "../tests/fixtures/dng";

/**
 * Camera RAWs bigger than the GPU can hold in one texture (this browser's limit is 8192 px),
 * placed in a design. They used to show black, and a 60-megapixel RAW took a gigabyte of
 * GPU memory to place; a GPU that runs out must come back rather than leave a black page.
 */
async function openDesignWithRaw(page: Page) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
  await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Photo from device" }).click()]);
  await chooser.setFiles({ name: "wide.dng", mimeType: "image/x-adobe-dng", buffer: testDng(8400, 1400) });
  await expect.poll(() => source(page), { timeout: 60_000 }).not.toBeNull();
}

/** The design's photo on the GPU: its working width and the long side it was capped at. */
const source = (page: Page) =>
  page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const { catalog } = await import("/src/core/catalog/store.ts" as string);
    const id = [...catalog.getState().assets.keys()][0];
    const s = (developEngine() as unknown as { sources: Map<string, { gpu: { base: { width: number } }; quality: string; maxSide: number }> }).sources.get(id);
    return s && s.quality !== "preview" ? { width: s.gpu.base.width, maxSide: s.maxSide } : null;
  });

/** The mean brightness of the design as rendered (0–255): a black photo reads near 0. */
const brightness = (page: Page) =>
  page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const { composite } = await import("/src/core/document/session.ts" as string);
    const image = developEngine().renderDocument(composite.getState().doc, 0.25) as ImageData;
    let sum = 0;
    for (let i = 0; i < image.data.length; i += 4) sum += (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
    return sum / (image.data.length / 4);
  });

test("a RAW wider than the GPU's largest texture shows in a design, from a smaller copy; Develop opens it in full", async ({ page }) => {
  await openDesignWithRaw(page);
  // The design works from a copy capped at 6144 px, and the photo is drawn, not black.
  expect(await source(page)).toMatchObject({ maxSide: 6144 });
  expect((await source(page))!.width).toBeLessThanOrEqual(6144);
  await expect.poll(() => brightness(page), { timeout: 20_000 }).toBeGreaterThan(60);

  // Develop decodes it again in full (as much as this GPU holds in one texture).
  await page.getByRole("button", { name: "Open in Develop" }).click();
  await expect.poll(async () => (await source(page))?.maxSide, { timeout: 60_000 }).toBe(Number.POSITIVE_INFINITY);
  const max = await page.evaluate(() => document.createElement("canvas").getContext("webgl2")!.getParameter(WebGL2RenderingContext.MAX_TEXTURE_SIZE) as number);
  expect((await source(page))!.width).toBe(Math.min(8400, max));
});

test("when the GPU is lost, the design comes back with photos smaller, and says so", async ({ page }) => {
  await openDesignWithRaw(page);
  await expect.poll(() => brightness(page), { timeout: 20_000 }).toBeGreaterThan(60);
  await page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const canvas = (developEngine() as unknown as { canvas: HTMLCanvasElement }).canvas;
    const lose = canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    lose.loseContext();
    setTimeout(() => lose.restoreContext(), 300);
  });
  await expect(page.getByText(/graphics card ran out of memory/)).toBeVisible();
  await expect.poll(async () => (await source(page))?.maxSide, { timeout: 60_000 }).toBe(4096);
  await expect.poll(() => brightness(page), { timeout: 20_000 }).toBeGreaterThan(60);
});

test("an error while drawing shows a message and a reload button, not a black page", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
  await page.goto("/");
  // Make one render throw: the library's photo count is read while drawing.
  await page.evaluate(async () => {
    const { catalog } = await import("/src/core/catalog/store.ts" as string);
    catalog.setState({ assets: null });
  });
  await expect(page.getByRole("alert")).toContainText("Something went wrong");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});

test.describe("iPhone", () => {
  test.use({
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });

  test("a 48-megapixel ProRAW goes into a design from its preview, without decoding the RAW", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("crash", () => errors.push("crashed"));
    await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
    await page.goto("/");
    // A ProRAW: linear RAW tags for 8064 × 6048, and the embedded JPEG preview every ProRAW carries.
    const jpeg = await page.evaluate(async () => {
      const c = new OffscreenCanvas(2016, 1512);
      const g = c.getContext("2d")!;
      const sky = g.createLinearGradient(0, 0, 0, 1512);
      sky.addColorStop(0, "#2f7dd1");
      sky.addColorStop(1, "#bfe3ff");
      g.fillStyle = sky;
      g.fillRect(0, 0, 2016, 1512);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const proraw = testDng(8064, 6048, { linear: true, pixels: false, previewIfd: true, preview: Buffer.from(jpeg, "base64") });
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("button", { name: /^Instagram post 1080/ }).tap();
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Add" }).tap();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("sheet").getByRole("button", { name: "Photo from device" }).tap()]);
    await chooser.setFiles({ name: "IMG_0175.DNG", mimeType: "image/x-adobe-dng", buffer: proraw });

    // Drawn from the 2016 px preview (the file holds no pixels LibRaw could have decoded), and drawn.
    await expect.poll(() => source(page), { timeout: 60_000 }).toMatchObject({ width: 2016 });
    await expect.poll(() => brightness(page), { timeout: 20_000 }).toBeGreaterThan(80);
    expect(errors).toEqual([]);

    // Develop says it is editing the preview.
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Layers" }).tap();
    await page.getByTestId("sheet").getByRole("button", { name: "Open in Develop" }).tap();
    await expect(page.getByText(/too large to decode on a phone/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Got it" }).tap();
    await expect(page.getByText(/too large to decode on a phone/)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("a RAW drawn from its preview keeps its colours and shape, and an edit is applied once, after a reload too", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
    await page.goto("/");
    await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
    await page.reload();
    // The camera's preview: orange on the left half, teal on the right (so a crop or a stretch shows).
    const jpeg = await page.evaluate(async () => {
      const c = new OffscreenCanvas(2016, 1512);
      const g = c.getContext("2d")!;
      g.fillStyle = "#d08030";
      g.fillRect(0, 0, 1008, 1512);
      g.fillStyle = "#2090a0";
      g.fillRect(1008, 0, 1008, 1512);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const proraw = testDng(8064, 6048, { linear: true, pixels: false, previewIfd: true, preview: Buffer.from(jpeg, "base64") });
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("button", { name: /^Instagram post 1080/ }).tap();
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Add" }).tap();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("sheet").getByRole("button", { name: "Photo from device" }).tap()]);
    await chooser.setFiles({ name: "IMG_0175.DNG", mimeType: "image/x-adobe-dng", buffer: proraw });
    await expect.poll(() => source(page), { timeout: 60_000 }).toMatchObject({ width: 2016 });

    // The photo developed by itself (as Develop, the Library and a design all draw it):
    // the mean colour of its left and right halves, and its size.
    const developed = () =>
      page.evaluate(async () => {
        const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
        const { catalog } = await import("/src/core/catalog/store.ts" as string);
        const { recipeFor } = await import("/src/core/develop/session.ts" as string);
        const id = [...catalog.getState().assets.keys()][0];
        const engine = developEngine();
        const canvas = engine.renderCanvas(engine.sourceFor(id), recipeFor(id), 400) as OffscreenCanvas;
        const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        const mean = (x0: number, x1: number) => {
          const sum = [0, 0, 0];
          let n = 0;
          for (let y = 20; y < canvas.height - 20; y += 4)
            for (let x = x0; x < x1; x += 4) {
              const i = (y * canvas.width + x) * 4;
              sum[0] += data[i];
              sum[1] += data[i + 1];
              sum[2] += data[i + 2];
              n++;
            }
          return sum.map((v) => Math.round(v / n));
        };
        return { left: mean(20, canvas.width / 2 - 20), right: mean(canvas.width / 2 + 20, canvas.width - 20), width: canvas.width, height: canvas.height };
      });
    const near = (got: number[], want: number[], within: number) => got.every((v, i) => Math.abs(v - want[i]) <= within);
    const first = await developed();
    // The preview's own colours (#d08030, #2090a0), not a colour cast; 4:3, not stretched.
    expect(near(first.left, [208, 128, 48], 12), `left ${first.left}`).toBe(true);
    expect(near(first.right, [32, 144, 160], 12), `right ${first.right}`).toBe(true);
    expect(first.width / first.height).toBeCloseTo(4 / 3, 1);

    // An edit in Develop: a stop brighter, and cropped to half the width.
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Layers" }).tap();
    await page.getByTestId("sheet").getByRole("button", { name: "Open in Develop" }).tap();
    await page.getByRole("button", { name: "Got it" }).tap();
    await page.evaluate(async () => {
      const { editRecipe } = await import("/src/core/develop/session.ts" as string);
      editRecipe("Edit", (r: any) => ({ ...r, basic: { ...r.basic, exposure: 1 }, geometry: { ...r.geometry, crop: { ...r.geometry.crop, x: 0, y: 0, width: 0.5, height: 1 } } }));
    });
    const edited = await developed();
    expect(edited.left[0]).toBeGreaterThan(first.left[0] + 10);
    // Half as wide: 2:3 now.
    expect(edited.height / edited.width).toBeCloseTo(1.5, 1);

    // Its Library preview is made from that; the camera's own preview stays beside it.
    const kept = await page.evaluate(async () => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const { catalog, flush } = await import("/src/core/catalog/store.ts" as string);
      const { getThumb } = await import("/src/core/catalog/db.ts" as string);
      const id = [...catalog.getState().assets.keys()][0];
      await new Promise((r) => setTimeout(r, 1200)); // the recipe is saved a moment after the edit
      await developEngine().refreshThumbnails(id);
      await flush();
      const record = await getThumb(id);
      const size = async (b?: Blob) => (b ? (({ width, height }) => ({ width, height }))(await createImageBitmap(b)) : null);
      return { source: record.previewSource, preview: await size(record.preview), base: await size(record.base) };
    });
    expect(kept.source).toBe("developed");
    expect(kept.preview!.height / kept.preview!.width).toBeCloseTo(1.5, 1);
    expect(kept.base).toEqual({ width: 2016, height: 1512 });

    // After a reload the photo is drawn from the camera's preview again, not from the
    // developed one: the same picture, not brighter and cropped a second time.
    await page.reload();
    await page.evaluate(async () => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const { catalog } = await import("/src/core/catalog/store.ts" as string);
      for (let i = 0; i < 100 && !catalog.getState().assets.size; i++) await new Promise((r) => setTimeout(r, 50));
      developEngine().ensureSource([...catalog.getState().assets.keys()][0]);
    });
    await expect.poll(() => source(page), { timeout: 60_000 }).toMatchObject({ width: 2016 });
    const again = await developed();
    expect(near(again.left, edited.left, 6), `left ${again.left} was ${edited.left}`).toBe(true);
    expect(near(again.right, edited.right, 6), `right ${again.right} was ${edited.right}`).toBe(true);
    expect(again.width).toBe(edited.width);
    expect(again.height).toBe(edited.height);
  });

  test("a RAW whose Library preview was spoiled gets the camera's preview back, once", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
    await page.goto("/");
    await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
    await page.reload();
    const jpeg = await page.evaluate(async () => {
      const c = new OffscreenCanvas(2016, 1512);
      const g = c.getContext("2d")!;
      g.fillStyle = "#30a050";
      g.fillRect(0, 0, 2016, 1512);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const proraw = testDng(8064, 6048, { linear: true, pixels: false, previewIfd: true, preview: Buffer.from(jpeg, "base64") });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import photos", exact: true }).tap()]);
    await chooser.setFiles({ name: "IMG_0200.DNG", mimeType: "image/x-adobe-dng", buffer: proraw });
    await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });

    // As the fault left it: a developed preview of the wrong colour and shape, and nothing else.
    await page.evaluate(async () => {
      const { putThumb, putSetting } = await import("/src/core/catalog/db.ts" as string);
      const { catalog, flush } = await import("/src/core/catalog/store.ts" as string);
      const id = [...catalog.getState().assets.keys()][0];
      const c = new OffscreenCanvas(600, 1200);
      const g = c.getContext("2d")!;
      g.fillStyle = "#ff00ff";
      g.fillRect(0, 0, 600, 1200);
      const bad = await c.convertToBlob({ type: "image/jpeg" });
      await putThumb(id, { thumb: bad, preview: bad, previewSource: "developed", revision: 0 });
      await putSetting("raw-previews-v1", false);
      await flush();
    });
    await page.reload();
    const record = () =>
      page.evaluate(async () => {
        const { getThumb, getSetting } = await import("/src/core/catalog/db.ts" as string);
        const { catalog } = await import("/src/core/catalog/store.ts" as string);
        const id = [...catalog.getState().assets.keys()][0];
        const r = id ? await getThumb(id) : null;
        if (!r?.base) return null;
        const bm = await createImageBitmap(r.preview);
        const c = new OffscreenCanvas(8, 8);
        const g = c.getContext("2d")!;
        g.drawImage(bm, 0, 0, 8, 8);
        const d = g.getImageData(4, 4, 1, 1).data;
        return { source: r.previewSource, width: bm.width, height: bm.height, colour: [d[0], d[1], d[2]], done: await getSetting("raw-previews-v1") };
      });
    await expect.poll(record, { timeout: 30_000 }).toMatchObject({ width: 2016, height: 1512, done: true });
    const restored = (await record())!;
    expect(restored.source).not.toBe("developed");
    // Green again, not magenta.
    expect(restored.colour[1]).toBeGreaterThan(restored.colour[0] + 60);
    expect(restored.colour[1]).toBeGreaterThan(restored.colour[2] + 40);
  });
});
