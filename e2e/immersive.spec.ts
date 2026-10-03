import { type CDPSession, expect, type Page, test } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

async function openInDevelop(page: Page) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false })));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(2400, 1600);
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 2400, 1600);
    gr.addColorStop(0, "#284878");
    gr.addColorStop(1, "#e8c890");
    g.fillStyle = gr;
    g.fillRect(0, 0, 2400, 1600);
    g.fillStyle = "#c03030";
    g.fillRect(1100, 700, 200, 200);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import photos", exact: true }).tap()]);
  await chooser.setFiles({ name: "IMG_0001.JPG", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().tap();
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name: "Develop" }).tap();
  await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
  await expect(page.getByTestId("sheet").getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

const photoRect = (page: Page) =>
  page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const r = developEngine().photoRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

const viewState = (page: Page) =>
  page.evaluate(async () => {
    const { develop } = await import("/src/core/develop/session.ts" as string);
    const { layout } = await import("/src/app/layout.ts" as string);
    return { fit: develop.getState().view.fit as boolean, immersive: layout.getState().immersive as boolean };
  });

/** Taps the photo with one finger (a real touch, not a click). */
async function tapPhoto(cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("a tap hides the interface and shows the photo edge to edge; another brings it back, zoomed or not", async ({ page }) => {
  await openInDevelop(page);
  const cdp = await page.context().newCDPSession(page);
  const bar = page.getByRole("navigation", { name: "Panels" });
  const before = await photoRect(page);
  // Rendered at the screen's own resolution (3 device pixels per point).
  expect(await page.locator("canvas.develop-canvas").evaluate((c: HTMLCanvasElement) => c.width / c.getBoundingClientRect().width)).toBeCloseTo(3, 1);

  // One tap: the interface goes, the photo fills the screen's width on black.
  await tapPhoto(cdp, 195, before.y + before.height / 2);
  await expect.poll(() => viewState(page)).toEqual({ fit: true, immersive: true });
  await expect(bar).toBeHidden();
  await expect(page.getByTestId("sheet")).toBeHidden();
  await expect(page.getByRole("banner")).toBeHidden();
  await page.waitForTimeout(450); // the glide
  const full = await photoRect(page);
  expect(full.width).toBeGreaterThan(388);
  expect(full.width).toBeGreaterThan(before.width);
  // Centred on the screen.
  expect(Math.abs(full.y + full.height / 2 - 332)).toBeLessThan(3);
  const view = (await page.locator(".develop-view").boundingBox())!;
  expect(view).toEqual({ x: 0, y: 0, width: 390, height: 664 });

  // A double tap still zooms to 100 %; the interface stays hidden.
  await tapPhoto(cdp, 195, 332);
  await page.waitForTimeout(60);
  await tapPhoto(cdp, 195, 332);
  await expect.poll(() => viewState(page)).toEqual({ fit: false, immersive: true });
  await page.waitForTimeout(500);
  expect((await viewState(page)).immersive).toBe(true);

  // Zoomed in, a tap brings the interface back and keeps the zoom.
  await tapPhoto(cdp, 195, 300);
  await expect.poll(() => viewState(page)).toEqual({ fit: false, immersive: false });
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("sheet")).toBeVisible();
  // And hides it again, still zoomed.
  await page.waitForTimeout(400);
  await tapPhoto(cdp, 195, 250);
  await expect.poll(() => viewState(page)).toEqual({ fit: false, immersive: true });
});

test("pinching draws the photo it has without developing it again, and sharpens once the fingers rest", async ({ page }) => {
  await openInDevelop(page);
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator(".develop-view").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.3;
  // Count the renders the engine makes.
  await page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const pipeline = developEngine().pipelineRef as { render: (...a: unknown[]) => unknown };
    const w = window as unknown as { renders: number };
    w.renders = 0;
    const render = pipeline.render.bind(pipeline);
    pipeline.render = (...a: unknown[]) => {
      w.renders++;
      return render(...a);
    };
  });
  const renders = () => page.evaluate(() => (window as unknown as { renders: number }).renders);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 30 - i * 8, y: cy, id: 1 }, { x: cx + 30 + i * 8, y: cy, id: 2 }] });
    await page.waitForTimeout(16);
  }
  const during = await renders();
  // The picture on screen while moving is the photo, not a blank canvas.
  const mid = await page.locator("canvas.develop-canvas").screenshot();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect((await viewState(page)).fit).toBe(false);
  expect(during).toBeLessThanOrEqual(1);
  // Resting: one sharp render of what is on screen.
  await expect.poll(renders, { timeout: 3000 }).toBeGreaterThan(during);
  const lit = await page.evaluate(async (b64) => {
    const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bm.width, bm.height);
    const g = c.getContext("2d")!;
    g.drawImage(bm, 0, 0);
    const d = g.getImageData(0, 0, bm.width, bm.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] + d[i + 1] + d[i + 2] > 60) n++;
    return n / (d.length / 4);
  }, mid.toString("base64"));
  expect(lit).toBeGreaterThan(0.3);
});
