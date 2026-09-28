import { expect, type Page, test } from "@playwright/test";

/** Draws a synthetic photo in the page and returns it as a file payload. */
async function makeImage(page: Page, name: string, kind: "landscape" | "subject") {
  const base64 = await page.evaluate(async (k) => {
    const c = new OffscreenCanvas(1200, 800);
    const g = c.getContext("2d")!;
    if (k === "landscape") {
      const sky = g.createLinearGradient(0, 0, 0, 440);
      sky.addColorStop(0, "#3f73d8");
      sky.addColorStop(1, "#9cc2ee");
      g.fillStyle = sky;
      g.fillRect(0, 0, 1200, 440);
      g.fillStyle = "#3f7a33";
      g.fillRect(0, 440, 1200, 360);
      g.fillStyle = "#fff4c8";
      g.beginPath();
      g.arc(930, 150, 60, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillStyle = "#5f7d57";
      g.fillRect(0, 0, 1200, 800);
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `hsl(${90 + (i % 40)}, 30%, ${25 + (i % 30)}%)`;
        g.fillRect((i * 137) % 1200, (i * 71) % 800, 40, 40);
      }
      g.fillStyle = "#dc5a28";
      g.beginPath();
      g.ellipse(600, 450, 150, 260, 0, 0, Math.PI * 2);
      g.fill();
    }
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, kind);
  return { name, mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
}

async function freshLibrary(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
  await expect(page.getByText("Your library is empty")).toBeVisible();
}

async function importFiles(page: Page, files: Awaited<ReturnType<typeof makeImage>>[]) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles(files);
  await expect(page.locator(".cell img")).toHaveCount(files.length, { timeout: 30_000 });
}

test("library → develop → persistence", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape")]);
  await page.locator(".cell").first().click();
  await page.keyboard.press("4");
  await page.keyboard.press("p");
  await expect(page.locator(".cell .stars")).toHaveText("★★★★");
  await page.keyboard.press("d");
  const exposure = page.getByRole("slider", { name: "Exposure" });
  await expect(exposure).toBeVisible();
  await exposure.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(exposure).toHaveAttribute("aria-valuenow", "0.5");
  await expect(page.locator(".history-item")).toHaveText(["Exposure", "Open"]);
  await page.waitForTimeout(800);
  await page.reload();
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toHaveAttribute("aria-valuenow", "0.5");
});

test("masks: brush stroke with local adjustment", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape")]);
  await page.locator(".cell").first().click();
  await page.keyboard.press("d");
  // Develop loads lazily; its shortcuts exist once its panels are on screen.
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible();
  await page.keyboard.press("m");
  await page.getByRole("button", { name: "+ Create" }).click();
  await page.getByRole("menuitem", { name: "Brush", exact: true }).click();
  const box = (await page.locator(".develop-view").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".history-item").first()).toHaveText("Brush stroke");
});

test("composite: remove background of a photo placed over another, export PNG", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape"), await makeImage(page, "subject.jpg", "subject")]);
  await page.locator(".cell", { hasText: "landscape" }).click();
  await page.keyboard.press("c");
  await page.getByRole("button", { name: /Start from 1 selected/ }).click();
  await expect(page.locator(".layer-row")).toHaveCount(1);
  await page.locator(".film-cell").nth(1).dragTo(page.locator(".composite-view"), { targetPosition: { x: 450, y: 330 } });
  await expect(page.locator(".layer-row")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("button", { name: "Remove Background" }).click();
  await expect(page.locator(".toast")).toContainText("Background removed", { timeout: 60_000 });
  await page.getByLabel("Blend mode").selectOption("screen");
  await page.getByRole("button", { name: "Export…" }).click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
});

test("effects: browse, apply, edit, swap and export an effect layer", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "subject.jpg", "subject")]);
  await page.locator(".cell").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  const browser = page.getByRole("dialog", { name: "Effects" });
  await expect(browser).toBeVisible();
  // Live previews render from the photo itself.
  await expect(browser.locator(".fx-thumb img").first()).toBeVisible({ timeout: 60_000 });
  await browser.getByRole("button", { name: /Halftone & dither/ }).click();
  await expect(browser.locator(".fx-card")).toHaveCount(6);
  await browser.getByLabel("Search effects").fill("bricks");
  await browser.locator(".fx-card", { hasText: "Toy Bricks" }).click();
  await expect(browser).toBeHidden();
  await expect(page.locator(".layer-row").first()).toContainText("Toy Bricks");
  await page.getByLabel("Colors").selectOption("photo");
  await page.getByRole("button", { name: "Change…" }).click();
  await page.getByLabel("Search effects").fill("ascii");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-row").first()).toContainText("ASCII");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".layer-row").first()).toContainText("Toy Bricks");
  await page.getByRole("button", { name: "Export…" }).click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Export", exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/effects\.png$/);
});

test("video: import an MP4, trim, add an effect, lower quality and export", async ({ page }) => {
  await freshLibrary(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles("tests/fixtures/clip.mp4");
  // Videos open in the Video workspace.
  await expect(page.locator(".vid-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".doc-card")).toContainText("clip");
  const start = page.getByRole("slider", { name: "Trim start" });
  await start.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect(start).toHaveAttribute("aria-valuenow", "0.5");
  await page.getByRole("button", { name: "✦ Add effect…" }).click();
  await expect(page.locator(".fx-thumb img").first()).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Search effects").fill("halftone");
  await page.locator(".fx-card", { hasText: "CMYK Print" }).click();
  await expect(page.locator(".side.right")).toContainText("CMYK Print");
  await page.getByLabel("Quality").selectOption("low");
  await page.getByLabel("Frame rate").selectOption("15");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 90_000 }), page.getByRole("button", { name: "Export MP4…" }).first().click()]);
  expect(download.suggestedFilename()).toBe("clip-edit.mp4");
  await expect(page.getByRole("dialog")).toContainText("Saved");
  // The edit survives a reload.
  await page.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await page.getByRole("button", { name: /^Video/ }).click();
  await expect(page.getByRole("slider", { name: "Trim start" })).toHaveAttribute("aria-valuenow", "0.5", { timeout: 30_000 });
  await expect(page.locator(".side.right")).toContainText("CMYK Print");
});
