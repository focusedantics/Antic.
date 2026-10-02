import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
});

test("export marble: shows above the progress bar with a preview of the first frame, then goes away", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles("tests/fixtures/clip.mp4");
  await expect(page.getByTestId("viewer")).toBeVisible({ timeout: 30_000 });
  // A treatment makes the export re-encode every frame, so it runs long enough to watch.
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog");
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();

  const marble = dialog.getByTestId("export-marble");
  await expect(marble).toBeVisible();
  await expect(marble.locator("canvas")).toHaveCount(1);
  // The preview is the clip being exported.
  await expect(marble).toHaveAttribute("data-preview", /.+/);
  // Prominent, but never over the progress bar.
  const m = (await marble.boundingBox())!;
  const bar = (await dialog.getByRole("progressbar").boundingBox())!;
  expect(m.height).toBeGreaterThan(150);
  expect(m.y + m.height).toBeLessThanOrEqual(bar.y);

  await download;
  await expect(dialog.getByTestId("export-result")).toBeVisible();
  await expect(dialog.getByTestId("export-marble")).toHaveCount(0);
});

async function importPhoto(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(1200, 800);
    const g = c.getContext("2d")!;
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
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "subject.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click();
}

test("photo export: the marble is the dialog's preview, works through the stages and ends with a saved beat", async ({ page }) => {
  await importPhoto(page);
  await page.getByRole("button", { name: "Export…" }).first().click();
  const dialog = page.getByRole("dialog");
  const marble = dialog.getByTestId("export-marble");
  // On screen before anything is exported, holding the photo.
  await expect(marble).toHaveAttribute("data-mood", "idle");
  await expect(marble).toHaveAttribute("data-preview", /.+/);
  const download = page.waitForEvent("download");
  const started = Date.now();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(marble).toHaveAttribute("data-mood", "working");
  await expect(dialog.getByText(/Saved 1 photo ✓/)).toBeVisible();
  await expect(marble).toHaveAttribute("data-mood", "done");
  await download;
  await expect(dialog).toHaveCount(0);
  // Even a quick export stays up long enough to read (working minimum + done beat).
  expect(Date.now() - started).toBeGreaterThan(1400);
});

test("remove background: a scan while the AI works, then the background blows away and the overlay leaves", async ({ page }) => {
  await importPhoto(page);
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible();
  await page.keyboard.press("m");
  await page.getByRole("button", { name: "Remove BG" }).click();
  const fx = page.getByTestId("cutout-fx");
  await expect(fx).toHaveAttribute("data-phase", "scan");
  await expect(page.locator(".cutout-chip")).toContainText("Finding the subject");
  await expect(fx).toHaveAttribute("data-phase", "reveal", { timeout: 60_000 });
  await expect(fx).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".toast")).toContainText("Background removed");
  await expect(page.locator(".history-item").first()).toHaveText("Remove Background");
});
