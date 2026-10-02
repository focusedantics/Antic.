import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
});

/** A JPEG drawn in the page: `subject` adds an orange shape over green, otherwise a sky over a field. */
async function photo(page: Page, w: number, h: number, subject: boolean) {
  const b64 = await page.evaluate(
    async ([w, h, subject]) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d")!;
      if (subject) {
        g.fillStyle = "#5f7d57";
        g.fillRect(0, 0, w, h);
        g.fillStyle = "#dc5a28";
        g.beginPath();
        g.ellipse(w / 2, h * 0.55, w / 8, h / 3, 0, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = "#6f9bd8";
        g.fillRect(0, 0, w, h);
        g.fillStyle = "#3f7a33";
        g.fillRect(0, h * 0.55, w, h * 0.45);
      }
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    },
    [w, h, subject] as const,
  );
  return Buffer.from(b64, "base64");
}

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    localStorage.removeItem("export-frame");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
}

/** Width and height from a PNG's IHDR. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

test("export frame: framed around, the file grows by the frame; the frame is remembered", async ({ page }) => {
  await fresh(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "field.jpg", mimeType: "image/jpeg", buffer: await photo(page, 1500, 1000, false) });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click();
  await page.getByRole("button", { name: "Export…" }).first().click();
  const dialog = page.getByRole("dialog");
  // The preview appears with the frame, as for the watermark.
  await expect(dialog.getByLabel("Watermark and frame preview")).toHaveCount(0);
  await dialog.getByLabel("Frame the image").check();
  await expect(dialog.getByLabel("Watermark and frame preview")).toBeVisible();
  // Glass shows its own controls; a solid mat does not.
  await expect(dialog.getByRole("slider", { name: "Frost" })).toBeVisible();
  await dialog.getByRole("button", { name: "Solid" }).click();
  await expect(dialog.getByRole("slider", { name: "Frost" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Glass" }).click();
  await dialog.getByRole("button", { name: "Around" }).click();
  await dialog.locator("select").first().selectOption("png");
  // 4% of the 1000 px short side on every side.
  await expect(dialog.getByText("1580 × 1080 px", { exact: true })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  const file = readFileSync((await download.path())!);
  expect(pngSize(file)).toEqual([1580, 1080]);
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });

  await page.getByRole("button", { name: "Export…" }).first().click();
  await expect(page.getByRole("dialog").getByLabel("Frame the image")).toBeChecked();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Around" })).toHaveAttribute("aria-pressed", "true");
});

test("composite remove background: the particle globe forms from the layer, then the result lands", async ({ page }) => {
  await fresh(page);
  const files = [
    { name: "landscape.jpg", mimeType: "image/jpeg", buffer: await photo(page, 1200, 800, false) },
    { name: "subject.jpg", mimeType: "image/jpeg", buffer: await photo(page, 600, 800, true) },
  ];
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles(files);
  await expect(page.locator(".cell img")).toHaveCount(2, { timeout: 30_000 });
  await page.locator(".cell", { hasText: "landscape" }).click();
  await page.keyboard.press("c");
  await page.getByRole("button", { name: /Start from 1 selected/ }).click();
  await page.locator(".film-cell").nth(1).dragTo(page.locator(".composite-view"), { targetPosition: { x: 450, y: 330 } });
  await expect(page.locator(".layer-row")).toHaveCount(2, { timeout: 15_000 });

  const button = page.getByRole("button", { name: "Remove Background" });
  await button.click();
  const fx = page.locator('[data-testid="cutout-fx"][data-kind="particles"]');
  await expect(fx).toBeVisible();
  await expect(fx).toHaveAttribute("data-phase", "globe");
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("cutout-fx")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(".toast")).toContainText("Background removed");
  await expect(button).toBeEnabled();
});
