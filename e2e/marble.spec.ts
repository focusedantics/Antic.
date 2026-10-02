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
