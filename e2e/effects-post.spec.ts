import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
});

/** Hash of the canvas once it stops changing (the render settled). */
async function settled(page: Page) {
  const view = page.locator(".composite-view");
  let last = "";
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    const h = createHash("md5").update(await view.screenshot()).digest("hex");
    if (h === last) return h;
    last = h;
  }
  return last;
}

test("effects: ASCII character sets and bloom/grain post-processing, also on other effects", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(900, 600);
    const g = c.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 600);
    sky.addColorStop(0, "#0a1a40");
    sky.addColorStop(1, "#f6b26b");
    g.fillStyle = sky;
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = "#fff6d0";
    g.beginPath();
    g.arc(600, 220, 90, 0, Math.PI * 2);
    g.fill();
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "sun.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  await page.getByLabel("Search effects").fill("ascii");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-row").first()).toContainText("ASCII");

  // A new ASCII layer starts with bloom and grain on, in an open Post-processing section.
  const bloom = page.getByRole("checkbox", { name: "Bloom" });
  await expect(bloom).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Grain" })).toBeChecked();
  await expect(page.getByRole("slider", { name: "Bloom radius" })).toBeVisible();
  const withPost = await settled(page);

  // Turning bloom off changes the picture and hides its settings.
  await bloom.uncheck();
  await expect(page.getByRole("slider", { name: "Bloom radius" })).toHaveCount(0);
  const noBloom = await settled(page);
  expect(noBloom).not.toBe(withPost);

  // Character sets: the custom field shows only for Custom, and typing changes the render.
  const charset = page.getByLabel("Characters");
  await expect(page.getByLabel("Custom characters")).toHaveCount(0);
  await charset.selectOption("blocks");
  const blocks = await settled(page);
  expect(blocks).not.toBe(noBloom);
  await charset.selectOption("custom");
  await page.getByLabel("Custom characters").fill("@#");
  const custom = await settled(page);
  expect(custom).not.toBe(blocks);

  // Another effect: post-processing is there too, off and collapsed until opened.
  await page.getByRole("button", { name: "Change…" }).click();
  await page.getByLabel("Search effects").fill("bricks");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-row").first()).toContainText("Toy Bricks");
  const section = page.getByRole("button", { name: /Post-processing/ });
  await expect(section).toHaveAttribute("aria-expanded", "false");
  const plain = await settled(page);
  await section.click();
  await page.getByRole("checkbox", { name: "Grain" }).check();
  await page.getByRole("checkbox", { name: "Bloom" }).check();
  expect(await settled(page)).not.toBe(plain);

  // Undo puts the bricks back exactly (the toolbar button: focus is on a checkbox, where shortcuts stay out of the way).
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await undo.click();
  await undo.click();
  expect(await settled(page)).toBe(plain);
});

test("effects: liquid glass, glass blobs and liquid metal render without errors and respond to their controls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(900, 600);
    const g = c.getContext("2d")!;
    g.fillStyle = "#2050a0";
    g.fillRect(0, 0, 900, 600);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = `hsl(${i * 36}, 70%, 55%)`;
      g.fillRect(30 + i * 85, 300, 60, 260);
    }
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "bars.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  await page.getByLabel("Search effects").fill("liquid glass");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-row").first()).toContainText("Liquid Glass");
  const pill = await settled(page);
  await page.getByLabel("Shape").selectOption("tiles");
  const tiles = await settled(page);
  expect(tiles).not.toBe(pill);

  for (const name of ["Glass Blobs", "Liquid Metal"]) {
    await page.getByRole("button", { name: "Change…" }).click();
    await page.getByLabel("Search effects").fill(name.toLowerCase());
    await page.keyboard.press("Enter");
    await expect(page.locator(".layer-row").first()).toContainText(name);
  }
  // Liquid Metal: switching the metal changes the picture; the custom color appears only for Custom.
  // It is animated: pause playback so the canvas holds one frame to compare.
  await page.getByRole("button", { name: /Animating/ }).click();
  await expect(page.getByRole("button", { name: /Animate/ })).toBeVisible();
  await expect(page.getByLabel("Custom color")).toHaveCount(0);
  const chrome = await settled(page);
  await page.getByRole("combobox", { name: "Metal", exact: true }).selectOption("gold");
  expect(await settled(page)).not.toBe(chrome);
  await page.getByRole("combobox", { name: "Metal", exact: true }).selectOption("custom");
  await expect(page.getByLabel("Custom color")).toBeVisible();
  await expect(page.locator(".toast.error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("frosted glass: a dark figure on light grey becomes green ink on paper, or keeps its own colours", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(800, 1000);
    const g = c.getContext("2d")!;
    g.fillStyle = "#d8d8d8";
    g.fillRect(0, 0, 800, 1000);
    g.fillStyle = "#2a2a2a";
    g.fillRect(300, 250, 200, 500);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "figure.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".cell").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  await page.getByLabel("Search effects").fill("frosted");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-row").first()).toContainText("Frosted Glass");

  /** Share of near-white paper, and the average colour in the figure's middle, from an exported PNG. */
  const measure = async () => {
    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog");
    const [file] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
    const png = (await import("node:fs")).readFileSync((await file.path())!).toString("base64");
    return page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const all = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let paper = 0;
      for (let i = 0; i < all.length; i += 4) if (all[i] > 190 && all[i + 1] > 190 && all[i + 2] > 190) paper++;
      const mid = g.getImageData(bitmap.width * 0.45, bitmap.height * 0.45, bitmap.width * 0.1, bitmap.height * 0.1).data;
      const avg = [0, 0, 0];
      for (let i = 0; i < mid.length; i += 4) for (let k = 0; k < 3; k++) avg[k] += mid[i + k] / (mid.length / 4);
      return { paper: paper / (all.length / 4), figure: avg.map(Math.round) };
    }, png);
  };
  const duo = await measure();
  // Mostly paper; the figure is dark green ink (green above red and blue).
  expect(duo.paper).toBeGreaterThan(0.6);
  expect(duo.figure[1]).toBeGreaterThan(duo.figure[0] + 10);
  expect(duo.figure[1]).toBeLessThan(140);
  // Its own colours: the figure stays grey, not green.
  await page.getByRole("combobox", { name: "Colour", exact: true }).selectOption("photo");
  const own = await measure();
  expect(Math.abs(own.figure[1] - own.figure[0])).toBeLessThan(12);
});
