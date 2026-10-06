import { unzipSync } from "fflate";
import { readFileSync } from "node:fs";
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
    await right.getByRole("textbox", { name: "Outline colour" }).fill("#0000ff");
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
    await options.getByRole("textbox", { name: "Brush colour" }).fill("#ff0000");
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
    await options.getByRole("textbox", { name: "Brush colour" }).fill("#0000ff");
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
    await page.getByRole("toolbar", { name: "Pen options" }).getByRole("textbox", { name: "Pen colour" }).fill("#00b000");
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

test.describe("computer: templates and collages", () => {
  test("start from a template, make a collage from photos, re-lay it out, save and reuse a template and an element", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    // Search finds a template; it opens as a design with its layers.
    await page.getByRole("searchbox", { name: "Search sizes and templates" }).fill("wedding");
    await page.getByRole("button", { name: /^Wedding invitation/ }).click();
    await expect(page.getByRole("toolbar", { name: "Design tools" })).toBeVisible();
    expect(await layerNames(page).count()).toBeGreaterThan(5);

    // A collage from three photos on this device.
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Designs" }).click();
    await page.getByRole("button", { name: "Collages", exact: true }).click();
    await page.getByRole("button", { name: "Collage from your photos" }).click();
    const files = await Promise.all(["#e01010", "#10b010", "#1010e0"].map((c, i) => jpeg(page, c).then((f) => ({ ...f, name: `c${i}.jpg` }))));
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "Photos from this device…" }).click()]);
    await chooser.setFiles(files);
    await expect(page.getByRole("toolbar", { name: "Design tools" })).toBeVisible({ timeout: 30_000 });
    await expect(layerNames(page).first()).toContainText("Collage");
    const red = "r > 180 && g < 70 && b < 70";
    const green = "g > 140 && r < 70 && b < 80";
    const blue = "b > 180 && r < 70 && g < 70";
    for (const c of [red, green, blue]) await expect.poll(() => count(page, c), { timeout: 20_000 }).toBeGreaterThan(3000);

    // Pick a photo in it: the Collage controls are there; more spacing shows more white.
    const view = (await page.locator(".composite-view").boundingBox())!;
    await page.mouse.click(view.x + view.width / 2 - 60, view.y + view.height / 2);
    const right = page.locator("aside.side.right");
    await expect(right.locator(".subhead", { hasText: "Collage" })).toBeVisible();
    const white = "r > 245 && g > 245 && b > 245";
    const before = await count(page, white);
    const spacing = right.getByRole("slider", { name: "Spacing" });
    await spacing.focus();
    await page.keyboard.press("End");
    expect(await count(page, white)).toBeGreaterThan(before * 1.5);
    await right.getByRole("combobox", { name: "Layout" }).selectOption("3-cols");
    for (const c of [red, green, blue]) expect(await count(page, c)).toBeGreaterThan(2000);

    // Save it as a template; starting from it gives empty frames.
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Save as template…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Three in a row");
    await dialog.getByLabel("Folder").fill("Mine/Collages");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Designs" }).click();
    await page.getByRole("button", { name: "My templates" }).click();
    await page.getByRole("button", { name: "Use Three in a row" }).click();
    await expect(page.getByRole("toolbar", { name: "Design tools" })).toBeVisible();
    const placeholder = "Math.abs(r - 201) < 6 && Math.abs(g - 204) < 6 && Math.abs(b - 209) < 6";
    expect(await count(page, placeholder)).toBeGreaterThan(5000);
    expect(await count(page, red)).toBeLessThan(50);

    // Save a selected layer as an element and add it again from Elements → Mine.
    await page.locator("aside.side.left").getByRole("button", { name: "Add sale burst" }).click();
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Save selection as element…" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("My burst");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    const layers = await layerNames(page).count();
    await page.locator("aside.side.left").getByRole("button", { name: "Mine", exact: true }).click();
    await page.locator("aside.side.left").getByRole("button", { name: "Add My burst" }).click();
    await expect(layerNames(page)).toHaveCount(layers + 1);
  });
});

test.describe("computer: colours, fonts, brushes and your things", () => {
  test("picker, eyedropper, gradient presets, custom fonts, brush tips, palettes and folders", async ({ page }) => {
    // Use the canvas eyedropper (the system one cannot be driven by a test).
    await page.addInitScript(() => delete (window as unknown as { EyeDropper?: unknown }).EyeDropper);
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    await left.getByRole("button", { name: "Add heart", exact: true }).click();
    const fill = right.getByRole("textbox", { name: "Fill colour" });
    const before = await fill.inputValue();

    // The wheel: a drag is one undoable step.
    await right.getByRole("button", { name: "Fill colour picker" }).click();
    const picker = page.getByRole("dialog", { name: "Colour picker" });
    await picker.getByRole("button", { name: "Wheel" }).click();
    const wheel = (await picker.getByRole("slider", { name: "Hue and saturation" }).boundingBox())!;
    await page.mouse.move(wheel.x + wheel.width * 0.8, wheel.y + wheel.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(wheel.x + wheel.width * 0.5, wheel.y + wheel.height * 0.85, { steps: 6 });
    await page.mouse.up();
    const dragged = await fill.inputValue();
    expect(dragged).not.toBe(before);
    // The whole drag is one step: one undo goes back to the start, one redo to the end.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await expect(fill).toHaveValue(before);
    await page.keyboard.press("Control+Shift+z");
    await expect(fill).toHaveValue(dragged);
    await right.getByRole("button", { name: "Fill colour picker" }).click();
    // Values: exact blue.
    await picker.getByRole("button", { name: "Values" }).click();
    await picker.getByRole("spinbutton", { name: "Red" }).fill("0");
    await picker.getByRole("spinbutton", { name: "Green" }).fill("0");
    await picker.getByRole("spinbutton", { name: "Blue" }).fill("255");
    await expect(fill).toHaveValue("#0000ff");
    // A palette swatch.
    await picker.getByRole("combobox").selectOption({ label: "Basics" });
    await picker.getByRole("option", { name: "#e8343a" }).click();
    await expect(fill).toHaveValue("#e8343a");
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await fill.fill(before);

    // Eyedropper: pick the heart's colour into the outline.
    await right.getByRole("checkbox", { name: "Outline" }).check();
    await right.getByRole("button", { name: "Outline colour picker" }).click();
    await page.getByRole("dialog", { name: "Colour picker" }).getByRole("button", { name: "Eyedropper" }).click();
    await expect(page.locator(".eyedropper-hint")).toBeVisible();
    const view = (await page.locator(".composite-view").boundingBox())!;
    await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
    await expect(right.getByRole("textbox", { name: "Outline colour" })).toHaveValue(before);

    // A gradient preset on text.
    await left.getByRole("button", { name: "Subheading", exact: true }).click();
    await right.getByRole("checkbox", { name: "Gradient fill" }).check();
    await right.getByRole("button", { name: "Gradient: Lagoon" }).click();
    await expect.poll(() => count(page, "b > 200 && r < 60 && g > 60 && g < 200")).toBeGreaterThan(30);

    // A font from a file: listed under My fonts and used.
    const font = { name: "My Pacifico.woff2", mimeType: "font/woff2", buffer: readFileSync("node_modules/@fontsource/pacifico/files/pacifico-latin-400-normal.woff2") };
    const [fontChooser] = await Promise.all([page.waitForEvent("filechooser"), right.getByRole("combobox", { name: "Font" }).selectOption("__import")]);
    await fontChooser.setFiles(font);
    await expect(right.getByRole("combobox", { name: "Font" })).toHaveValue("'My Pacifico', sans-serif");
    expect(await page.evaluate(() => document.fonts.check("40px 'My Pacifico'"))).toBe(true);

    // A brush from an image: its tip paints.
    const tip = await page.evaluate(async () => {
      const c = new OffscreenCanvas(64, 64);
      const g = c.getContext("2d")!;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = "#000";
      g.fillRect(16, 16, 32, 32);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    });
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Draw", exact: true }).click();
    const options = page.getByRole("toolbar", { name: "Drawing options" });
    const [tipChooser] = await Promise.all([page.waitForEvent("filechooser"), options.getByRole("button", { name: "+ Brush" }).click()]);
    await tipChooser.setFiles({ name: "square.png", mimeType: "image/png", buffer: Buffer.from(tip, "base64") });
    await expect(options.getByRole("button", { name: "Brush: square" })).toHaveAttribute("aria-pressed", "true");
    await options.getByRole("textbox", { name: "Brush colour" }).fill("#00c000");
    await page.mouse.move(view.x + view.width * 0.2, view.y + view.height * 0.85);
    await page.mouse.down();
    await page.mouse.move(view.x + view.width * 0.8, view.y + view.height * 0.85, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => count(page, "g > 150 && r < 60 && b < 60")).toBeGreaterThan(200);
    await options.getByRole("button", { name: "Done" }).click();

    // Your things: a palette from a photo, filed in a folder, exported and imported again.
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Your things…" }).click();
    const things = page.getByRole("dialog", { name: "Your things" });
    await things.getByRole("tab", { name: "Fonts" }).click();
    await expect(things.getByText("My Pacifico")).toBeVisible();
    await things.getByRole("tab", { name: "Brushes" }).click();
    await expect(things.getByText("square")).toBeVisible();
    await things.getByRole("tab", { name: "Palettes" }).click();
    await things.getByRole("button", { name: "From a photo…" }).click();
    const [photoChooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "A photo on this device…" }).click()]);
    await photoChooser.setFiles(await jpeg(page, "#1fa83a"));
    await expect(things.locator(".palette-chip").first()).toBeVisible();
    await things.getByRole("button", { name: "More for green" }).click();
    page.once("dialog", (d) => void d.accept("Brand/Greens"));
    await page.getByRole("menuitem", { name: "Move to folder…" }).click();
    await expect(things.getByRole("button", { name: "Brand/Greens" })).toBeVisible();
    await things.getByRole("button", { name: "More for green" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export as GIMP palette (.gpl)" }).click()]);
    const gpl = readFileSync(await download.path());
    expect(gpl.toString()).toContain("GIMP Palette");
    const [importChooser] = await Promise.all([page.waitForEvent("filechooser"), things.getByRole("button", { name: "Import…" }).click()]);
    await importChooser.setFiles({ name: "again.gpl", mimeType: "text/plain", buffer: gpl });
    await things.getByRole("button", { name: "All", exact: true }).click();
    await expect(things.locator(".manager-item")).toHaveCount(2);
  });
});

/** Width, height and the red pixels' columns on row `y` of a PNG. */
async function redColumns(page: Page, png: Uint8Array, y: number) {
  return page.evaluate(
    async ([b64, row]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = c.getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const d = g.getImageData(0, row, bitmap.width, 1).data;
      const red: number[] = [];
      for (let x = 0; x < bitmap.width; x++) if (d[x * 4] > 200 && d[x * 4 + 1] < 60 && d[x * 4 + 2] < 60) red.push(x);
      return { width: bitmap.width, height: bitmap.height, first: red[0] ?? -1, last: red[red.length - 1] ?? -1, count: red.length };
    },
    [Buffer.from(png).toString("base64"), y] as const,
  );
}

test.describe("computer: carousels", () => {
  test("a seamless carousel: slides, swipe, preview, add a slide, export each slide or the whole strip", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("group", { name: "Size groups" }).getByRole("button", { name: "Carousels", exact: true }).click();
    await page.getByRole("button", { name: /^Carousel 4:5, 3 slides/ }).click();
    const bar = page.getByRole("toolbar", { name: "Slides" });
    await expect(bar.getByRole("button", { name: /^Slide \d$/ })).toHaveCount(3);
    const right = page.locator("aside.side.right");

    // A red square across the edge between slides 1 and 2.
    await page.locator("aside.side.left").getByRole("button", { name: "Add rectangle", exact: true }).click();
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#ff0000");
    await right.getByRole("spinbutton", { name: "W" }).fill("400");
    await right.getByRole("spinbutton", { name: "X" }).fill("1080");
    await right.getByRole("spinbutton", { name: "Y" }).fill("675");

    // Go to slide 2, then swipe on the empty top of it to slide 3.
    await bar.getByRole("button", { name: "Slide 2", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Slide 2", exact: true })).toHaveAttribute("aria-pressed", "true");
    const view = (await page.locator(".composite-view").boundingBox())!;
    await page.waitForTimeout(400);
    const y = view.y + 80;
    await page.mouse.move(view.x + view.width * 0.75, y);
    await page.mouse.down();
    await page.mouse.move(view.x + view.width * 0.3, y, { steps: 8 });
    await page.mouse.up();
    await expect(bar.getByRole("button", { name: "Slide 3", exact: true })).toHaveAttribute("aria-pressed", "true");
    await bar.getByRole("button", { name: "All" }).click();
    await expect(bar.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

    // The preview swipes slide by slide.
    await bar.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: "Carousel preview" });
    await expect(preview.locator("img")).toBeVisible({ timeout: 15_000 });
    await expect(preview.locator(".carousel-count")).toHaveText("1/3");
    await preview.getByRole("button", { name: "Next slide" }).click();
    await expect(preview.locator(".carousel-count")).toHaveText("2/3");
    await preview.getByRole("button", { name: "Done" }).click();

    // Export every slide into a ZIP: three 1080 × 1350 images that meet exactly.
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Export…" }).click();
    let dialog = page.getByRole("dialog", { name: /^Export/ });
    await expect(dialog.getByRole("radio", { name: /Every slide/ })).toBeChecked();
    await dialog.getByLabel("Export destination").selectOption("zip");
    const [zipFile] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export 3" }).click()]);
    const files = unzipSync(new Uint8Array(readFileSync(await zipFile.path())));
    const names = Object.keys(files).sort();
    expect(names).toEqual(["Carousel 4-5, 3 slides 1 of 3.png", "Carousel 4-5, 3 slides 2 of 3.png", "Carousel 4-5, 3 slides 3 of 3.png"]);
    const s1 = await redColumns(page, files[names[0]], 675);
    const s2 = await redColumns(page, files[names[1]], 675);
    const s3 = await redColumns(page, files[names[2]], 675);
    expect([s1.width, s1.height]).toEqual([1080, 1350]);
    expect(s1.first).toBe(880);
    expect(s1.last).toBe(1079);
    expect(s2.first).toBe(0);
    expect(s2.last).toBe(199);
    expect(s3.count).toBe(0);

    // Chosen slides, and the whole strip as one image.
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Export…" }).click();
    dialog = page.getByRole("dialog", { name: /^Export/ });
    await dialog.getByRole("radio", { name: "Chosen slides" }).check();
    await dialog.getByRole("group", { name: "Slides to export" }).getByRole("checkbox", { name: "1" }).uncheck();
    await dialog.getByRole("group", { name: "Slides to export" }).getByRole("checkbox", { name: "3" }).uncheck();
    await dialog.getByLabel("Export destination").selectOption("download");
    const [one] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
    expect(one.suggestedFilename()).toBe("Carousel 4-5, 3 slides 2 of 3.png");
    await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Export…" }).click();
    dialog = page.getByRole("dialog", { name: /^Export/ });
    await dialog.getByRole("radio", { name: /whole carousel/ }).check();
    const [whole] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
    const w = await redColumns(page, new Uint8Array(readFileSync(await whole.path())), 675);
    expect([w.width, w.height, w.first, w.last]).toEqual([3240, 1350, 880, 1279]);

    // Add a slide: four slides, the canvas a slide wider.
    await bar.getByRole("button", { name: "Add slide", exact: true }).click();
    await expect(bar.getByRole("button", { name: /^Slide \d$/ })).toHaveCount(4);
    const left = page.locator("aside.side.left");
    await left.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(left.getByRole("spinbutton", { name: "Slide width (4 slides)" })).toHaveValue("1080");
  });
});

test.describe("phone: carousels", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("the slide bar and the swipe preview fit the phone", async ({ page }) => {
    await fresh(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("group", { name: "Size groups" }).getByRole("button", { name: "Carousels", exact: true }).tap();
    await page.getByRole("button", { name: /^Carousel square, 3 slides/ }).tap();
    const bar = page.getByRole("toolbar", { name: "Slides" });
    await expect(bar).toBeVisible();
    const b = (await bar.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    await bar.getByRole("button", { name: "Slide 3", exact: true }).tap();
    await expect(bar.getByRole("button", { name: "Slide 3", exact: true })).toHaveAttribute("aria-pressed", "true");
    await bar.getByRole("button", { name: "Preview" }).tap();
    const phone = (await page.locator(".carousel-phone").boundingBox())!;
    expect(phone.x).toBeGreaterThanOrEqual(0);
    expect(phone.x + phone.width).toBeLessThanOrEqual(390);
    await expect(page.locator(".carousel-count")).toHaveText("1/3");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

/** Pixels between red and white (a soft edge) along row `y` and column `x` of an exported PNG. */
async function softPixels(page: Page, x: number, y: number) {
  await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Export/ });
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  const png = readFileSync(await file.path()).toString("base64");
  return page.evaluate(
    async ([b64, px, py]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const soft = (d: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 25 && d[i + 1] < 230) n++;
        return n;
      };
      return { row: soft(g.getImageData(0, py, bitmap.width, 1).data), col: soft(g.getImageData(px, 0, 1, bitmap.height).data) };
    },
    [png, x, y] as const,
  );
}

test.describe("computer: blur", () => {
  test("layer blur and the Blur effects (Gaussian, motion, tilt-shift, zoom, lens) soften what they should", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    // A red square, 340–739 both ways, on white.
    await left.getByRole("button", { name: "Add rectangle", exact: true }).click();
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#ff0000");
    await right.getByRole("spinbutton", { name: "W" }).fill("400");
    await right.getByRole("spinbutton", { name: "H" }).fill("400");
    await right.getByRole("spinbutton", { name: "X" }).fill("540");
    await right.getByRole("spinbutton", { name: "Y" }).fill("540");
    const sharp = await softPixels(page, 540, 540);
    expect(sharp.row).toBeLessThanOrEqual(4);
    expect(sharp.col).toBeLessThanOrEqual(4);

    // Layer blur softens the square itself; back to 0 it is sharp again.
    const blur = right.getByRole("slider", { name: "Layer blur" });
    await blur.focus();
    await page.keyboard.press("End");
    const soft = await softPixels(page, 540, 540);
    expect(soft.row).toBeGreaterThan(150);
    expect(soft.col).toBeGreaterThan(150);
    await blur.focus();
    await page.keyboard.press("Home");
    expect((await softPixels(page, 540, 540)).row).toBeLessThanOrEqual(4);

    // Effects from the Blur category, as a layer over everything below.
    const pick = async (query: string, name: string) => {
      const change = right.getByRole("button", { name: "Change…" });
      if (await change.count()) await change.click();
      else await left.getByRole("button", { name: "Effect…" }).click();
      await page.getByLabel("Search effects").fill(query);
      await page.keyboard.press("Enter");
      await expect(layerNames(page).first()).toContainText(name);
    };
    await pick("gaussian", "Gaussian Blur");
    const gauss = await softPixels(page, 540, 540);
    expect(gauss.row).toBeGreaterThan(40);
    expect(gauss.col).toBeGreaterThan(40);

    // Motion blur at 0°: the vertical edges smear sideways, the horizontal ones stay sharp.
    await pick("motion blur", "Motion Blur");
    const motion = await softPixels(page, 540, 540);
    expect(motion.row).toBeGreaterThan(80);
    expect(motion.col).toBeLessThanOrEqual(6);

    // Tilt-shift: sharp in the band around 55 % down (row 600), blurred above it (the top edge at 340).
    await pick("tilt", "Tilt-Shift");
    const tilt = await softPixels(page, 540, 600);
    expect(tilt.row).toBeLessThanOrEqual(6);
    expect(tilt.col).toBeGreaterThan(20);

    // Zoom blur from the centre streaks the edges outwards; lens blur softens every edge.
    await pick("zoom blur", "Zoom Blur");
    expect((await softPixels(page, 540, 540)).row).toBeGreaterThan(30);
    await pick("lens blur", "Lens Blur");
    const lens = await softPixels(page, 540, 540);
    expect(lens.row).toBeGreaterThan(30);
    expect(lens.col).toBeGreaterThan(30);
  });
});

/** Layer names as listed, top first (children of open groups included). */
const order = (page: Page) => page.locator(".layer-list .layer-row .name").allTextContents();
const row = (page: Page, name: string) => page.locator(".layer-list .layer-row").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

/** A mouse drag from the middle of one box to a point, in small steps (the drag starts after a few pixels). */
async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, finish: "up" | "escape" = "up") {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 6, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.waitForTimeout(80);
  if (finish === "escape") await page.keyboard.press("Escape");
  await page.mouse.up();
}
const mid = async (l: ReturnType<Page["locator"]>) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y, bottom: b.y + b.height };
};

test.describe("computer: reordering layers", () => {
  test("a colour typed for one layer is saved to that layer when another is clicked", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    await left.getByRole("button", { name: "Add rectangle", exact: true }).click();
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#ff0000");
    await left.getByRole("button", { name: "Add ellipse", exact: true }).click();
    // A short code is only saved when the field is left: here, by clicking the other layer.
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#0f0");
    await row(page, "Rectangle").locator(".name").click();
    await expect(right.getByRole("textbox", { name: "Fill colour" })).toHaveValue("#ff0000");
    await row(page, "Ellipse").locator(".name").click();
    await expect(right.getByRole("textbox", { name: "Fill colour" })).toHaveValue("#00ff00");
  });

  test("drag rows, drop into a group, arrange from the menu, shortcuts and the grip; the render follows", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    // A red square under a blue circle of the same size: the circle hides most of it.
    await left.getByRole("button", { name: "Add rectangle", exact: true }).click();
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#ff0000");
    await left.getByRole("button", { name: "Add ellipse", exact: true }).click();
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#0000ff");
    expect(await order(page)).toEqual(["Ellipse", "Rectangle"]);
    const red = "r > 200 && g < 60 && b < 60";
    const blue = "r < 60 && g < 60 && b > 200";
    const before = { red: await count(page, red), blue: await count(page, blue) };
    expect(before.blue).toBeGreaterThan(before.red);

    // Drag the square's row above the circle's: the square now covers the circle.
    const square = await mid(row(page, "Rectangle"));
    const circle = await mid(row(page, "Ellipse"));
    await mouseDrag(page, square, { x: circle.x, y: circle.top + 3 });
    expect(await order(page)).toEqual(["Rectangle", "Ellipse"]);
    expect(await count(page, blue)).toBeLessThan(50);
    expect(await count(page, red)).toBeGreaterThan(before.red + before.blue / 2);
    // One undo step puts it back; Escape cancels a drag.
    await page.keyboard.press("Control+z");
    expect(await order(page)).toEqual(["Ellipse", "Rectangle"]);
    const s2 = await mid(row(page, "Rectangle"));
    const c2 = await mid(row(page, "Ellipse"));
    await mouseDrag(page, s2, { x: c2.x, y: c2.top + 3 }, "escape");
    expect(await order(page)).toEqual(["Ellipse", "Rectangle"]);

    // Arrange from the layer menu, which knows what can't move. (New layers go above the selected one.)
    await left.getByRole("button", { name: "Add star", exact: true }).click();
    expect(await order(page)).toEqual(["Ellipse", "Star", "Rectangle"]);
    await row(page, "Rectangle").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Bring to Front/ }).click();
    expect(await order(page)).toEqual(["Rectangle", "Ellipse", "Star"]);
    await row(page, "Rectangle").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: /^Bring to Front/ })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: /^Bring Forward/ })).toBeDisabled();
    await page.getByRole("menuitem", { name: /^Send Backward/ }).click();
    expect(await order(page)).toEqual(["Ellipse", "Rectangle", "Star"]);

    // Shortcuts: Ctrl+Shift+[ to the back, Ctrl+] forward.
    await row(page, "Ellipse").locator(".name").click();
    await page.keyboard.press("Control+Shift+BracketLeft");
    expect(await order(page)).toEqual(["Rectangle", "Star", "Ellipse"]);
    await page.keyboard.press("Control+BracketRight");
    expect(await order(page)).toEqual(["Rectangle", "Ellipse", "Star"]);

    // The grip moves a step with the arrow keys.
    await page.getByRole("button", { name: "Reorder Rectangle" }).focus();
    await page.keyboard.press("ArrowDown");
    expect(await order(page)).toEqual(["Ellipse", "Rectangle", "Star"]);

    // Several selected layers drag together, keeping their order.
    await row(page, "Ellipse").locator(".name").click();
    await row(page, "Rectangle").locator(".name").click({ modifiers: ["Control"] });
    const pair = await mid(row(page, "Ellipse"));
    const bottom = await mid(row(page, "Star"));
    await mouseDrag(page, pair, { x: bottom.x, y: bottom.bottom - 3 });
    expect(await order(page)).toEqual(["Star", "Ellipse", "Rectangle"]);
    // Both stay selected.
    await expect(page.locator(".layer-list .layer-row[aria-selected='true']")).toHaveCount(2);

    // Group the star and the circle, then drop the square onto the group: it goes inside.
    await row(page, "Star").locator(".name").click();
    await row(page, "Ellipse").locator(".name").click({ modifiers: ["Control"] });
    await page.keyboard.press("Control+g");
    const group = page.locator(".layer-list .layer-row[data-kind='group']");
    await expect(group).toHaveCount(1);
    const groupName = (await group.locator(".name").textContent())!;
    // New groups open; closed, the middle of the row means "into".
    expect(await order(page)).toEqual([groupName, "Star", "Ellipse", "Rectangle"]);
    await group.getByRole("button", { name: "Collapse group" }).click();
    expect(await order(page)).toEqual([groupName, "Rectangle"]);
    const g = await mid(group);
    await mouseDrag(page, await mid(row(page, "Rectangle")), { x: g.x, y: g.y });
    expect(await order(page)).toEqual([groupName]);
    await group.getByRole("button", { name: "Expand group" }).click();
    // Dropped in, it sits on top of the group's layers.
    expect(await order(page)).toEqual([groupName, "Rectangle", "Star", "Ellipse"]);
    await expect(row(page, "Rectangle")).toHaveAttribute("data-depth", "1");

    // And out again with the grip, below everything.
    const grip = await mid(page.getByRole("button", { name: "Reorder Rectangle" }));
    const last = await mid(row(page, "Ellipse"));
    await mouseDrag(page, grip, { x: last.x, y: last.bottom + 30 });
    expect(await order(page)).toEqual([groupName, "Star", "Ellipse", "Rectangle"]);
    await expect(row(page, "Rectangle")).toHaveAttribute("data-depth", "0");

  });
});

test.describe("phone: reordering layers", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("a finger drags a layer by its grip; the menu arranges; the list doesn't scroll away", async ({ page }) => {
    await fresh(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("button", { name: /^Instagram post 1080/ }).tap();
    const dock = page.getByRole("navigation", { name: "Panels" });
    const sheet = page.getByTestId("sheet");
    await dock.getByRole("button", { name: "Add" }).tap();
    for (const n of ["rectangle", "ellipse", "star"]) await sheet.getByRole("button", { name: `Add ${n}`, exact: true }).tap();
    await dock.getByRole("button", { name: "Layers" }).tap();
    expect(await order(page)).toEqual(["Star", "Ellipse", "Rectangle"]);
    // The grip is big enough for a finger.
    const gripBox = (await sheet.getByRole("button", { name: "Reorder Rectangle" }).boundingBox())!;
    expect(gripBox.width).toBeGreaterThanOrEqual(30);
    expect(gripBox.height).toBeGreaterThanOrEqual(30);

    // Real touch input: press the Rectangle's grip and drag it above the Star.
    const cdp = await page.context().newCDPSession(page);
    const from = { x: gripBox.x + gripBox.width / 2, y: gripBox.y + gripBox.height / 2 };
    const star = (await row(page, "Star").boundingBox())!;
    const to = { x: from.x, y: star.y + 4 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + ((to.y - from.y) * i) / 12 }] });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await order(page)).toEqual(["Rectangle", "Star", "Ellipse"]);
    // Not select mode: a drag on the grip only reorders.
    await expect(page.getByRole("navigation", { name: "Selection" })).toHaveCount(0);

    // Long-press a row for select mode; its actions include Arrange.
    const ellipse = await mid(row(page, "Ellipse"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: ellipse.x, y: ellipse.y }] });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const bar = page.getByRole("navigation", { name: "Selection" });
    await expect(bar).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Reorder Ellipse" })).toBeHidden();
    await bar.getByRole("button", { name: "Actions" }).tap();
    await page.getByRole("menuitem", { name: /^Bring to Front/ }).tap();
    expect(await order(page)).toEqual(["Ellipse", "Rectangle", "Star"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

/** Average brightness (0–255) of small squares around document points, from an exported PNG. */
async function exportedLuma(page: Page, points: [number, number][]) {
  await page.getByRole("toolbar", { name: "Design tools" }).getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Export/ });
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  const png = readFileSync(await file.path()).toString("base64");
  return page.evaluate(
    async ([b64, pts]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      return pts.map(([x, y]) => {
        const d = g.getImageData(x - 10, y - 10, 20, 20).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (d.length / 4);
      });
    },
    [png, points] as const,
  );
}

test.describe("computer: yes / but template", () => {
  test("one photo fills both frames; the lower one shows it before its Develop edits, after a reload too", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("searchbox").first().fill("yes but");
    await page.locator(".template-card", { hasText: "Yes / but (edit vs. as shot)" }).click();
    await expect(layerNames(page)).toHaveCount(4);
    const right = page.locator("aside.side.right");
    // The lower frame is set to show the photo as shot.
    await row(page, "Before edits").locator(".name").click();
    await expect(right.getByRole("checkbox", { name: /Before edits/ })).toBeChecked();
    await row(page, "Edited photo").locator(".name").click();
    await expect(right.getByRole("checkbox", { name: /Before edits/ })).not.toBeChecked();

    // One photo in the upper frame fills the lower one too, in one undo step.
    await right.getByRole("button", { name: "Add photo…" }).click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "From this device…" }).click()]);
    await chooser.setFiles(await jpeg(page, "#707070"));
    await expect(right.getByRole("button", { name: "Replace photo…" })).toBeVisible({ timeout: 30_000 });
    await row(page, "Before edits").locator(".name").click();
    await expect(right.getByRole("button", { name: "Replace photo…" })).toBeVisible();
    // Frame centres: upper (540, 345), lower (540, 1004).
    const centres: [number, number][] = [[540, 345], [540, 1004]];
    const [a, b] = await exportedLuma(page, centres);
    expect(Math.abs(a - b)).toBeLessThan(4);

    // Brighten the photo in Develop: only the upper frame follows.
    await go(page, "Library");
    await page.locator(".cell").first().click();
    await page.keyboard.press("d");
    const exposure = page.getByRole("slider", { name: "Exposure" });
    await expect(exposure).toBeVisible();
    await exposure.focus();
    for (let i = 0; i < 15; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(1500);
    await go(page, "Design");
    // Design shows the open design, or its home: wait for one, then open the design if needed.
    await expect(page.locator(".design-tile, .layer-list .layer-row").first()).toBeVisible();
    const tile = page.locator(".design-tile").first();
    if (await tile.isVisible()) await tile.getByRole("button", { name: /^Open/ }).click();
    await expect(layerNames(page)).toHaveCount(4);
    const [edited, asShot] = await exportedLuma(page, centres);
    expect(edited).toBeGreaterThan(asShot + 40);
    expect(Math.abs(asShot - b)).toBeLessThan(4);

    // The setting is data: it survives a reload.
    await page.waitForTimeout(1200);
    await page.reload();
    await go(page, "Design");
    // After a reload Design starts at its home: open the design from there.
    await page.locator(".design-tile").first().getByRole("button", { name: /^Open/ }).click();
    await expect(layerNames(page)).toHaveCount(4);
    const [edited2, asShot2] = await exportedLuma(page, centres);
    expect(Math.abs(edited2 - edited)).toBeLessThan(4);
    expect(Math.abs(asShot2 - asShot)).toBeLessThan(4);
  });
});

/** The open document's layers (top-level), read from the app. */
const docLayers = (page: Page) =>
  page.evaluate(async () => {
    const { composite } = await import("/src/core/document/session.ts" as string);
    return JSON.parse(JSON.stringify(composite.getState().doc.layers)) as { name: string; kind: string; transform: { x: number; width: number; height: number }; style: Record<string, unknown>; shape?: { kind: string; points: number; round: number }; fx?: { shadow?: { color: string; blur: number } } }[];
  });
const byName = async (page: Page, name: string) => (await docLayers(page)).find((l) => l.name === name)!;

test.describe("computer: editing several layers at once", () => {
  test("a change goes to every selected layer it fits, keeping each one's own other settings", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    await left.getByRole("button", { name: "Add rectangle", exact: true }).click();
    await right.getByRole("spinbutton", { name: "X" }).fill("300");
    // The rectangle gets a red shadow of its own first.
    await right.getByRole("checkbox", { name: "Shadow" }).check();
    await right.getByRole("textbox", { name: "Shadow colour" }).fill("#ff0000");
    await left.getByRole("button", { name: "Add star", exact: true }).click();
    await right.getByRole("spinbutton", { name: "X" }).fill("700");
    const before = { rect: await byName(page, "Rectangle"), star: await byName(page, "Star") };

    // Select both (the star last: it is the one shown).
    await row(page, "Rectangle").locator(".name").click();
    await row(page, "Star").locator(".name").click({ modifiers: ["Control"] });
    await expect(right.getByText(/2 layers selected/)).toBeVisible();

    // Fill colour: both.
    await right.getByRole("textbox", { name: "Fill colour" }).fill("#00aa55");
    await expect.poll(async () => (await byName(page, "Rectangle")).style.fill).toBe("#00aa55");
    expect((await byName(page, "Star")).style.fill).toBe("#00aa55");

    // Star points: only the star; the rectangle stays a rectangle. Rounding fits both.
    const points = right.getByRole("slider", { name: "Points" });
    await points.focus();
    await page.keyboard.press("ArrowRight");
    expect((await byName(page, "Star")).shape!.points).toBe(before.star.shape!.points + 1);
    expect((await byName(page, "Rectangle")).shape).toEqual(before.rect.shape);
    const rounding = right.getByRole("slider", { name: "Rounding" });
    await rounding.focus();
    await page.keyboard.press("End");
    expect((await byName(page, "Star")).shape!.round).toBe(1);
    expect((await byName(page, "Rectangle")).shape!.round).toBe(1);
    expect((await byName(page, "Rectangle")).shape!.kind).toBe("rectangle");

    // Shadow on: the star gets one, the rectangle keeps its red one. A tweak changes only the blur on both.
    await right.getByRole("checkbox", { name: "Shadow" }).check();
    expect((await byName(page, "Star")).fx!.shadow!.color).toBe("#000000");
    expect((await byName(page, "Rectangle")).fx!.shadow!.color).toBe("#ff0000");
    const blur = right.locator(".style-group").getByRole("slider", { name: "Blur" });
    await blur.focus();
    await page.keyboard.press("End");
    const starBlur = (await byName(page, "Star")).fx!.shadow!.blur;
    expect((await byName(page, "Rectangle")).fx!.shadow!.blur).toBe(starBlur);
    expect((await byName(page, "Rectangle")).fx!.shadow!.color).toBe("#ff0000");

    // Position moves both by the same amount; width applies to each.
    await right.getByRole("spinbutton", { name: "X" }).fill("750");
    await right.getByRole("spinbutton", { name: "X" }).press("Enter");
    await expect.poll(async () => (await byName(page, "Star")).transform.x).toBe(750);
    expect((await byName(page, "Rectangle")).transform.x).toBe(350);
    await right.getByRole("spinbutton", { name: "W" }).fill("200");
    await right.getByRole("spinbutton", { name: "W" }).press("Enter");
    await expect.poll(async () => (await byName(page, "Rectangle")).transform.width).toBe(200);
    expect((await byName(page, "Star")).transform.width).toBe(200);

    // One undo step per change.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await byName(page, "Rectangle")).transform.width).toBe(before.rect.transform.width);
    expect((await byName(page, "Star")).transform.width).toBe(before.star.transform.width);
  });

  test("text: styling goes to every selected text layer, the words stay with the one shown", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("button", { name: /^Instagram post 1080/ }).click();
    const left = page.locator("aside.side.left");
    const right = page.locator("aside.side.right");
    await left.getByRole("button", { name: "Subheading", exact: true }).click();
    await right.getByRole("textbox", { name: "Text", exact: true }).fill("First");
    await left.getByRole("button", { name: "Subheading", exact: true }).click();
    await right.getByRole("textbox", { name: "Text", exact: true }).fill("Second");
    await left.getByRole("button", { name: "Add rectangle", exact: true }).click();
    const rows = page.locator(".layer-list .layer-row");
    // Select everything; the last text layer is shown.
    await rows.nth(0).locator(".name").click();
    await rows.nth(2).locator(".name").click({ modifiers: ["Control"] });
    await rows.nth(1).locator(".name").click({ modifiers: ["Control"] });
    await right.getByRole("textbox", { name: "Text color" }).fill("#ff3300");
    await expect.poll(async () => (await docLayers(page)).filter((l) => l.kind === "text").map((l) => l.style.color)).toEqual(["#ff3300", "#ff3300"]);
    // The rectangle has no text colour: untouched, still a path with its fill.
    expect((await docLayers(page)).find((l) => l.kind === "path")!.style.color).toBeUndefined();
    await right.getByRole("textbox", { name: "Text", exact: true }).fill("Changed");
    await expect.poll(async () => (await docLayers(page)).filter((l) => l.kind === "text").map((l) => l.style.text).sort()).toEqual(["Changed", "First"]);
  });
});

test.describe("computer: slides from templates", () => {
  test("the template button adds slides of the same shape after the current one; + still adds a blank slide", async ({ page }) => {
    await fresh(page);
    await go(page, "Design");
    await page.getByRole("group", { name: "Size groups" }).getByRole("button", { name: "Carousels", exact: true }).click();
    await page.getByRole("button", { name: /^Carousel 4:5, 3 slides/ }).click();
    const bar = page.getByRole("toolbar", { name: "Slides" });
    await bar.getByRole("button", { name: "Slide 1", exact: true }).click();

    // The picker shows 4:5 templates only (no square or story ones).
    await bar.getByRole("button", { name: "Add slides from a template" }).click();
    const dialog = page.getByRole("dialog", { name: "Add slides from a template" });
    await expect(dialog).toContainText("4:5");
    await expect(dialog).toContainText("after slide 1");
    await expect(dialog.locator(".template-card", { hasText: "Yes / but (edit vs. as shot)" })).toBeVisible();
    await expect(dialog.locator(".template-card", { hasText: "Five tips" })).toContainText("5 slides");
    await expect(dialog.locator(".template-card", { hasText: "Quote card" })).toHaveCount(0);

    // One page: a new slide 2 holding the template, scaled to the slide.
    await dialog.locator(".template-card", { hasText: "Yes / but (edit vs. as shot)" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(bar.getByRole("button", { name: /^Slide \d+$/ })).toHaveCount(4);
    await expect(bar.getByRole("button", { name: "Slide 2", exact: true })).toHaveAttribute("aria-pressed", "true");
    const frames = (await docLayers(page)).filter((l) => l.kind === "slot");
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      expect(f.transform.x).toBeGreaterThan(1080);
      expect(f.transform.x).toBeLessThan(2160);
      expect(f.transform.width).toBe(1040);
    }
    // Its background is a rectangle behind slide 2 only.
    const back = (await docLayers(page)).find((l) => l.name.endsWith("background"))!;
    expect([back.transform.x, back.transform.width]).toEqual([1620, 1080]);

    // A carousel template adds all of its slides; one undo takes them away again.
    await bar.getByRole("button", { name: "Add slides from a template" }).click();
    await page.getByRole("dialog", { name: "Add slides from a template" }).locator(".template-card", { hasText: "Five tips" }).click();
    await expect(bar.getByRole("button", { name: /^Slide \d+$/ })).toHaveCount(9);
    await page.keyboard.press("Control+z");
    await expect(bar.getByRole("button", { name: /^Slide \d+$/ })).toHaveCount(4);

    // + still adds a blank slide.
    const before = (await docLayers(page)).length;
    await bar.getByRole("button", { name: "Add slide", exact: true }).click();
    await expect(bar.getByRole("button", { name: /^Slide \d+$/ })).toHaveCount(5);
    expect((await docLayers(page)).length).toBe(before);
  });
});

test.describe("phone: slides from templates", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("the template button and its picker fit the phone", async ({ page }) => {
    await fresh(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    await page.getByRole("button", { name: /^Instagram portrait/ }).tap();
    const bar = page.getByRole("toolbar", { name: "Slides" });
    const button = bar.getByRole("button", { name: "Add slides from a template" });
    await expect(button).toBeVisible();
    await button.tap();
    const dialog = page.getByRole("dialog", { name: "Add slides from a template" });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // A single design becomes a two-slide carousel.
    await dialog.locator(".template-card", { hasText: "Yes / but (edit vs. as shot)" }).tap();
    await expect(bar.getByRole("button", { name: /^Slide \d+$/ })).toHaveCount(2);
  });
});
