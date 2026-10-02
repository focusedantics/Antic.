import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
});

test("export marble: video export shows the marble with the first frame beside the progress bar", async ({ page }) => {
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
  expect(m.height).toBeGreaterThan(140);
  const overlaps = m.x < bar.x + bar.width && bar.x < m.x + m.width && m.y < bar.y + bar.height && bar.y < m.y + m.height;
  expect(overlaps).toBe(false);

  await download;
  await expect(dialog.getByTestId("export-result")).toBeVisible();
  // It stays as the dialog's picture, finished.
  await expect(marble).toHaveAttribute("data-mood", "done");
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

test("remove background: a particle globe while the AI works, then the background blows away and the overlay leaves", async ({ page }) => {
  await importPhoto(page);
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible();
  await page.keyboard.press("m");
  await page.getByRole("button", { name: "Remove BG" }).click();
  const fx = page.getByTestId("cutout-fx");
  // The photo becomes a globe of particles; screen readers hear the stage, nothing covers the picture.
  await expect(fx).toHaveAttribute("data-phase", "globe");
  await expect(page.locator('[data-testid="cutout-fx"][data-kind="particles"]')).toBeVisible();
  await expect(page.getByTestId("cutout-status")).toHaveText(/Finding the subject/);
  await expect(page.locator(".cutout-chip")).toHaveCount(0);
  await expect(fx).toHaveAttribute("data-phase", "reveal", { timeout: 60_000 });
  await expect(fx).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[data-testid="cutout-fx"][data-kind="particles"]')).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Background removed");
  await expect(page.locator(".history-item").first()).toHaveText("Remove Background");
});

test("photo export with several photos: a counter on the marble and the most recent photo first", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const files = await page.evaluate(async () => {
    const out: string[] = [];
    for (const color of ["#c33", "#3c3", "#33c"]) {
      const c = new OffscreenCanvas(600, 400);
      const g = c.getContext("2d")!;
      g.fillStyle = color;
      g.fillRect(0, 0, 600, 400);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      out.push(btoa(s));
    }
    return out;
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles(files.map((b, i) => ({ name: `p${i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b, "base64") })));
  await expect(page.locator(".cell img")).toHaveCount(3, { timeout: 30_000 });
  // Select all three, the middle one last.
  await page.locator(".cell").nth(0).click();
  await page.locator(".cell").nth(2).click({ modifiers: ["Control"] });
  await page.locator(".cell").nth(1).click({ modifiers: ["Control"] });
  const lastId = await page.locator(".cell").nth(1).getAttribute("data-sweep-id");
  await page.getByRole("button", { name: "Export…" }).first().click();
  const dialog = page.getByRole("dialog");
  const marble = dialog.getByTestId("export-marble");
  await expect(marble.locator(".marble-count")).toHaveText("3");
  await expect(marble).toHaveAttribute("data-preview", new RegExp(`^${lastId}:`));
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export 3", exact: true }).click();
  await expect(marble.locator(".marble-count")).toHaveText(/^[123]\/3$/);
  await download;
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
});

test("remove background: one run at a time, survives leaving Develop, and lands on the right photo", async ({ page }) => {
  await importPhoto(page);
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible();
  await page.keyboard.press("m");
  const button = page.getByRole("button", { name: "Remove BG" });
  await button.click();
  // A second click does nothing: the button is disabled while the first run goes.
  await expect(button).toBeDisabled();
  await button.click({ force: true });
  await expect(page.locator('[data-testid="cutout-fx"][data-kind="particles"]')).toHaveCount(1);
  // Leave for the Library mid-run: the animation goes away with the viewer.
  await page.keyboard.press("g");
  await expect(page.getByTestId("cutout-fx")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Background removed", { timeout: 60_000 });
  // Back in Develop: exactly one Remove Background, on this photo.
  await page.keyboard.press("d");
  await expect(page.locator(".history-item").filter({ hasText: "Remove Background" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove BG" })).toBeEnabled();
});

test("remove background: the overlay covers the photo to the pixel (no sliver at the edges)", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Loaded from the dev server inside the page.
    const path = "/src/components/cutoutFx.ts";
    type Bounds = (c: HTMLCanvasElement) => { x0: number; y0: number; x1: number; y1: number } | null;
    const { photoBounds } = (await import(/* @vite-ignore */ path)) as { photoBounds: Bounds };
    const out: { want: number[]; got: number[] }[] = [];
    for (const [W, H, x0, y0, x1, y1] of [
      [1000, 700, 13, 7, 613, 407],
      [1801, 1103, 1, 211, 1800, 892],
      [2400, 1500, 437, 3, 1963, 1497],
    ]) {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d")!;
      g.fillStyle = "#fff";
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      const b = photoBounds(c)!;
      out.push({ want: [x0, y0, x1, y1], got: [b.x0, b.y0, b.x1, b.y1] });
    }
    return out;
  });
  for (const { want, got } of result) {
    // Covers every photo pixel…
    expect(got[0]).toBeLessThanOrEqual(want[0]);
    expect(got[1]).toBeLessThanOrEqual(want[1]);
    expect(got[2]).toBeGreaterThanOrEqual(want[2]);
    expect(got[3]).toBeGreaterThanOrEqual(want[3]);
    // …and spills at most a few pixels past it.
    expect(want[0] - got[0]).toBeLessThan(12);
    expect(got[2] - want[2]).toBeLessThan(12);
  }
});
