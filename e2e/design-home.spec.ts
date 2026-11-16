import { expect, type Page, test } from "@playwright/test";

/**
 * The Design home leads with your own designs: the newest as a shelf (the latest marked
 * Continue), all of them behind "All designs", and a search that covers them too.
 */
async function seeded(page: Page, count: number) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  await page.evaluate(async (count) => {
    const { putDocument } = await import("/src/core/catalog/db.ts" as string);
    const { createDocument } = await import("/src/core/document/operations.ts" as string);
    for (let i = 0; i < count; i++) {
      const c = new OffscreenCanvas(90, i % 2 ? 160 : 90);
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${i * 40} 70% 50%)`;
      g.fillRect(0, 0, c.width, c.height);
      const d = { ...createDocument(1080, i % 2 ? 1920 : 1080), id: `seed-${i}`, name: i === 3 ? "Bake sale" : `Design ${i + 1}`, purpose: "design", folder: i % 3 === 0 ? "Clients" : "" };
      await putDocument({ id: d.id, name: d.name, updatedAt: Date.now() - i * 3_600_000, data: d, thumb: await c.convertToBlob({ type: "image/png" }) });
    }
  }, count);
  await page.reload();
}

test("computer: your designs come first, newest leading; all of them and a search are one step away", async ({ page }) => {
  await seeded(page, 15);
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
  const yours = page.getByRole("region", { name: /^Your designs/ });
  await expect(yours).toBeVisible();
  // Above the sizes and the templates, without scrolling.
  const top = async (name: string | RegExp) => (await page.getByRole("heading", { name }).boundingBox())!.y;
  expect(await top(/^Your designs/)).toBeLessThan(await top("Start with a size"));
  expect(await top("Start with a size")).toBeLessThan(await top("Templates"));
  expect(await top(/^Your designs/)).toBeLessThan(250);

  // The shelf: the twelve newest, the latest larger and marked.
  const tiles = yours.locator(".design-tile");
  await expect(tiles).toHaveCount(12);
  await expect(tiles.first()).toContainText("Design 1");
  await expect(tiles.first()).toContainText("Continue");
  await expect(tiles.first()).toContainText("1080 × 1080 px");
  await expect(tiles.nth(1)).toContainText("1 h ago");
  await expect(tiles.first().locator("img")).toBeVisible();
  // A tall design does not stretch its tile: every thumbnail is the same square.
  const a = (await tiles.nth(1).locator(".design-thumb").boundingBox())!;
  const b = (await tiles.nth(2).locator(".design-thumb").boundingBox())!;
  expect(Math.abs(a.height - a.width)).toBeLessThan(1);
  expect(Math.abs(a.height - b.height)).toBeLessThan(1);

  // All of them, by folder.
  await yours.getByRole("button", { name: "All designs (15)" }).click();
  await expect(tiles).toHaveCount(15);
  await yours.getByRole("button", { name: "Clients" }).click();
  await expect(tiles).toHaveCount(5);
  await yours.getByRole("button", { name: "Show recent" }).click();
  await expect(tiles).toHaveCount(12);

  // The search finds designs by name; one that matches nothing of yours leaves the rest of the page.
  await page.getByRole("searchbox", { name: "Search your designs, sizes and templates" }).fill("bake");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText("Bake sale");
  await page.getByRole("searchbox").first().fill("story");
  await expect(yours).toHaveCount(0);
  await expect(page.locator(".size-card", { hasText: "Story / Reel" })).toBeVisible();

  // A tile opens its design.
  await page.getByRole("searchbox").first().fill("");
  await tiles.first().getByRole("button", { name: "Open Design 1" }).click();
  await expect(page.getByRole("toolbar", { name: "Design tools" })).toBeVisible();
});

test("without designs the page starts with sizes and templates", async ({ page }) => {
  await seeded(page, 0);
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
  await expect(page.getByRole("heading", { name: "Start with a size" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Your designs/ })).toHaveCount(0);
  await expect(page.getByText("What you make is kept here.")).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
  test("the shelf fits the phone and scrolls sideways; the page does not", async ({ page }) => {
    await seeded(page, 6);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
    const yours = page.getByRole("region", { name: /^Your designs/ });
    const first = (await yours.locator(".design-tile").first().boundingBox())!;
    expect(first.x).toBeGreaterThanOrEqual(15);
    expect(first.y + first.height).toBeLessThan(664 - 56);
    const shelf = yours.locator(".design-shelf");
    expect(await shelf.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.locator(".design-home").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // The sizes are already in view under it.
    const sizes = (await page.getByRole("heading", { name: "Start with a size" }).boundingBox())!;
    expect(sizes.y).toBeLessThan(664 - 56);
    await yours.getByRole("button", { name: "All designs" }).tap();
    await expect(yours.locator(".design-tile")).toHaveCount(6);
    await expect(yours.locator(".design-grid")).toBeVisible();
  });
});
