import { type CDPSession, expect, type Page, test } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true })));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const files = [];
  for (let i = 0; i < 3; i++) {
    const b64 = await page.evaluate(async (hue) => {
      const c = new OffscreenCanvas(900, 600);
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${hue} 60% 55%)`;
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
  // The order the Library shows them in.
  return page.locator(".cell img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).alt));
}

/** A finger dragged from x0 to x1 across the middle of `box`, in `steps` moves of `stepMs`; `release` false keeps it down. */
async function swipe(page: Page, cdp: CDPSession, y: number, x0: number, x1: number, { steps = 10, stepMs = 16, release = true } = {}) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }] });
    await page.waitForTimeout(stepMs);
  }
  if (release) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("Library loupe: swipe through photos like a gallery", async ({ page }) => {
  const names = await setup(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator(".cell").first().tap();
  await page.getByRole("toolbar", { name: "Library view" }).getByRole("button", { name: "Loupe" }).tap();
  const caption = page.locator(".loupe-info strong");
  await expect(caption).toHaveText(names[0]);
  const box = (await page.locator(".loupe").boundingBox())!;
  const y = box.y + box.height / 2;

  // Mid-swipe, the photo follows the finger and the next one is already beside it.
  await swipe(page, cdp, y, box.x + 300, box.x + 200, { release: false });
  const shown = page.locator(".loupe > img");
  expect(await shown.evaluate((el) => el.style.transform)).toMatch(/translate3d\(-\d/);
  const next = page.locator('.gallery-slide[data-side="next"]');
  await expect(next).toBeVisible();
  await expect(next.locator("img")).toHaveCount(1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // A short, slow drag springs back.
  await expect(caption).toHaveText(names[0]);
  await expect.poll(() => shown.evaluate((el) => el.style.transform)).toBe("");

  // Past a third of the way: the next photo.
  await swipe(page, cdp, y, box.x + 330, box.x + 60);
  await expect(caption).toHaveText(names[1]);
  await expect(page.locator(".cell")).toHaveCount(0); // still the loupe
  // A quick flick counts too, even a short one, and goes back.
  await swipe(page, cdp, y, box.x + 100, box.x + 190, { steps: 4, stepMs: 8 });
  await expect(caption).toHaveText(names[0]);
  // Nothing before the first photo: the drag gives, then settles back.
  await swipe(page, cdp, y, box.x + 60, box.x + 330);
  await expect(caption).toHaveText(names[0]);
  await expect.poll(() => page.locator(".loupe > img").evaluate((el) => el.style.transform)).toBe("");
  // A vertical drag is not a swipe.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 200, y: y - 80 }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 200 - i * 4, y: y - 80 + i * 20 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(caption).toHaveText(names[0]);
});

test("Develop: swipe to the next photo; the preview holds until the new one is drawn", async ({ page }) => {
  const names = await setup(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator(".cell").first().tap();
  await page.getByRole("button", { name: /^Workspace:/ }).tap();
  await page.getByRole("menuitemradio", { name: "Develop" }).tap();
  const active = page.locator('.film-cell[data-active="true"] img');
  await expect(active).toHaveAttribute("alt", names[0], { timeout: 30_000 });
  await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 30_000 });
  const view = (await page.locator(".develop-view").boundingBox())!;
  const y = view.y + view.height / 2;

  await swipe(page, cdp, y, view.x + 330, view.x + 60);
  await expect(active).toHaveAttribute("alt", names[1]);
  // Once the new photo is drawn the canvas is back in place and the preview gone.
  const canvas = page.locator("canvas.develop-canvas");
  await expect.poll(() => canvas.evaluate((el) => [el.style.transform, el.style.visibility]), { timeout: 30_000 }).toEqual(["", ""]);
  await expect(page.locator('.gallery-slide[data-side="next"]')).toBeHidden();
  // And back.
  await swipe(page, cdp, y, view.x + 60, view.x + 330);
  await expect(active).toHaveAttribute("alt", names[0]);

  // Zoomed in, a drag pans instead (a double tap toggles 100 %).
  await page.locator(".develop-view").tap();
  await page.locator(".develop-view").tap();
  await expect(page.locator(".toolbar .dim.num").first()).not.toHaveText("Fit");
  await swipe(page, cdp, y, view.x + 330, view.x + 60);
  await expect(active).toHaveAttribute("alt", names[0]);
});
