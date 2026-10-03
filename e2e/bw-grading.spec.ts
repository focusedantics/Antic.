import { expect, type Page, test } from "@playwright/test";

/** Mean level (0–255) of each channel of Develop's live histogram. */
const means = (page: Page) =>
  page.evaluate(async () => {
    const { develop } = await import("/src/core/develop/session.ts" as string);
    const h = develop.getState().histogram;
    if (!h) return null;
    const mean = (ch: Uint32Array) => {
      let n = 0;
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        n += ch[i];
        sum += i * ch[i];
      }
      return sum / Math.max(1, n);
    };
    return { r: mean(h.r), g: mean(h.g), b: mean(h.b) };
  });

test("color grading tones a black & white photo (split toning, sepia)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true })));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(900, 600);
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 900, 0);
    gr.addColorStop(0, "#203a70");
    gr.addColorStop(0.5, "#6a9a40");
    gr.addColorStop(1, "#f0d0a0");
    g.fillStyle = gr;
    g.fillRect(0, 0, 900, 600);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "scene.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click();
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });

  // Black & white: the three channels are the same.
  await page.getByRole("button", { name: "B&W", exact: true }).click();
  await expect.poll(async () => {
    const m = await means(page);
    return m ? Math.abs(m.r - m.b) + Math.abs(m.r - m.g) : 99;
  }, { timeout: 15_000 }).toBeLessThan(0.5);
  const gray = (await means(page))!;

  // Warm the highlights and cool the shadows on the grading wheels.
  const panel = page.getByRole("button", { name: "Color Grading" });
  if ((await panel.getAttribute("aria-expanded")) === "false") await panel.click();
  const wheel = async (name: string, fx: number) => {
    const box = (await page.getByRole("slider", { name: `${name} hue and saturation` }).boundingBox())!;
    await page.mouse.click(box.x + box.width * fx, box.y + box.height / 2);
  };
  await wheel("Highlights", 0.9); // toward red/orange
  await wheel("Shadows", 0.1); // toward cyan
  await expect.poll(async () => {
    const m = await means(page);
    return m ? m.r - m.b : 0;
  }, { timeout: 15_000 }).toBeGreaterThan(2);
  const toned = (await means(page))!;
  // Still a toned black & white: brightness roughly where it was, colour only a tint.
  expect(Math.abs((toned.r + toned.g + toned.b) / 3 - (gray.r + gray.g + gray.b) / 3)).toBeLessThan(12);
  expect(Math.abs(toned.r - toned.b)).toBeLessThan(40);
});
