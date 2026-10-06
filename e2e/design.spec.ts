import { expect, type Page, test } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function fresh(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true }));
  });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
}

const go = (page: Page, name: string) => page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();

const layerNames = (page: Page) => page.getByRole("listbox", { name: "Layers" }).getByRole("option");

test.describe("computer", () => {
  test("a design starts from a size, keeps its layers, and stays out of Composite", async ({ page }) => {
    await fresh(page);
    // A composition made first must be untouched by Design.
    await go(page, "Composite");
    await page.getByRole("button", { name: "New Composition…" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("toolbar", { name: "Composite tools" })).toBeVisible();
    await expect(layerNames(page)).toHaveCount(0);

    await go(page, "Design");
    await expect(page.getByRole("heading", { name: "Start with a size" })).toBeVisible();
    // Sizes by group and by search.
    await page.getByRole("button", { name: "Print", exact: true }).click();
    await expect(page.getByRole("button", { name: /Flyer \(A4\)/ })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search sizes and templates" }).fill("story");
    await expect(page.getByRole("button", { name: /Story \/ Reel/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Flyer \(A4\)/ })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search sizes and templates" }).fill("");
    await page.getByRole("button", { name: "Social", exact: true }).click();
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();

    const tools = page.getByRole("toolbar", { name: "Design tools" });
    await expect(tools).toBeVisible();
    await expect(page.locator("aside.side.left").getByRole("button", { name: "Elegant serif" })).toBeVisible();
    await tools.getByRole("button", { name: "Text" }).click();
    await expect(layerNames(page)).toHaveCount(1);
    await expect(layerNames(page).first()).toContainText("Big heading");
    await page.locator("aside.side.left").getByRole("button", { name: "Elegant serif" }).click();
    await expect(layerNames(page)).toHaveCount(2);
    // The canvas draws the design.
    await expect(page.locator(".center canvas").first()).toBeVisible();

    // Saved: it is in Your designs after a reload, and opens with its layers.
    await page.waitForTimeout(1200);
    await page.reload();
    await go(page, "Design");
    const tile = page.locator(".design-tile").filter({ hasText: "Instagram post" });
    await expect(tile).toHaveCount(1);
    await tile.getByRole("button", { name: "Open Instagram post" }).click();
    await expect(layerNames(page)).toHaveCount(2);

    // Composite lists and reopens only its composition.
    await go(page, "Composite");
    await expect(page.getByRole("toolbar", { name: "Composite tools" })).toBeVisible();
    await expect(page.locator("aside.side.left .doc-card")).toHaveCount(1);
    await expect(page.locator("aside.side.left .doc-card")).toContainText("Untitled");
    await expect(layerNames(page)).toHaveCount(0);

    // Back in Design, the design is still the one being edited.
    await go(page, "Design");
    await expect(page.getByRole("heading", { name: "Start with a size" })).toBeVisible();
    await tile.getByRole("button", { name: "Open Instagram post" }).click();
    await expect(layerNames(page)).toHaveCount(2);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("the home and the editor fit a phone; the dock opens Add and Layers", async ({ page }) => {
    await fresh(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await expect(page.getByRole("heading", { name: "Start with a size" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Sizes scroll sideways inside their row.
    const row = page.locator(".size-row");
    expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    await page.getByRole("button", { name: /^Story \/ Reel 1080/ }).tap();
    const tools = page.getByRole("toolbar", { name: "Design tools" });
    await expect(tools).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    const dock = page.getByRole("navigation", { name: "Panels" });
    await dock.getByRole("button", { name: "Add" }).tap();
    const sheet = page.getByTestId("sheet");
    await sheet.getByRole("button", { name: "Neon", exact: true }).tap();
    await dock.getByRole("button", { name: "Layers" }).tap();
    await expect(sheet.getByRole("listbox", { name: "Layers" }).getByRole("option")).toHaveCount(1);
    await expect(sheet.getByRole("listbox", { name: "Layers" }).getByRole("option").first()).toContainText("NEON");

    // Designs goes back to the home, where the design is listed.
    await dock.getByRole("button", { name: "Designs" }).tap();
    await expect(page.locator(".design-tile")).toHaveCount(1, { timeout: 5000 });
  });
});

/** Pixels of the canvas view matching `test`, from a screenshot. */
async function count(page: Page, test: string): Promise<number> {
  await page.waitForTimeout(700);
  const png = (await page.locator(".composite-view").screenshot()).toString("base64");
  return page.evaluate(
    async ([data, fn]) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = c.getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const match = new Function("r", "g", "b", `return ${fn};`) as (r: number, g: number, b: number) => boolean;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (match(d[i], d[i + 1], d[i + 2])) n++;
      return n;
    },
    [png, test] as const,
  );
}

const jpeg = async (page: Page, color: string) => {
  const b64 = await page.evaluate(async (fill) => {
    const c = new OffscreenCanvas(1200, 800);
    const g = c.getContext("2d")!;
    g.fillStyle = fill;
    g.fillRect(0, 0, 1200, 800);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  }, color);
  return { name: "green.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
};

test.describe("computer: shapes, styles, text and frames", () => {
  test("smart shapes, layer styles, text upgrades and photo frames render and persist", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    const amber = "r > 190 && g > 140 && g < 190 && b < 100";

    // A star in the first shape colour.
    expect(await count(page, amber)).toBe(0);
    await left.getByRole("button", { name: "Add star", exact: true }).click();
    await expect(layerNames(page)).toHaveCount(1);
    const starPixels = await count(page, amber);
    expect(starPixels).toBeGreaterThan(500);
    // More points: a different shape, same colour.
    await right.getByRole("combobox", { name: "Shape" }).selectOption("heart");
    await expect(layerNames(page).first()).toContainText("Heart");
    expect(Math.abs((await count(page, amber)) - starPixels)).toBeGreaterThan(100);

    // A blue outline around it, then a drop shadow under it.
    const blue = "b > 200 && r < 60 && g < 60";
    await right.getByRole("checkbox", { name: "Outline" }).check();
    await right.getByLabel("Outline colour").fill("#0000ff");
    expect(await count(page, blue)).toBeGreaterThan(200);
    const grey = "r < 235 && r > 120 && Math.abs(r - g) < 6 && Math.abs(g - b) < 6";
    const before = await count(page, grey);
    await right.getByRole("checkbox", { name: "Shadow" }).check();
    expect(await count(page, grey)).toBeGreaterThan(before + 300);

    // Fill opacity 0: only the outline and shadow stay.
    const fill = right.getByRole("slider", { name: "Fill" }).first();
    await fill.focus();
    await page.keyboard.press("Home");
    expect(await count(page, amber)).toBeLessThan(20);
    expect(await count(page, blue)).toBeGreaterThan(200);

    // Text with a gradient fill (red → orange) and a highlight box.
    await left.getByRole("button", { name: "Subheading", exact: true }).click();
    await expect(layerNames(page)).toHaveCount(2);
    const red = "r > 200 && g < 120 && b < 130";
    expect(await count(page, red)).toBe(0);
    await right.getByRole("checkbox", { name: "Gradient fill" }).check();
    expect(await count(page, red)).toBeGreaterThan(30);
    await right.getByRole("checkbox", { name: "Highlight" }).check();
    const black = "r < 30 && g < 30 && b < 30";
    expect(await count(page, black)).toBeGreaterThan(1000);
    // Curving grows the box so the arc fits.
    const height = Number(await right.getByLabel("H", { exact: true }).inputValue());
    const curve = right.getByRole("slider", { name: "Curve" });
    await curve.focus();
    await page.keyboard.press("End");
    expect(Number(await right.getByLabel("H", { exact: true }).inputValue())).toBeGreaterThan(height);

    // A photo frame: placeholder, then filled from the device.
    const placeholder = "Math.abs(r - 201) < 6 && Math.abs(g - 204) < 6 && Math.abs(b - 209) < 6";
    await left.getByRole("button", { name: "Photo frame", exact: true }).click();
    await expect(layerNames(page)).toHaveCount(3);
    expect(await count(page, placeholder)).toBeGreaterThan(2000);
    await right.getByRole("button", { name: "Add photo…" }).click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "From this device…" }).click()]);
    await chooser.setFiles(await jpeg(page, "#1fa83a"));
    await expect(right.getByRole("button", { name: "Replace photo…" })).toBeVisible({ timeout: 30_000 });
    const green = "g > 140 && r < 80 && b < 100";
    await expect.poll(() => count(page, green), { timeout: 20_000 }).toBeGreaterThan(2000);
    expect(await count(page, placeholder)).toBeLessThan(50);
    // Still three layers: the photo went into the frame.
    await expect(layerNames(page)).toHaveCount(3);

    // All of it survives a reload and looks the same.
    const saved = { green: await count(page, green), red: await count(page, red), black: await count(page, black), grey: await count(page, grey) };
    await page.waitForTimeout(1200);
    await page.reload();
    await go(page, "Design");
    await page.locator(".design-tile").first().getByRole("button", { name: /^Open/ }).click();
    await expect(layerNames(page)).toHaveCount(3);
    await expect.poll(() => count(page, green), { timeout: 20_000 }).toBeGreaterThan(saved.green * 0.97);
    for (const [name, test] of [["red", red], ["black", black], ["grey", grey]] as const) {
      const now = await count(page, test);
      expect(Math.abs(now - saved[name]), name).toBeLessThanOrEqual(Math.max(20, saved[name] * 0.03));
    }
  });
});

test.describe("phone: shapes", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("shapes and frames are in the Add sheet; a shape's properties fit the screen", async ({ page }) => {
    await fresh(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("button", { name: /^Instagram post 1080/ }).tap();
    const dock = page.getByRole("navigation", { name: "Panels" });
    await dock.getByRole("button", { name: "Add" }).tap();
    const sheet = page.getByTestId("sheet");
    await sheet.getByRole("button", { name: "Add heart", exact: true }).tap();
    await sheet.getByRole("button", { name: "Add ellipse photo frame" }).tap();
    await dock.getByRole("button", { name: "Layers" }).tap();
    await expect(sheet.getByRole("listbox", { name: "Layers" }).getByRole("option")).toHaveCount(2);
    await sheet.getByRole("listbox", { name: "Layers" }).getByRole("option").filter({ hasText: "Heart" }).tap();
    await expect(sheet.getByRole("combobox", { name: "Shape" })).toBeVisible();
    await expect(sheet.getByRole("checkbox", { name: "Shadow" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("computer: drawing tools", () => {
  test("brushes, hold to straighten, bucket fill, pen, points and elements", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const tools = page.getByRole("toolbar", { name: "Design tools" });
    const view = page.locator(".composite-view");
    const box = (await view.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const r = Math.min(box.width, box.height) * 0.3;

    // Draw: a stroke in red makes a drawing layer.
    await tools.getByRole("button", { name: "Draw", exact: true }).click();
    const options = page.getByRole("toolbar", { name: "Drawing options" });
    await options.getByLabel("Brush colour").fill("#ff0000");
    await options.getByRole("checkbox", { name: "Hold to straighten" }).uncheck();
    await page.mouse.move(cx - r, cy - r * 0.8);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(cx - r + (i / 20) * r * 2, cy - r * 0.8 + Math.sin(i) * 6);
    await page.mouse.up();
    await expect(layerNames(page)).toHaveCount(1);
    await expect(layerNames(page).first()).toContainText("Drawing");
    const red = "r > 200 && g < 80 && b < 80";
    const strokePixels = await count(page, red);
    expect(strokePixels).toBeGreaterThan(100);

    // Hold at the end: a wobbly stroke becomes a straight line (in the same drawing).
    await options.getByRole("checkbox", { name: "Hold to straighten" }).check();
    await page.mouse.move(cx - r, cy + r * 0.8);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(cx - r + (i / 20) * r * 2, cy + r * 0.8 + (i % 2 ? 7 : -7));
    await page.waitForTimeout(900);
    await expect(page.locator(".tool-toast")).toHaveText("Line");
    await page.mouse.up();
    await expect(layerNames(page)).toHaveCount(1);

    // A closed loop, then the bucket fills its inside in blue; outside stays white.
    await page.mouse.move(cx + r * 0.4, cy);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(a) * r * 0.4, cy + Math.sin(a) * r * 0.4);
    }
    await page.mouse.up();
    await options.getByRole("button", { name: "Fill", exact: true }).click();
    await options.getByLabel("Brush colour").fill("#0000ff");
    const blue = "b > 200 && r < 60 && g < 60";
    // The options bar's colour swatch is blue too.
    const swatch = await count(page, blue);
    await page.mouse.click(cx, cy);
    expect(await count(page, blue)).toBeGreaterThan(swatch + 2000);
    const white = "r > 245 && g > 245 && b > 245";
    expect(await count(page, white)).toBeGreaterThan(20000);
    // Undo removes the fill only.
    await page.keyboard.press("Control+z");
    expect(await count(page, blue)).toBeLessThanOrEqual(swatch + 20);
    await page.keyboard.press("Control+Shift+z");
    expect(await count(page, blue)).toBeGreaterThan(swatch + 2000);
    await options.getByRole("button", { name: "Done" }).click();

    // Pen: three clicks and a click on the first point make a filled triangle.
    await tools.getByRole("button", { name: "Pen", exact: true }).click();
    await page.getByRole("toolbar", { name: "Pen options" }).getByLabel("Pen colour").fill("#00b000");
    const p1 = { x: cx - r * 0.9, y: cy - r * 0.2 };
    await page.mouse.click(p1.x, p1.y);
    await page.mouse.click(cx - r * 0.5, cy - r * 0.9);
    await page.mouse.click(cx - r * 0.1, cy - r * 0.2);
    await page.mouse.click(p1.x, p1.y);
    await expect(layerNames(page)).toHaveCount(2);
    await expect(layerNames(page).first()).toContainText("Shape");
    const green = "g > 150 && r < 60 && b < 60";
    const triangle = await count(page, green);
    expect(triangle).toBeGreaterThan(500);

    // Points: drag the top corner up; the triangle grows.
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");
    await expect(page.getByRole("toolbar", { name: "Point options" })).toBeVisible();
    const anchors = page.locator(".pen-anchor");
    await expect(anchors).toHaveCount(3);
    const top = (await anchors.nth(1).boundingBox())!;
    await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
    await page.mouse.down();
    await page.mouse.move(top.x + top.width / 2, top.y - r * 0.3, { steps: 5 });
    await page.mouse.up();
    expect(await count(page, green)).toBeGreaterThan(triangle * 1.2);
    await page.getByRole("toolbar", { name: "Point options" }).getByRole("button", { name: "Done" }).click();

    // An element arrives as a group of editable layers.
    await page.locator("aside.side.left").getByRole("button", { name: "Add sale burst" }).click();
    await expect(layerNames(page)).toHaveCount(3);
    await expect(layerNames(page).first()).toContainText("Sale burst");

    // Everything is saved and looks the same after a reload (the burst covers part of the rest).
    await page.waitForTimeout(1200);
    const colours = { red, green, blue, white };
    const saved: Record<string, number> = {};
    for (const [name, test] of Object.entries(colours)) saved[name] = await count(page, test);
    expect(saved.red).toBeGreaterThan(1000);
    await page.reload();
    await go(page, "Design");
    await page.locator(".design-tile").first().getByRole("button", { name: /^Open/ }).click();
    await expect(layerNames(page)).toHaveCount(3);
    await expect.poll(() => count(page, red)).toBeGreaterThan(saved.red * 0.97);
    for (const [name, test] of Object.entries(colours)) {
      const now = await count(page, test);
      expect(Math.abs(now - saved[name]), name).toBeLessThanOrEqual(Math.max(30, saved[name] * 0.03));
    }
  });
});

test.describe("phone: drawing", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("the drawing options fit the phone and the Text sheet has combinations", async ({ page }) => {
    await fresh(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("button", { name: /^Story \/ Reel 1080/ }).tap();
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Draw" }).tap();
    const options = page.getByRole("toolbar", { name: "Drawing options" });
    await expect(options).toBeVisible();
    const b = (await options.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await options.getByRole("button", { name: "Done" }).tap();
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Add" }).tap();
    const sheet = page.getByTestId("sheet");
    await sheet.getByRole("button", { name: "Add big number" }).tap();
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Layers" }).tap();
    await expect(sheet.getByRole("listbox", { name: "Layers" }).getByRole("option").first()).toContainText("Big number");
  });
});
