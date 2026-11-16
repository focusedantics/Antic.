import { expect, type Page, test } from "@playwright/test";

const setPrefs = (page: Page, prefs: { backdrop?: boolean; tourDone?: boolean }) =>
  page.addInitScript((p) => {
    // Only on the first load of the test, so the app's own changes survive a reload.
    if (!sessionStorage.getItem("prefs-seeded")) {
      localStorage.setItem("focused:prefs", JSON.stringify(p));
      sessionStorage.setItem("prefs-seeded", "1");
    }
  }, prefs);

/** Mean RGB of a screen region, read from a real screenshot (what a person sees). */
async function meanColor(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    const px = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += px[i + k];
    const n = px.length / 4;
    return sum.map((v) => v / n) as [number, number, number];
  }, png);
}

const card = (page: Page) => page.getByTestId("tour").getByRole("dialog");

test("tour: welcomes a first visit; Skip closes it for good", async ({ page }) => {
  await setPrefs(page, { backdrop: false });
  await page.goto("/");
  await expect(card(page)).toContainText("Welcome to Focused");
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Your library is empty")).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("tour")).toHaveCount(0);
});

test("tour: spotlights the real UI, moves through workspaces, skips chapters and replays from the ? button", async ({ page }) => {
  await setPrefs(page, { backdrop: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Start tour" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Four workspaces");
  // The spotlight frames the workspace switcher.
  await expect(page.locator(".tour-spot.on")).toBeVisible();
  await page.waitForTimeout(500);
  const spot = (await page.locator(".tour-spot").boundingBox())!;
  const modules = (await page.locator(".modules").boundingBox())!;
  expect(Math.abs(spot.x + 6 - modules.x)).toBeLessThan(2);
  expect(Math.abs(spot.width - 12 - modules.width)).toBeLessThan(2);

  // Arrow keys drive the tour and do not reach the app's own shortcuts.
  await page.keyboard.press("ArrowRight");
  await expect(card(page).getByRole("heading")).toHaveText("Bring photos in");
  await page.keyboard.press("ArrowLeft");
  await expect(card(page).getByRole("heading")).toHaveText("Four workspaces");

  await page.getByRole("button", { name: "Skip chapter" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Develop");
  await expect(page.getByRole("button", { name: /^Develop/ })).toHaveAttribute("aria-current", "page");

  // Chapter dots jump around.
  await page.getByRole("button", { name: "Chapter 7: Video" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Video: the YTP editor");
  await expect(page.getByRole("button", { name: /^Video/ })).toHaveAttribute("aria-current", "page");

  // Esc closes and returns to where the tour started.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Library/ })).toHaveAttribute("aria-current", "page");

  // Replay a chapter from the discreet ? button.
  await page.getByRole("button", { name: "Tour and help" }).click();
  await page.getByRole("menuitem", { name: "5 · Effects & animation" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Effects and animation");
  await expect(page.getByRole("button", { name: /^Composite/ })).toHaveAttribute("aria-current", "page");

  // Finish: the last chapter ends with Done.
  await page.getByRole("button", { name: "Chapter 8: Export" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("You're set");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("tour")).toHaveCount(0);
});

test("glow backdrop: on by default, shows around the photo, changes per workspace, toggles off and stays off", async ({ page }) => {
  await setPrefs(page, { tourDone: true });
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  await expect(page.getByText("Your library is empty")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Glow background" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("backdrop")).toHaveAttribute("data-look", "library");

  // Import a photo and open it in Develop: the glow surrounds it; the photo itself is untouched.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  const jpeg = await page.evaluate(async () => {
    const c = new OffscreenCanvas(1200, 800);
    const g = c.getContext("2d")!;
    g.fillStyle = "#808080";
    g.fillRect(0, 0, 1200, 800);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  await chooser.setFiles({ name: "grey.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click();

  // Library: warm (amber and coral).
  const center = (await page.locator(".workspace .center").boundingBox())!;
  const band = { x: center.x, y: center.y + center.height - 120, width: center.width, height: 110 };
  await page.waitForTimeout(800);
  const library = await meanColor(page, band);
  expect(library[0]).toBeGreaterThan(library[2]);
  expect(Math.max(...library)).toBeGreaterThan(20); // brighter than the flat #0d0d0d surround

  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible();
  await expect(page.getByTestId("backdrop")).toHaveAttribute("data-look", "develop");
  const view = (await page.locator(".develop-view").boundingBox())!;
  const middle = { x: view.x + view.width / 2 - 20, y: view.y + view.height / 2 - 20, width: 40, height: 40 };
  // The strip above the 3:2 photo (the viewer is taller than the photo).
  const edge = { x: view.x + 2, y: view.y + 2, width: view.width - 4, height: 24 };
  await page.waitForTimeout(2500); // the look blends over ~1.2 s
  const developEdge = await meanColor(page, edge);
  const photoOn = await meanColor(page, middle);

  // Develop: cool (teal and blue), and different from Library.
  expect(developEdge[2]).toBeGreaterThan(developEdge[0]);

  // Off: the surround is the plain viewer grey again and the photo reads the same.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("backdrop")).toHaveCount(0);
  await page.waitForTimeout(300);
  const edgeOff = await meanColor(page, edge);
  const photoOff = await meanColor(page, middle);
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(edgeOff[k] - 13)).toBeLessThan(2); // #0d0d0d, exactly as before the glow existed
    expect(Math.abs(photoOn[k] - photoOff[k])).toBeLessThan(1);
  }
  expect(Math.abs(developEdge[0] - edgeOff[0]) + Math.abs(developEdge[2] - edgeOff[2])).toBeGreaterThan(2);

  await page.reload();
  await expect(page.getByRole("button", { name: "Glow background" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("backdrop")).toHaveCount(0);
});
