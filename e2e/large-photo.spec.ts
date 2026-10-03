import { expect, type Page, test } from "@playwright/test";

/**
 * Large photos are decoded at the size they are used (Library preview, the phone's
 * 4096 px working copy) rather than in full. These check that the result is upright,
 * undistorted and knows the photo's true size, for a photo turned by its EXIF
 * orientation: browsers differ in how they combine resizing with orientation.
 */

/** A JPEG whose stored pixels are landscape (left half red, right half blue), tagged "rotate 90° CW" and with a camera make. */
async function rotatedJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ width, height }) => {
      const c = new OffscreenCanvas(width, height);
      const g = c.getContext("2d")!;
      g.fillStyle = "#d02020";
      g.fillRect(0, 0, width / 2, height);
      g.fillStyle = "#2040d0";
      g.fillRect(width / 2, 0, width / 2, height);
      const jpeg = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      // APP1 Exif: little-endian TIFF, IFD0 with Make = "TestCam" and Orientation = 6.
      const make = "TestCam\0";
      const tiff = new Uint8Array(8 + 2 + 2 * 12 + 4 + make.length);
      const v = new DataView(tiff.buffer);
      tiff.set([0x49, 0x49, 0x2a, 0x00]);
      v.setUint32(4, 8, true);
      v.setUint16(8, 2, true);
      // Make (0x010f), ASCII, count, offset to the string after the IFD.
      v.setUint16(10, 0x010f, true);
      v.setUint16(12, 2, true);
      v.setUint32(14, make.length, true);
      v.setUint32(18, 8 + 2 + 2 * 12 + 4, true);
      // Orientation (0x0112), SHORT, 1, value 6.
      v.setUint16(22, 0x0112, true);
      v.setUint16(24, 3, true);
      v.setUint32(26, 1, true);
      v.setUint16(30, 6, true);
      v.setUint32(34, 0, true);
      for (let i = 0; i < make.length; i++) tiff[38 + i] = make.charCodeAt(i);
      const payload = new Uint8Array(6 + tiff.length);
      payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
      payload.set(tiff, 6);
      const app1 = new Uint8Array(4 + payload.length);
      app1.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]);
      app1.set(payload, 4);
      const out = new Uint8Array(jpeg.length + app1.length);
      out.set(jpeg.subarray(0, 2));
      out.set(app1, 2);
      out.set(jpeg.subarray(2), 2 + app1.length);
      let s = "";
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { width, height },
  );
  return Buffer.from(b64, "base64");
}

/** Mean colour of a horizontal band (fractions of the height) of an image element or canvas region on screen. */
async function bandColor(page: Page, selector: string, from: number, to: number) {
  const png = await page.locator(selector).screenshot();
  return page.evaluate(
    async ({ b64, from, to }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = c.getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const y0 = Math.round(bitmap.height * from);
      const y1 = Math.round(bitmap.height * to);
      const d = g.getImageData(0, y0, bitmap.width, Math.max(1, y1 - y0)).data;
      let r = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200 || d[i] + d[i + 1] + d[i + 2] < 60) continue; // background around the photo
        r += d[i];
        b += d[i + 2];
        n++;
      }
      return { r: r / Math.max(1, n), b: b / Math.max(1, n) };
    },
    { b64: png.toString("base64"), from, to },
  );
}

test("a large EXIF-rotated photo imports upright with its true size and EXIF, and develops upright on a phone-sized budget", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false }));
    // The phone profile: photos are kept at most 4096 px on the GPU.
    localStorage.setItem("focused:device", "lite");
  });
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  const jpeg = await rotatedJpeg(page, 5200, 3000);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles({ name: "rotated.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });

  // The catalog has the upright full size and the camera.
  const asset = await page.evaluate(async () => {
    const { catalog } = await import("/src/core/catalog/store.ts" as string);
    const a = [...catalog.getState().assets.values()][0] as { width: number; height: number; exif: { make?: string } };
    return { width: a.width, height: a.height, make: a.exif.make };
  });
  expect(asset).toEqual({ width: 3000, height: 5200, make: "TestCam" });

  // The thumbnail is upright and undistorted: portrait, red on top (the stored left half).
  const thumb = await page.locator(".cell img").evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  expect(thumb.h).toBeGreaterThan(thumb.w);
  expect(Math.abs(thumb.w / thumb.h - 3000 / 5200)).toBeLessThan(0.02);

  // Develop: decoded at 4096 px, but it knows it is a 3000 × 5200 photo, upright.
  await page.locator(".cell").first().click();
  await page.keyboard.press("d");
  await expect(page.getByRole("slider", { name: "Exposure" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 30_000 });
  const source = await page.evaluate(async () => {
    const { develop } = await import("/src/core/develop/session.ts" as string);
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const s = developEngine().sourceFor(develop.getState().assetId);
    return { size: s.size, base: [s.base.width, s.base.height], quality: develop.getState().source };
  });
  expect(source.size).toEqual({ width: 3000, height: 5200 });
  expect(Math.max(...source.base)).toBeLessThanOrEqual(4096);
  expect(source.base[1]).toBeGreaterThan(source.base[0]);
  await page.waitForTimeout(500);
  const top = await bandColor(page, ".develop-view", 0.2, 0.35);
  const bottom = await bandColor(page, ".develop-view", 0.65, 0.8);
  expect(top.r).toBeGreaterThan(top.b + 60);
  expect(bottom.b).toBeGreaterThan(bottom.r + 60);
});
