import { type CDPSession, expect, type Page, test } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

async function setup(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true }));
  });
  await page.goto("/");
  await page.evaluate(() => {
    indexedDB.deleteDatabase("focused-catalog");
    localStorage.removeItem("focused:edit-clipboard");
  });
  await page.reload();
  const files = [];
  for (let i = 0; i < 3; i++) {
    const b64 = await page.evaluate(async (hue) => {
      const c = new OffscreenCanvas(900, 600);
      const g = c.getContext("2d")!;
      const gr = g.createLinearGradient(0, 0, 900, 0);
      gr.addColorStop(0, `hsl(${hue} 50% 30%)`);
      gr.addColorStop(1, `hsl(${hue + 40} 60% 60%)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 900, 600);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    }, i * 110);
    files.push({ name: `IMG_${i + 1}.JPG`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  }
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import photos", exact: true }).tap()]);
  await chooser.setFiles(files);
  await expect(page.locator(".cell img")).toHaveCount(3, { timeout: 30_000 });
  return page.locator(".cell img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).alt));
}

async function toWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name }).tap();
}

async function openFirstInDevelop(page: Page) {
  await page.locator(".cell").first().tap();
  await toWorkspace(page, "Develop");
  await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
  const exposure = page.getByTestId("sheet").getByRole("slider", { name: "Exposure" });
  await expect(exposure).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 30_000 });
  return exposure;
}

test("copy a photo's edits and paste them onto several, no file involved", async ({ page }) => {
  const names = await setup(page);
  const exposure = await openFirstInDevelop(page);
  await exposure.focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press("Shift+ArrowRight");
  const value = await exposure.getAttribute("aria-valuenow");
  expect(value).not.toBe("0");

  await page.getByRole("button", { name: "More", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Copy Edits" }).tap();
  await expect(page.locator(".toast")).toContainText(`Copied the edits of ${names[0]}`);

  // In the Library: select the other two and paste onto both at once.
  await toWorkspace(page, "Library");
  const thumbs = page.locator(".cell img");
  const before = await thumbs.nth(1).getAttribute("src");
  await page.getByRole("banner").getByRole("button", { name: "Select" }).tap();
  await page.locator(".cell").nth(1).tap();
  await page.locator(".cell").nth(2).tap();
  const bar = page.getByRole("navigation", { name: "Selection" });
  await bar.getByRole("button", { name: "Actions" }).tap();
  await page.getByRole("menuitem", { name: `Paste Edits of ${names[0]} to 2 Photos` }).tap();
  await expect(page.locator(".toast").last()).toContainText("to 2 photos");
  // Their thumbnails are re-rendered in the background.
  await expect.poll(() => thumbs.nth(1).getAttribute("src"), { timeout: 30_000 }).not.toBe(before);
  await bar.getByRole("button", { name: "Done" }).tap();

  // Opening one shows the pasted value.
  await page.locator(".cell").nth(2).tap();
  await toWorkspace(page, "Develop");
  await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
  await expect(page.getByTestId("sheet").getByRole("slider", { name: "Exposure" })).toHaveAttribute("aria-valuenow", value!, { timeout: 30_000 });

  // The copied edits survive a reload.
  await page.reload();
  await expect(page.locator(".cell img")).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("banner").getByRole("button", { name: "Select" }).tap();
  await page.locator(".cell").nth(1).tap();
  await page.getByRole("navigation", { name: "Selection" }).getByRole("button", { name: "Actions" }).tap();
  await expect(page.getByRole("menuitem", { name: new RegExp(`^Paste Edits of ${names[0].replace(".", "\\.")}( |$)`) })).toBeEnabled();
});

/** A finger held still on the photo for `ms`, released afterwards by the caller. */
async function holdFinger(cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
}

test("press and hold the photo to see the original", async ({ page }) => {
  await setup(page);
  const exposure = await openFirstInDevelop(page);
  await exposure.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap(); // close the sheet
  // The filmstrip comes back and the viewer resizes: measure once that has settled.
  await expect(page.getByTestId("sheet")).toHaveCount(0);
  await expect(page.locator(".film-cell").first()).toBeVisible();
  await page.waitForTimeout(300);
  const view = page.locator(".develop-view");
  const box = (await view.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.waitForTimeout(500);
  const edited = await view.screenshot();

  const cdp = await page.context().newCDPSession(page);
  await holdFinger(cdp, x, y);
  const label = page.getByRole("status").filter({ hasText: "Original" });
  await expect(label).toBeVisible();
  await page.waitForTimeout(300);
  const original = await view.screenshot();
  expect(original.equals(edited)).toBe(false);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(label).toHaveCount(0);

  // A quick tap is not a hold.
  await view.tap({ position: { x: box.width / 2, y: box.height / 3 } });
  await page.waitForTimeout(450);
  await expect(label).toHaveCount(0);
  // The mouse held down works too.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(label).toBeVisible();
  await page.mouse.up();
  await expect(label).toHaveCount(0);
});

test("the next photo is decoded ahead, so swiping to it never waits", async ({ page }) => {
  await setup(page);
  await openFirstInDevelop(page);
  await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
  // Give the background preload a moment.
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const w = window as unknown as { sawDecoding: boolean };
    w.sawDecoding = false;
    new MutationObserver(() => {
      if (document.querySelector(".develop-status")) w.sawDecoding = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator(".develop-view").boundingBox())!;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 330, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 330 - i * 27, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const canvas = page.locator("canvas.develop-canvas");
  await expect.poll(() => canvas.evaluate((el) => [el.style.transform, el.style.visibility]), { timeout: 10_000 }).toEqual(["", ""]);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { sawDecoding: boolean }).sawDecoding)).toBe(false);
});
