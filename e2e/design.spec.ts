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
    await sheet.getByRole("button", { name: "Neon" }).tap();
    await dock.getByRole("button", { name: "Layers" }).tap();
    await expect(sheet.getByRole("listbox", { name: "Layers" }).getByRole("option")).toHaveCount(1);
    await expect(sheet.getByRole("listbox", { name: "Layers" }).getByRole("option").first()).toContainText("NEON");

    // Designs goes back to the home, where the design is listed.
    await dock.getByRole("button", { name: "Designs" }).tap();
    await expect(page.locator(".design-tile")).toHaveCount(1, { timeout: 5000 });
  });
});
