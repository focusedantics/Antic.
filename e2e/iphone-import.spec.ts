import { expect, type Page, test } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function jpeg(page: Page) {
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(800, 600);
    const g = c.getContext("2d")!;
    g.fillStyle = "#c86";
    g.fillRect(0, 0, 800, 600);
    g.fillStyle = "#246";
    g.fillRect(200, 150, 400, 300);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}

async function fresh(page: Page, fileStore?: "worker" | "off") {
  await page.addInitScript((mode) => {
    localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true }));
    if (mode) localStorage.setItem("focused:file-store", mode);
  }, fileStore);
  await page.goto("/");
  await page.evaluate(async () => {
    indexedDB.deleteDatabase("focused-catalog");
    await (await navigator.storage.getDirectory()).removeEntry("focused-files", { recursive: true }).catch(() => undefined);
  });
  await page.reload();
}

/** The first value of the originals store, described (Blob, bytes, or a file in the private file system). */
const storedOriginal = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open("focused-catalog");
        open.onsuccess = () => {
          const req = open.result.transaction("originals").objectStore("originals").getAll();
          req.onsuccess = () => {
            const v = req.result[0];
            resolve(v instanceof Blob ? "blob" : v && v.bytes instanceof ArrayBuffer ? `bytes:${v.type}` : v && typeof v.opfs === "string" ? `file:${v.type}:${v.size}` : String(v));
            open.result.close();
          };
        };
      }),
  );

test.describe("iPhone", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  for (const fileStore of [undefined, "worker", "off"] as const)
    test(`photo library import: the picker stays in the page, asks for every photo, and the original is kept ${fileStore === "off" ? "as bytes (no private file system)" : `in the private file system${fileStore ? " (worker writer)" : ""}`}`, async ({ page }) => {
      await fresh(page, fileStore);
      const buffer = await jpeg(page);
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).tap()]);
      // iOS only reports the chosen files for an input that is in the document.
      expect(await chooser.element().evaluate((el: HTMLInputElement) => [el.isConnected, el.accept, el.multiple])).toEqual([true, "image/*,video/*", true]);
      await chooser.setFiles({ name: "IMG_0001.JPG", mimeType: "image/jpeg", buffer });
      await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
      // The picker's input is gone once it has delivered.
      await expect(page.locator('input[type="file"]')).toHaveCount(0);
      // Read back from disk on demand rather than held in memory: the bytes path is only a fallback.
      expect(await storedOriginal(page)).toBe(fileStore === "off" ? "bytes:image/jpeg" : `file:image/jpeg:${buffer.length}`);
      // And it reads back: the photo opens in Develop.
      await page.locator(".cell").first().tap();
      await page.getByRole("button", { name: /^Workspace:/ }).tap();
      await page.getByRole("menuitemradio", { name: "Develop" }).tap();
      await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
      await expect(page.getByTestId("sheet").getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".develop-status.error")).toHaveCount(0);
      // Byte for byte the file that was imported, and gone from disk once the photo is deleted.
      const back = await page.evaluate(async () => {
        const { catalog } = await import("/src/core/catalog/store.ts" as string);
        const { readOriginal } = await import("/src/core/catalog/originals.ts" as string);
        const asset = [...catalog.getState().assets.values()][0];
        const blob: Blob = await readOriginal(asset);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let hash = 0;
        for (const b of bytes) hash = (hash * 31 + b) >>> 0;
        return { size: blob.size, type: blob.type, hash, id: asset.id };
      });
      let hash = 0;
      for (const b of buffer) hash = (hash * 31 + b) >>> 0;
      expect(back).toMatchObject({ size: buffer.length, type: "image/jpeg", hash });
      const files = () => page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("focused-files", { create: true });
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
        return names;
      });
      expect(await files()).toEqual(fileStore === "off" ? [] : [`original-${back.id}`]);
      await page.evaluate(async (id) => {
        const { deleteAssets } = await import("/src/core/catalog/db.ts" as string);
        await deleteAssets([id]);
      }, back.id);
      expect(await files()).toEqual([]);
    });

  test("the Library's top bar has a clear Import button, also once photos are there", async ({ page }) => {
    await fresh(page);
    const bar = page.getByRole("banner");
    const pill = bar.getByRole("button", { name: "Import photos", exact: true });
    await expect(pill).toBeVisible();
    const box = (await pill.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    // Centred across the top bar (390 px wide).
    expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThan(2);
    const buffer = await jpeg(page);
    for (const name of ["IMG_1.JPG", "IMG_2.JPG"]) {
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pill.tap()]);
      await chooser.setFiles({ name, mimeType: "image/jpeg", buffer: name === "IMG_1.JPG" ? buffer : Buffer.concat([buffer, Buffer.from([0])]) });
    }
    await expect(page.locator(".cell img")).toHaveCount(2, { timeout: 30_000 });
    await expect(pill).toContainText("Import");
  });

  test("a photo that can't be read says so on screen, not only in a tooltip", async ({ page }) => {
    await fresh(page);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).tap()]);
    await chooser.setFiles({ name: "IMG_0002.HEIC", mimeType: "image/heic", buffer: Buffer.from("not really a photo") });
    await expect(page.locator(".toast.error")).toContainText("could not be imported", { timeout: 30_000 });
  });
});

test("on a computer the picker keeps its precise list (and is in the page too)", async ({ page }) => {
  await fresh(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  const [connected, accept] = await chooser.element().evaluate((el: HTMLInputElement) => [el.isConnected, el.accept]);
  expect(connected).toBe(true);
  expect(accept).toContain(".heic");
  expect(accept).toContain(".cr3");
  await chooser.setFiles({ name: "a.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
  expect(await storedOriginal(page)).toBe("blob");
});
