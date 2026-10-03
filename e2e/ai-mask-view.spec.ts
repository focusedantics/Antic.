import { expect, type Page, test } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Average brightness (0–255) of the Develop viewer as shown on screen. */
async function viewerBrightness(page: Page) {
  const png = await page.locator(".develop-view").screenshot();
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  }, png.toString("base64"));
}

async function importScene(page: Page, phone: boolean) {
  await page.addInitScript(() => {
    localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false }));
    localStorage.setItem("ai-quality", "offline");
  });
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(900, 600);
    const g = c.getContext("2d")!;
    g.fillStyle = "#7aa0d0";
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = "#c0603a";
    g.beginPath();
    g.arc(450, 330, 170, 0, 7);
    g.fill();
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const name = phone ? "Import photos" : "Import Photos…";
  const button = page.getByRole("button", { name, exact: true });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), phone ? button.tap() : button.click()]);
  await chooser.setFiles({ name: "scene.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
}

for (const phone of [false, true])
  test.describe(phone ? "phone" : "computer", () => {
    if (phone) test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

    test("Select Subject shows the photo with the selection over it, never a black viewer", async ({ page }) => {
      await importScene(page, phone);
      if (phone) {
        await page.locator(".cell").first().tap();
        await page.getByRole("button", { name: /^Workspace:/ }).tap();
        await page.getByRole("menuitemradio", { name: "Develop" }).tap();
        await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 30_000 });
        await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Masks" }).tap();
      } else {
        await page.locator(".cell").first().click();
        await page.keyboard.press("d");
        await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("toolbar", { name: "Develop tools" }).getByRole("button", { name: "Masks" }).click();
      }
      await page.waitForTimeout(800);
      const before = await viewerBrightness(page);
      const create = page.getByRole("button", { name: "+ Create" });
      if (phone) await create.tap();
      else await create.click();
      const item = page.getByRole("menuitem", { name: "Select Subject" });
      if (phone) await item.tap();
      else await item.click();
      await expect(page.getByText("AI: Subject").first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(800);
      const after = await viewerBrightness(page);
      // The red selection overlay tints the subject; the photo itself is still there.
      expect(after).toBeGreaterThan(before * 0.6);
    });
  });
