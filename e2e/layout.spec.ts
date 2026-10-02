import { expect, type Page, test } from "@playwright/test";

/** A JPEG drawn in the page. */
async function importPhoto(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(1500, 1000);
    const g = c.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 1000);
    sky.addColorStop(0, "#5a6a9a");
    sky.addColorStop(1, "#f0a878");
    g.fillStyle = sky;
    g.fillRect(0, 0, 1500, 1000);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "sky.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click();
}

test.describe("computer", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true }));
    });
  });

  test("panels keep their places; they resize by dragging and hide with the toggles, and both are remembered", async ({ page }) => {
    await importPhoto(page);
    await page.keyboard.press("d");
    await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    // The default layout is untouched: presets and history on the left, adjustments on the right.
    await expect(left.getByText("History")).toBeVisible();
    expect(Math.round((await left.boundingBox())!.width)).toBe(240);
    expect(Math.round((await right.boundingBox())!.width)).toBe(300);
    await expect(page.locator(".dock")).toHaveCount(0);

    // Drag the left panel's edge 100 px wider.
    const handle = page.getByRole("separator", { name: "Resize the left panel" });
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + 200);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 50, h.y + 200);
    await page.mouse.move(h.x + h.width / 2 + 100, h.y + 200);
    await page.mouse.up();
    expect(Math.round((await left.boundingBox())!.width)).toBe(340);
    // The right one with the keyboard.
    await page.getByRole("separator", { name: "Resize the right panel" }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(Math.round((await right.boundingBox())!.width)).toBe(332);

    // Hide presets and history; the photo gets the room.
    const center = (await page.locator(".workspace .center").boundingBox())!.width;
    await page.getByRole("button", { name: "Left panel" }).click();
    await expect(left).toHaveCount(0);
    expect((await page.locator(".workspace .center").boundingBox())!.width).toBeGreaterThan(center + 300);
    await page.getByRole("button", { name: "Filmstrip" }).click();
    await expect(page.locator(".filmstrip")).toHaveCount(0);

    await page.reload();
    await page.locator(".cell").first().click();
    await page.keyboard.press("d");
    await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
    await expect(left).toHaveCount(0);
    await expect(page.locator(".filmstrip")).toHaveCount(0);
    expect(Math.round((await right.boundingBox())!.width)).toBe(332);
    await page.getByRole("button", { name: "Left panel" }).click();
    await page.getByRole("button", { name: "Filmstrip" }).click();
    expect(Math.round((await left.boundingBox())!.width)).toBe(340);
    // Double-click restores the default width.
    await page.getByRole("separator", { name: "Resize the left panel" }).dblclick();
    expect(Math.round((await left.boundingBox())!.width)).toBe(240);
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true }));
    });
  });

  test("fits the screen: the photo, a dock, and panels in a resizable sheet", async ({ page }) => {
    await importPhoto(page);
    // Phones start without the glow, and nothing scrolls sideways.
    await expect(page.locator(".app")).toHaveAttribute("data-backdrop", "off");
    await page.getByRole("button", { name: "Develop" }).tap();
    const dock = page.getByRole("navigation", { name: "Panels" });
    await expect(dock.getByRole("button", { name: "Edit" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const view = (await page.locator(".develop-view").boundingBox())!;
    expect(view.width).toBeGreaterThan(380);

    // Edit opens the adjustments in a sheet; the photo stays above it.
    await dock.getByRole("button", { name: "Edit" }).tap();
    const sheet = page.getByTestId("sheet");
    await expect(sheet.getByRole("slider", { name: "Exposure" })).toBeVisible();
    expect((await page.locator(".develop-view").boundingBox())!.height).toBeGreaterThan(140);
    const slider = sheet.getByRole("slider", { name: "Exposure" });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".history-item").first()).toHaveCount(0); // history lives in the other sheet
    await expect(slider).not.toHaveAttribute("aria-valuenow", "0");

    // Drag the grip up: the sheet grows and snaps, and keeps that height.
    const before = (await sheet.boundingBox())!.height;
    const grip = (await page.getByRole("separator", { name: "Resize the panel" }).boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 8);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(grip.x + grip.width / 2, grip.y + 8 - i * 30);
    await page.mouse.up();
    const after = (await sheet.boundingBox())!.height;
    expect(after).toBeGreaterThan(before + 60);

    // Presets opens the left side: presets, snapshots and history, with the edit just made.
    await dock.getByRole("button", { name: "Presets" }).tap();
    await expect(sheet.getByText("History")).toBeVisible();
    await expect(sheet.locator(".history-item").first()).toContainText("Exposure");
    // Crop is a tool: it opens the adjustments on the crop tool.
    await dock.getByRole("button", { name: "Crop" }).tap();
    await expect(dock.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByRole("button", { name: "Crop" }).first()).toHaveAttribute("aria-pressed", "true");
    // Tapping the current tool again closes the sheet.
    await dock.getByRole("button", { name: "Crop" }).tap();
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });

  test("pinch zooms the photo, double tap fits it again", async ({ page }) => {
    await importPhoto(page);
    await page.getByRole("button", { name: "Develop" }).tap();
    const view = page.locator(".develop-view");
    await expect(page.locator(".toolbar .dim.num").first()).toHaveText("Fit", { timeout: 30_000 });
    await page.waitForTimeout(500);
    const box = (await view.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await view.evaluate(
      (el, [cx, cy]) => {
        const fire = (type: string, id: number, x: number, y: number) =>
          el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        fire("pointerdown", 1, cx - 20, cy);
        fire("pointerdown", 2, cx + 20, cy);
        for (let i = 1; i <= 10; i++) {
          fire("pointermove", 1, cx - 20 - i * 12, cy);
          fire("pointermove", 2, cx + 20 + i * 12, cy);
        }
        fire("pointerup", 1, cx - 140, cy);
        fire("pointerup", 2, cx + 140, cy);
      },
      [cx, cy],
    );
    await expect(page.locator(".toolbar .dim.num").first()).not.toHaveText("Fit");
    // Double tap: back to fit.
    await view.evaluate(
      (el, [cx, cy]) => {
        for (let i = 0; i < 2; i++) {
          el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, pointerType: "touch", clientX: cx, clientY: cy, bubbles: true }));
          el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, pointerType: "touch", clientX: cx, clientY: cy, bubbles: true }));
        }
      },
      [cx, cy],
    );
    await expect(page.locator(".toolbar .dim.num").first()).toHaveText("Fit");
  });

  test("export says how large this device can export; the menu holds import and the glow", async ({ page }) => {
    await importPhoto(page);
    await page.getByRole("button", { name: "More" }).tap();
    await expect(page.getByRole("menuitem", { name: "Import Folder…" })).toBeVisible();
    await page.getByRole("menuitem", { name: /Glow background/ }).tap();
    await expect(page.locator(".app")).toHaveAttribute("data-backdrop", "on");
    await page.getByRole("button", { name: "Develop" }).tap();
    // The export button sits in the scrolling toolbar.
    await page.getByRole("button", { name: "Export…" }).first().tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("device-cap")).toContainText("4096 px");
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
    // The marble is still there, holding the photo, but still.
    await expect(dialog.getByTestId("export-marble")).toBeVisible();
  });
});

test("phones keep a smaller copy of a RAW: each pixel averages the samples it covers", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Loaded from the dev server inside the page.
    const glPath = "/src/core/gpu/gl.ts";
    const pipePath = "/src/core/gpu/pipeline.ts";
    const { Gpu } = (await import(/* @vite-ignore */ glPath)) as { Gpu: new (c: HTMLCanvasElement) => unknown };
    type Source = { base: { width: number; height: number }; size: { width: number; height: number } };
    type Pipe = { upload(id: string, data: unknown, info: unknown, maxSide?: number): Source; encode(t: unknown): Uint8ClampedArray; disposeSource(s: Source): void };
    const { DevelopPipeline } = (await import(/* @vite-ignore */ pipePath)) as { DevelopPipeline: new (gpu: unknown) => Pipe };
    const pipe = new DevelopPipeline(new Gpu(document.createElement("canvas")));
    const W = 600;
    const H = 400;
    const white = 4000;
    // A one-sample checkerboard of black and white, and a flat half grey.
    const checker = new Uint16Array(W * H * 3);
    const flat = new Uint16Array(W * H * 3).fill(white / 2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) checker.fill((x + y) % 2 ? white : 0, (y * W + x) * 3, (y * W + x) * 3 + 3);
    const raw = (data: Uint16Array) => ({ kind: "rgb16-linear", width: W, height: H, data, white });
    const small = pipe.upload("a", raw(checker), { raw: true }, 300);
    const full = pipe.upload("b", raw(flat), { raw: true }, Number.POSITIVE_INFINITY);
    const a = pipe.encode(small.base);
    const b = pipe.encode(full.base);
    return { small: [small.base.width, small.base.height], size: [small.size.width, small.size.height], full: [full.base.width, full.base.height], a: [a[0], a[1], a[2]], b: [b[0], b[1], b[2]] };
  });
  expect(result.small).toEqual([300, 200]);
  // The photo still reports its real size; only the working copy is smaller.
  expect(result.size).toEqual([600, 400]);
  expect(result.full).toEqual([600, 400]);
  for (let i = 0; i < 3; i++) expect(Math.abs(result.a[i] - result.b[i])).toBeLessThanOrEqual(2);
});
