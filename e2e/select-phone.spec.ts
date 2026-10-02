import { type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

async function fresh(page: Page) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true })));
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
}

async function importPhotos(page: Page, n: number) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const b64 = await page.evaluate(async (hue) => {
      const c = new OffscreenCanvas(600, 400);
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${hue} 60% 55%)`;
      g.fillRect(0, 0, 600, 400);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    }, i * 90);
    files.push({ name: `IMG_${i + 1}.JPG`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  }
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import photos", exact: true }).tap()]);
  await chooser.setFiles(files);
  await expect(page.locator(".cell img")).toHaveCount(n, { timeout: 30_000 });
}

/** Real touch input through the browser: a press (optionally held) that moves through points. */
async function finger(page: Page, cdp: CDPSession, points: [number, number][], holdMs = 0) {
  const [x, y] = points[0];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  if (holdMs) await page.waitForTimeout(holdMs);
  for (const [px, py] of points.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: px, y: py }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const center = async (l: Locator): Promise<[number, number]> => {
  const b = (await l.boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
};

test("Library: Select, tap to toggle, All/None, the batch actions, Done", async ({ page }) => {
  await fresh(page);
  await importPhotos(page, 3);
  const cells = page.locator(".cell");
  const bar = page.getByRole("navigation", { name: "Selection" });
  await page.getByRole("banner").getByRole("button", { name: "Select" }).tap();
  await expect(bar).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Panels" })).toHaveCount(0);
  await expect(bar).toContainText("Select photos");

  // Taps toggle, keeping the others.
  await cells.nth(0).tap();
  await cells.nth(2).tap();
  await expect(bar).toContainText("2 photos selected");
  await expect(cells.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(cells.nth(1)).toHaveAttribute("aria-selected", "false");
  await cells.nth(0).tap();
  await expect(bar).toContainText("1 photo selected");
  // A tap in select mode never opens the photo.
  await expect(page.locator(".loupe")).toHaveCount(0);

  await bar.getByRole("button", { name: "All" }).tap();
  await expect(bar).toContainText("3 photos selected");
  await bar.getByRole("button", { name: "Actions" }).tap();
  await expect(page.getByRole("menuitem", { name: "Export 3 photos…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await bar.getByRole("button", { name: "None" }).tap();
  await expect(bar).toContainText("Select photos");
  await expect(bar.getByRole("button", { name: "Actions" })).toBeDisabled();

  await bar.getByRole("button", { name: "Done" }).tap();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Panels" })).toBeVisible();
});

test("Library: holding a photo enters select mode with it; a sideways swipe sweeps across photos", async ({ page }) => {
  await fresh(page);
  await importPhotos(page, 3);
  const cdp = await page.context().newCDPSession(page);
  const cells = page.locator(".cell");
  const bar = page.getByRole("navigation", { name: "Selection" });

  // A quick tap is still a tap (no select mode).
  await cells.nth(1).tap();
  await expect(bar).toHaveCount(0);

  // A press held still: select mode, with that photo selected (and no menu).
  await finger(page, cdp, [await center(cells.nth(1))], 650);
  await expect(bar).toContainText("1 photo selected");
  await expect(cells.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Swipe sideways from the first photo across the second: both are added.
  const [ax, ay] = await center(cells.nth(0));
  const [bx] = await center(cells.nth(1));
  const path: [number, number][] = [[ax, ay]];
  for (let i = 1; i <= 8; i++) path.push([ax + ((bx - ax) * i) / 8, ay]);
  await cells.nth(1).tap(); // deselect it again: nothing selected
  await expect(bar).toContainText("Select photos");
  await finger(page, cdp, path);
  await expect(bar).toContainText("2 photos selected");
  await expect(cells.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(cells.nth(1)).toHaveAttribute("aria-selected", "true");

  // Switching workspace leaves select mode.
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name: "Develop" }).tap();
  await expect(bar).toHaveCount(0);
});

test("Composite: select layers in the Layers sheet and group them", async ({ page }) => {
  await fresh(page);
  await importPhotos(page, 2);
  // Two photos selected in the Library start a composition with two layers.
  await page.getByRole("banner").getByRole("button", { name: "Select" }).tap();
  await page.getByRole("navigation", { name: "Selection" }).getByRole("button", { name: "All" }).tap();
  await page.getByRole("navigation", { name: "Selection" }).getByRole("button", { name: "Done" }).tap();
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name: "Composite" }).tap();
  await page.getByRole("button", { name: /Start from 2 selected/ }).tap();
  const dock = page.getByRole("navigation", { name: "Panels" });
  await expect(dock.getByRole("button", { name: "Effects" })).toBeEnabled({ timeout: 15_000 });
  await dock.getByRole("button", { name: "Layers" }).tap();
  const rows = page.getByTestId("sheet").locator(".layer-row");
  await expect(rows).toHaveCount(2, { timeout: 15_000 });

  await page.getByTestId("sheet").getByRole("button", { name: "Select" }).tap();
  const bar = page.getByRole("navigation", { name: "Selection" });
  await expect(bar).toBeVisible();
  // Select starts from nothing; tapping a row toggles it (the sheet stays open above the bar).
  await expect(bar).toContainText("Select layers");
  await rows.nth(0).tap();
  await rows.nth(1).tap();
  await expect(bar).toContainText("2 layers selected");
  await bar.getByRole("button", { name: "Actions" }).tap();
  await page.getByRole("menuitem", { name: "Group 2 layers" }).tap();
  await expect(page.getByTestId("sheet").locator(".layer-row")).toHaveCount(3); // the group and its two layers
});

test("Video: select segments from the transport menu and delete them together", async ({ page }) => {
  await fresh(page);
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name: "Video" }).tap();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Video…" }).click()]);
  await chooser.setFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync("tests/fixtures/clip.mp4") });
  const segments = page.getByTestId("segment");
  await expect(segments).toHaveCount(1, { timeout: 30_000 });
  // Cut it in three.
  for (const steps of [15, 15]) {
    for (let i = 0; i < steps; i++) await page.getByRole("button", { name: "Next frame" }).tap();
    await page.getByRole("button", { name: "Split at the playhead" }).tap();
  }
  await expect(segments).toHaveCount(3);

  await page.getByRole("button", { name: "More playback options" }).tap();
  await page.getByRole("menuitem", { name: "Select segments" }).tap();
  const bar = page.getByRole("navigation", { name: "Selection" });
  await expect(bar).toContainText("Select segments");
  await segments.nth(0).tap();
  await segments.nth(2).tap();
  await expect(bar).toContainText("2 segments selected");
  await bar.getByRole("button", { name: "Actions" }).tap();
  await page.getByRole("menuitem", { name: "Delete 2 segments" }).tap();
  await expect(segments).toHaveCount(1);
});
