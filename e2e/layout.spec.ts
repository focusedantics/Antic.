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

/** Phones: the workspaces are one switcher in the top bar. */
async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name }).tap();
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
    await switchTo(page, "Develop");
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
    // The sheet holds just the crop tool (the dock already picks the tool).
    await expect(sheet.getByRole("button", { name: "Crop", expanded: true })).toBeVisible();
    await expect(sheet.getByRole("slider", { name: "Exposure" })).toHaveCount(0);
    // Tapping the current tool again closes the sheet.
    await dock.getByRole("button", { name: "Crop" }).tap();
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });

  test("pinch zooms the photo, double tap fits it again", async ({ page }) => {
    await importPhoto(page);
    await switchTo(page, "Develop");
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
    await switchTo(page, "Develop");
    // Export sits in the top bar on a phone.
    await page.getByRole("banner").getByRole("button", { name: "Export", exact: true }).tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("device-cap")).toContainText("4096 px");
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
    // The marble is still there, holding the photo, but still.
    await expect(dialog.getByTestId("export-marble")).toBeVisible();
  });
  test("undo, redo and export live in the top bar, not in the scrolling toolbar", async ({ page }) => {
    await importPhoto(page);
    await switchTo(page, "Develop");
    const bar = page.getByRole("banner");
    const undo = bar.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeDisabled();
    await expect(bar.getByRole("button", { name: "Export", exact: true })).toBeVisible();
    // The toolbar's own copies are hidden on a phone.
    await expect(page.getByRole("toolbar", { name: "Develop view" }).getByRole("button", { name: "Undo" })).toBeHidden();
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
    const slider = page.getByTestId("sheet").getByRole("slider", { name: "Exposure" });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).not.toHaveAttribute("aria-valuenow", "0");
    await undo.tap();
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await bar.getByRole("button", { name: "Redo", exact: true }).tap();
    await expect(slider).not.toHaveAttribute("aria-valuenow", "0");
    // Each workspace brings its own; the workspace menu marks the current one.
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await expect(page.getByRole("menuitemradio", { name: "Develop" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "Library" }).tap();
    await expect(bar.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  });

  test("Edit is Lightroom's short panel floating over the photo: about three spaced sliders, groups beneath, a floating histogram", async ({ page }) => {
    await importPhoto(page);
    await switchTo(page, "Develop");
    const viewBefore = (await page.locator(".develop-view").boundingBox())!;
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
    const sheet = page.getByTestId("sheet");
    const exposure = sheet.getByRole("slider", { name: "Exposure" });
    await expect(exposure).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("tab", { name: "Light" })).toHaveAttribute("aria-selected", "true");

    // Short: three sliders show, the photo keeps most of the screen.
    const scroll = (await sheet.locator(".deck-scroll").boundingBox())!;
    const shown = await sheet.getByRole("slider").evaluateAll(
      (els, box) => els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top >= box.y - 1 && r.bottom <= box.y + box.height + 1;
      }).length,
      scroll,
    );
    expect(shown).toBe(3);
    expect((await sheet.boundingBox())!.height).toBeLessThan(664 * 0.42);
    // It floats over the bottom of the viewer, which keeps its whole height (the photo sits clear of it;
    // the filmstrip makes way, so the viewer even grows).
    const viewAfter = (await page.locator(".develop-view").boundingBox())!;
    expect(viewAfter.height).toBeGreaterThanOrEqual(viewBefore.height);
    const sheetBox = (await sheet.boundingBox())!;
    expect(Math.abs(sheetBox.y + sheetBox.height - (viewAfter.y + viewAfter.height))).toBeLessThan(2);
    expect(await sheet.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");

    // Each slider: its name and value on one line, a wide track beneath.
    const row = sheet.locator(".slider").filter({ has: page.getByRole("slider", { name: "Exposure" }) });
    const label = (await row.locator("label").boundingBox())!;
    const value = (await row.getByRole("textbox", { name: "Exposure value" }).boundingBox())!;
    const track = (await exposure.boundingBox())!;
    expect(Math.abs(label.y + label.height / 2 - (value.y + value.height / 2))).toBeLessThan(3);
    expect(value.x).toBeGreaterThan(label.x + 150);
    expect(track.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
    expect(track.width).toBeGreaterThan(330);

    // The histogram floats, small, in the photo's top-left corner (and is not in the sheet).
    const view = (await page.locator(".develop-view").boundingBox())!;
    const histogram = page.getByTestId("floating-histogram");
    await expect(histogram).toBeVisible();
    const h = (await histogram.boundingBox())!;
    expect(h.x - view.x).toBeLessThan(20);
    expect(h.y - view.y).toBeLessThan(20);
    expect(h.width).toBeLessThan(160);
    expect(await histogram.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    await expect(sheet.getByRole("img", { name: "Histogram" })).toHaveCount(0);

    // Groups switch the sliders, like Lightroom's Light, Color, Effects…
    const groups = sheet.getByRole("tablist", { name: "Adjustments" });
    await groups.getByRole("tab", { name: "Color" }).tap();
    await expect(sheet.getByRole("slider", { name: "Temp" })).toBeVisible();
    await expect(exposure).toHaveCount(0);
    // …and a group's parts sit under sub-tabs (Effects · Vignette · Grain).
    await groups.getByRole("tab", { name: "Effects" }).tap();
    await expect(sheet.getByRole("slider", { name: "Clarity" })).toBeVisible();
    const parts = sheet.getByRole("tablist", { name: "Effects sections" });
    await parts.getByRole("tab", { name: "Grain" }).tap();
    await expect(sheet.getByRole("slider", { name: "Clarity" })).toHaveCount(0);
    await expect(sheet.getByRole("slider", { name: "Roughness" })).toBeVisible();
    await groups.getByRole("tab", { name: "Light" }).tap();

    // Curve: drawn over the photo, the panel shrinks to a bar; tapping the curve adds a point.
    await groups.getByRole("tab", { name: "Curve" }).tap();
    const curve = page.locator(".develop-view").getByRole("img", { name: "master tone curve" });
    await expect(curve).toBeVisible();
    await expect(groups).toHaveCount(0);
    expect((await sheet.boundingBox())!.height).toBeLessThan(150);
    const c = (await curve.boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual((await sheet.boundingBox())!.y);
    const undo = page.getByRole("banner").getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeDisabled();
    await page.mouse.click(c.x + c.width * 0.5, c.y + c.height * 0.35);
    await expect(undo).toBeEnabled();
    expect(await curve.locator("circle").count()).toBe(3);
    await sheet.getByRole("button", { name: "Red" }).tap();
    await expect(page.locator(".develop-view").getByRole("img", { name: "red tone curve" })).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).tap();
    await expect(curve).toHaveCount(0);
    await expect(groups.getByRole("tab", { name: "Light" })).toHaveAttribute("aria-selected", "true");
    await undo.tap();

    // Crop needs the corner: the histogram steps aside there, and comes back for Edit.
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Crop" }).tap();
    await expect(histogram).toHaveCount(0);
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
    await expect(histogram).toBeVisible();

    // It can be hidden from the menu, and stays hidden.
    await page.getByRole("button", { name: "More" }).tap();
    await page.getByRole("menuitem", { name: "Hide the histogram" }).tap();
    await expect(histogram).toHaveCount(0);
    await page.reload();
    await switchTo(page, "Develop");
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
    await expect(page.getByTestId("sheet").getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
    await expect(histogram).toHaveCount(0);
  });

  test("a finger drags a slider sideways from where it is; taps and vertical swipes leave it alone", async ({ page }) => {
    await importPhoto(page);
    await switchTo(page, "Develop");
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
    const slider = page.getByTestId("sheet").getByRole("slider", { name: "Contrast" });
    await expect(slider).toBeVisible({ timeout: 30_000 });
    const box = (await slider.boundingBox())!;
    const gesture = (points: [number, number][]) =>
      slider.evaluate((el, pts) => {
        const fire = (type: string, [x, y]: [number, number]) =>
          el.dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        fire("pointerdown", pts[0]);
        for (const p of pts.slice(1)) fire("pointermove", p);
        fire("pointerup", pts[pts.length - 1]);
      }, points);
    // A tap far right of the thumb: no jump.
    const y = box.y + box.height / 2;
    await gesture([[box.x + box.width - 10, y]]);
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    // A vertical swipe that drifts sideways afterwards is still a scroll.
    await gesture([[box.x + 40, y], [box.x + 42, y - 20], [box.x + 120, y - 30]]);
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    // A sideways drag starting far from the thumb moves the value by the distance dragged.
    await gesture([[box.x + 20, y], [box.x + 30, y], [box.x + 30 + box.width / 4, y]]);
    await expect(slider).toHaveAttribute("aria-valuenow", "50");
    // One drag is one history step.
    await page.getByRole("banner").getByRole("button", { name: "Undo", exact: true }).tap();
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
  });

  test("every panel floats over the picture; tools that reach the edges fit it whole above the panel", async ({ page }) => {
    await importPhoto(page);
    const dock = page.getByRole("navigation", { name: "Panels" });
    const sheet = page.getByTestId("sheet");
    const floats = async () => {
      expect(await sheet.evaluate((el) => [getComputedStyle(el).position, !!el.closest(".center")])).toEqual(["absolute", true]);
      const s = (await sheet.boundingBox())!;
      expect(s.height).toBeLessThan(664 * 0.45);
      return s;
    };

    // Library: Info floats over the grid, which keeps its height.
    const grid = (await page.locator(".grid-scroll").boundingBox())!;
    await dock.getByRole("button", { name: "Info" }).tap();
    await floats();
    expect((await page.locator(".grid-scroll").boundingBox())!.height).toBeGreaterThanOrEqual(grid.height);
    await dock.getByRole("button", { name: "Info" }).tap();

    // Develop: Crop floats too, and the crop box with all its handles stays above it.
    await switchTo(page, "Develop");
    await dock.getByRole("button", { name: "Crop" }).tap();
    const s = await floats();
    const box = page.locator(".crop-box");
    await expect(box).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => { const b = (await box.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(s.y);
    // Presets (the other side) floats as well.
    await dock.getByRole("button", { name: "Presets" }).tap();
    await floats();
    await dock.getByRole("button", { name: "Presets" }).tap();

    // Composite: Layers floats, and the document fits whole above it.
    await switchTo(page, "Composite");
    await page.getByRole("button", { name: /Start from 1 selected/ }).tap();
    await expect(dock.getByRole("button", { name: "Effects" })).toBeEnabled({ timeout: 15_000 });
    await dock.getByRole("button", { name: "Layers" }).tap();
    const layers = await floats();
    // The selected layer's handles (at its corners) are all above the panel.
    const handles = page.locator(".composite-view .handle");
    await expect(handles.first()).toBeVisible();
    await expect
      .poll(async () => Math.max(...(await handles.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom)))))
      .toBeLessThanOrEqual(layers.y);
  });

  test("the effects browser fills the phone: search, category chips and two columns", async ({ page }) => {
    await importPhoto(page);
    await switchTo(page, "Composite");
    await page.getByRole("button", { name: /Start from 1 selected/ }).tap();
    const dock = page.getByRole("navigation", { name: "Panels" });
    await expect(dock.getByRole("button", { name: "Effects" })).toBeEnabled({ timeout: 15_000 });
    await dock.getByRole("button", { name: "Effects" }).tap();
    const browser = page.getByRole("dialog", { name: "Effects" });
    const box = (await browser.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThan(600);
    // The keyboard does not pop up by itself.
    await expect(browser.getByRole("searchbox", { name: "Search effects" })).not.toBeFocused();
    await expect(browser.getByRole("button", { name: "Close" })).toBeInViewport();
    const cards = browser.locator(".fx-card");
    const [a, b] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(Math.abs(a.y - b.y)).toBeLessThan(2); // side by side
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    await browser.getByRole("button", { name: /^Animated/ }).tap();
    await expect(browser.getByRole("button", { name: /^Animated/ })).toHaveAttribute("aria-current", "true");
    await cards.first().tap();
    await expect(browser).toHaveCount(0);
    // The effect is a new layer over the photo.
    await dock.getByRole("button", { name: "Layers" }).tap();
    await expect(page.getByTestId("sheet").locator(".layer-row")).toHaveCount(2);
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
