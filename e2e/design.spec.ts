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
    await bar.getByRole("button", { name: "Add slide" }).click();
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
