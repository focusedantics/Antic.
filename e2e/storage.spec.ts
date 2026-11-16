import { expect, type Page, test } from "@playwright/test";

/**
 * The Storage tab: what the app keeps on this device by category, counted from its own
 * stores (browsers report one total), with the clean-ups that are safe.
 */
async function seeded(page: Page) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
  await page.goto("/");
  await page.evaluate(async () => {
    indexedDB.deleteDatabase("focused-catalog");
    for (const name of await caches.keys()) await caches.delete(name);
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("focused-files", { recursive: true }).catch(() => undefined);
  });
  await page.reload();
  await page.evaluate(async () => {
    const { putDocument, putThumb, putOriginal, putAssets, putRaster } = await import("/src/core/catalog/db.ts" as string);
    const { createDocument } = await import("/src/core/document/operations.ts" as string);
    const blob = (n: number, type = "image/jpeg") => new Blob([new Uint8Array(n)], { type });
    for (let i = 0; i < 3; i++) {
      const d = { ...createDocument(1080, 1350), id: `seed-${i}`, name: `Poster ${i + 1}`, ...(i < 2 ? { purpose: "design" } : {}) };
      await putDocument({ id: d.id, name: d.name, updatedAt: Date.now() - i * 4e6, data: d, thumb: blob(60_000) });
    }
    const assets = [];
    for (let i = 0; i < 6; i++) {
      const id = `photo-${i}`;
      const raw = i === 2;
      assets.push({ id, fileName: raw ? "IMG_4102.DNG" : `IMG_${4100 + i}.JPG`, kind: raw ? "raw" : "jpeg", mime: "image/jpeg", byteSize: raw ? 48_000_000 : 6_000_000, fileModified: 1, importedAt: Date.now(), folder: "", original: { kind: "stored" }, fingerprint: id, width: 600, height: 400, captureTime: Date.now() - i * 1e7, exif: {}, rating: 0, flag: "none", label: "none", keywords: [], collectionIds: [], thumbState: "ready", thumbRevision: -1, developRevision: 0 });
      // Four are kept here; two stand for photos read from a folder in place.
      if (i < 4) await putOriginal(id, blob(2000));
      await putThumb(id, { thumb: blob(28_000), preview: blob(900_000), previewSource: "decoded", revision: -1 });
    }
    await putAssets(assets);
    for (let i = 0; i < 3; i++) await putRaster({ id: `r${i}`, width: 2000, height: 1000, data: new Uint8Array(2_000_000), createdAt: 1 });
    const cache = await caches.open("transformers-cache");
    await cache.put("https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx", new Response(blob(11_500_000, "application/octet-stream")));
  });
  await page.reload();
}

const row = (page: Page, name: string) => page.getByRole("list", { name: "Storage by category" }).getByRole("listitem").filter({ hasText: name });

test("computer: every category with its size; AI models can be removed; the largest things lead somewhere", async ({ page }) => {
  await seeded(page);
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Storage/ }).click();
  // Counting shows at once, names what it is on, and ends on a done beat (lib/pacing.ts).
  const status = page.locator(".storage-status");
  await expect(status).toHaveText(/^Counting /);
  await expect(status).toHaveText("Counted.", { timeout: 15_000 });
  await expect(status).toHaveText(/^Counted just now/);

  // 4 stored originals: 6 + 6 + 48 + 6 MB by their recorded file sizes.
  await expect(row(page, "Original photos")).toContainText("4 photos");
  await expect(row(page, "Original photos")).toContainText("66 MB");
  await expect(row(page, "Original photos")).toContainText("2 more are read from folders on this computer");
  await expect(row(page, "Previews")).toContainText("5.4 MB");
  await expect(row(page, "Thumbnails")).toContainText("168 KB");
  await expect(row(page, "Designs")).toContainText("2 designs");
  await expect(row(page, "Compositions")).toContainText("1 composition");
  await expect(row(page, "Masks and cutouts")).toContainText("6.0 MB");
  await expect(row(page, "Videos")).toContainText("none");
  await expect(page.locator(".storage-figure strong")).toHaveText(/MB$/);
  // The biggest category is listed first.
  await expect(page.getByRole("list", { name: "Storage by category" }).getByRole("listitem").first()).toContainText("Original photos");
  // The bar has a segment per category that holds something.
  expect(await page.locator(".usage-bar > span").count()).toBeGreaterThanOrEqual(6);

  // AI models: removing asks first, then really empties the browser's download cache.
  const models = row(page, "AI models");
  await expect(models).toContainText("12 MB");
  await models.getByRole("button", { name: "Remove…" }).click();
  await models.getByRole("button", { name: "Keep" }).click();
  await expect(models).toContainText("12 MB");
  await models.getByRole("button", { name: "Remove…" }).click();
  await models.getByRole("button", { name: "Remove 12 MB" }).click();
  await expect(status).toHaveText(/^Counting /);
  await expect(models).toContainText("none", { timeout: 15_000 });
  expect(await page.evaluate(async () => (await (await caches.open("transformers-cache")).keys()).length)).toBe(0);

  // Memory is a separate matter, and says so.
  const side = page.locator(".side.left");
  await expect(side.getByText("Graphics card")).toBeVisible();
  await expect(side.getByRole("button", { name: "Free working memory" })).toBeDisabled();
  await expect(side.getByRole("button", { name: "Ask the browser to keep it" })).toBeVisible();

  // Largest: the RAW first; Show opens it in the Library.
  const largest = page.getByRole("region", { name: "Largest" }).getByRole("listitem");
  await expect(largest.first()).toContainText("IMG_4102.DNG");
  await expect(largest.first()).toContainText("48 MB");
  await largest.first().getByRole("button", { name: "Show IMG_4102.DNG" }).click();
  await expect(page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Library/ })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(async () => (await import("/src/app/state.ts" as string)).ui.getState().activeId)).toBe("photo-2");

  // Back on the tab the count is still there (no second wait).
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Storage/ }).click();
  await expect(row(page, "Original photos")).toContainText("66 MB");
});

test("leftover files: only old files nothing refers to are listed, and they can be deleted", async ({ page }) => {
  await seeded(page);
  const result = await page.evaluate(async () => {
    const { measureStorage, removeLeftoverFiles } = await import("/src/core/catalog/usage.ts" as string);
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("focused-files", { create: true });
    const write = async (name: string, bytes: number) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
    };
    await write("original-photo-0", 1000); // in use: the catalog has this original
    await write("original-gone", 5000); // nothing refers to it
    const assets = [{ id: "photo-0", fileName: "a.jpg", byteSize: 1000 }];
    // Just written: it could be an import in progress, so it is not called leftover yet.
    const fresh = await measureStorage({ assets });
    const later = await measureStorage({ assets, now: Date.now() + 3_600_000 });
    const removed = await removeLeftoverFiles(later.leftover);
    const names: string[] = [];
    for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(name);
    return { fresh: fresh.leftover, later: later.leftover, bytes: later.rows.find((r: { id: string }) => r.id === "leftover").bytes, removed, names };
  });
  expect(result.fresh).toEqual([]);
  expect(result.later).toEqual(["original-gone"]);
  expect(result.bytes).toBe(5000);
  expect(result.removed).toBe(1);
  expect(result.names).toEqual(["original-photo-0"]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
  test("the tab fits the phone; memory and safety open from the dock", async ({ page }) => {
    await seeded(page);
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Storage" }).tap();
    await expect(page.locator(".storage-status")).toHaveText(/^Counted/, { timeout: 15_000 });
    await expect(row(page, "Original photos")).toContainText("66 MB");
    // Nothing wider than the screen.
    expect(await page.locator(".storage-view").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const remove = row(page, "AI models").getByRole("button", { name: "Remove…" });
    await remove.scrollIntoViewIfNeeded();
    const box = (await remove.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(30);
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Memory & safety" }).tap();
    await expect(page.getByTestId("sheet").getByRole("button", { name: "Ask the browser to keep it" })).toBeVisible();
    await expect(page.getByTestId("sheet").getByText("Graphics card")).toBeVisible();
  });
});
