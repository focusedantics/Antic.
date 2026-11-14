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
    const proraw = testDng(8064, 6048, { linear: true, pixels: false, preview: Buffer.from(jpeg, "base64") });
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
});
