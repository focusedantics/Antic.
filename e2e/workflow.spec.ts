import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { createFile, MP4BoxBuffer } from "mp4box";

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
  // Recipe saves are debounced (300 ms + 250 ms catalog flush + the IndexedDB write).
  await page.waitForTimeout(2000);
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
  await page.getByRole("button", { name: "Export MP4…" }).first().click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 90_000 }), page.getByRole("dialog").getByRole("button", { name: "Export MP4", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("clip-edit.mp4");
  await expect(page.getByRole("dialog")).toContainText("Saved");
  // 1.5 s kept at 15 fps: every frame is there (encoders starved of bits drop frames).
  expect(mp4Frames(readFileSync((await download.path())!))).toBeGreaterThanOrEqual(22);
  await page.getByRole("button", { name: "Done" }).click();
  // Maximum quality at the original frame rate keeps all 45 frames of the 30 fps source.
  await page.getByLabel("Quality").selectOption("maximum");
  await page.getByLabel("Frame rate").selectOption("original");
  await page.getByRole("button", { name: "Export MP4…" }).first().click();
  const [full] = await Promise.all([page.waitForEvent("download", { timeout: 90_000 }), page.getByRole("dialog").getByRole("button", { name: "Export MP4", exact: true }).click()]);
  expect(mp4Frames(readFileSync((await full.path())!))).toBe(45);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Quality").selectOption("low");
  // The edit survives a reload.
  await page.reload();
  await page.getByRole("button", { name: /^Video/ }).click();
  await expect(page.getByRole("slider", { name: "Trim start" })).toHaveAttribute("aria-valuenow", "0.5", { timeout: 30_000 });
  await expect(page.locator(".side.right")).toContainText("CMYK Print");
});

test("looks: save a composition's effects as a look, apply it to other photos, batch export with a watermark", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape"), await makeImage(page, "subject.jpg", "subject")]);
  await page.locator(".cell", { hasText: "landscape" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  await page.getByLabel("Search effects").fill("bricks");
  await page.locator(".fx-card", { hasText: "Toy Bricks" }).click();
  await expect(page.locator(".layer-row").first()).toContainText("Toy Bricks");

  // Save the composition's layers and the photo's develop settings as a look.
  await page.getByRole("button", { name: "Looks…" }).click();
  await page.getByLabel("Look name").fill("Bricks");
  await page.getByRole("button", { name: "Save look" }).click();
  await expect(page.locator(".look-row", { hasText: "Bricks" })).toContainText("1 layer (1 effect)");
  const [lookFile] = await Promise.all([page.waitForEvent("download"), page.locator(".look-row", { hasText: "Bricks" }).getByRole("button", { name: ".focused" }).click()]);
  expect(lookFile.suggestedFilename()).toBe("Bricks.focused");
  await page.getByRole("button", { name: "Close" }).click();

  // Apply it to both photos from the Library: one composition per photo.
  await page.keyboard.press("g");
  await page.keyboard.press("Control+a");
  await page.getByRole("button", { name: "Looks…" }).click();
  await page.locator(".look-row", { hasText: "Bricks" }).getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".toast")).toContainText("Created 2 compositions", { timeout: 30_000 });

  // Batch export both photos into one ZIP with a watermark.
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Photos · 2 of 2");
  await dialog.getByLabel("Export destination").selectOption("zip");
  await dialog.getByLabel("Add a watermark").check();
  await expect(dialog.locator(".watermark-preview")).toBeVisible();
  await dialog.getByRole("button", { name: "top left" }).click();
  const [zipFile] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dialog.getByRole("button", { name: "Export 2" }).click()]);
  expect(zipFile.suggestedFilename()).toBe("Focused export (2 photos).zip");
});

/** Number of video frames (samples) in an MP4. */
function mp4Frames(bytes: Buffer): number {
  const file = createFile();
  let frames = -1;
  file.onReady = (info) => {
    frames = info.videoTracks[0]?.nb_samples ?? 0;
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 0));
  file.flush();
  return frames;
}

/** Frame count and a digest of every video sample's bytes (equal digests = identical frames). */
function mp4Samples(bytes: Buffer): { frames: number; digest: number } {
  const file = createFile();
  let frames = 0;
  let digest = 0;
  file.onReady = (info) => {
    frames = info.videoTracks[0].nb_samples;
    file.setExtractionOptions(info.videoTracks[0].id, null, { nbSamples: 1_000_000 });
    file.start();
  };
  file.onSamples = (_id, _user, samples) => {
    for (const sample of samples) for (const b of sample.data!) digest = (digest * 31 + b) | 0;
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 0));
  file.flush();
  return { frames, digest };
}

/** Counts the image blocks in a GIF by walking its block structure. */
function gifFrames(bytes: Buffer): number {
  let p = 13;
  if (bytes[10] & 0x80) p += 3 * (1 << ((bytes[10] & 7) + 1));
  const skipSubBlocks = () => {
    while (bytes[p] !== 0) p += bytes[p] + 1;
    p++;
  };
  let frames = 0;
  while (p < bytes.length && bytes[p] !== 0x3b) {
    if (bytes[p] === 0x21) {
      p += 2;
      skipSubBlocks();
    } else if (bytes[p] === 0x2c) {
      const flags = bytes[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW minimum code size
      skipSubBlocks();
      frames++;
    } else throw new Error(`Bad GIF block 0x${bytes[p].toString(16)} at ${p}`);
  }
  return frames;
}

test("histogram draws for the developed photo", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape")]);
  await page.locator(".cell").first().click();
  await page.keyboard.press("d");
  const histogram = page.getByRole("img", { name: "Histogram" });
  await expect(histogram).toBeVisible();
  await expect
    .poll(
      () =>
        histogram.evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
          return lit / (c.width * c.height);
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0.05);
});

test("animated effects: snow plays and pauses, exports as GIF, MP4 and a still frame", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape")]);
  await page.locator(".cell").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  const browser = page.getByRole("dialog", { name: "Effects" });
  await browser.getByRole("button", { name: /^Animated/ }).click();
  await expect(browser.locator(".fx-badge").first()).toHaveText("Animated");
  await browser.getByLabel("Search effects").fill("snow");
  await browser.locator(".fx-card", { hasText: "Snow" }).first().click();
  await expect(page.locator(".layer-row").first()).toContainText("Snow");
  await expect(page.getByRole("button", { name: /Animating/ })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Loop length" })).toBeVisible();

  // Pausing and resuming the live animation.
  await page.getByRole("button", { name: /Animating/ }).click();
  await expect(page.getByRole("button", { name: /Animate$/ })).toBeVisible();
  await page.getByRole("button", { name: /Animate$/ }).click();

  const exportAs = async (format: string, extension: string) => {
    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Format").selectOption(format);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`));
    const path = await download.path();
      return readFileSync(path!);
  };

  const gif = await exportAs("gif", "gif");
  expect(gif.subarray(0, 6).toString("latin1")).toBe("GIF89a");
  // 3 s at 15 fps = 45 frames.
  expect(gifFrames(gif)).toBe(45);

  const mp4 = await exportAs("mp4", "mp4");
  expect(mp4.subarray(4, 8).toString("latin1")).toBe("ftyp");

  const png = await exportAs("png", "png");
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
});

test("video: playback moves, natively without an effect and rendered with one (even when the <video> hands back stale frames)", async ({ page }) => {
  await freshLibrary(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles("tests/fixtures/clip.mp4");
  const stage = page.locator(".vid-stage");
  await expect(page.locator(".vid-canvas")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  const distinctWhilePlaying = async () => {
    await page.keyboard.press("Space");
    const seen = new Set<string>();
    const start = Date.now();
    while (Date.now() - start < 1200) seen.add(createHash("md5").update(await stage.screenshot()).digest("hex"));
    await page.keyboard.press("Space");
    return seen.size;
  };
  // No effect: the browser's own video is on screen.
  await expect(stage).toHaveClass(/native/);
  expect(await distinctWhilePlaying()).toBeGreaterThanOrEqual(3);

  // With an effect the canvas renders every frame. Reproduce browsers where frame
  // callbacks stall and a playing <video> keeps handing back the same frame.
  await page.getByRole("button", { name: "✦ Add effect…" }).click();
  await page.getByLabel("Search effects").fill("halftone");
  await page.locator(".fx-card", { hasText: "CMYK Print" }).click();
  await expect(stage).not.toHaveClass(/native/);
  await page.evaluate(() => {
    const original = OffscreenCanvasRenderingContext2D.prototype.drawImage;
    OffscreenCanvasRenderingContext2D.prototype.drawImage = function (this: OffscreenCanvasRenderingContext2D, ...args: unknown[]) {
      const source = args[0];
      if (source instanceof HTMLVideoElement && !source.paused) return;
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof original;
    for (const v of document.querySelectorAll("video")) Object.assign(v, { requestVideoFrameCallback: () => 0 });
  });
  expect(await distinctWhilePlaying()).toBeGreaterThanOrEqual(3);
});

test("text: bundled fonts and animated text export as a GIF", async ({ page }) => {
  await freshLibrary(page);
  await importFiles(page, [await makeImage(page, "landscape.jpg", "landscape")]);
  await page.locator(".cell").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Apply an Effect…" }).click();
  await page.getByRole("dialog", { name: "Effects" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "+ Layer" }).click();
  await page.getByRole("menuitem", { name: "Text" }).click();
  await page.getByLabel("Text", { exact: true }).fill("HELLO");
  await page.getByLabel("Font").selectOption({ label: "Bebas Neue" });
  await page.getByLabel("Animation").selectOption("wave");
  await expect(page.getByRole("button", { name: /Animating/ })).toBeVisible();
  // The bundled font is actually loaded and used.
  await expect.poll(() => page.evaluate(() => document.fonts.check("700 40px 'Bebas Neue'")), { timeout: 15_000 }).toBe(true);
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Format").selectOption("gif");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  const gif = readFileSync((await download.path())!);
  expect(gifFrames(gif)).toBe(45);
});

test("video: an untrimmed export at maximum quality copies the original frames bit for bit", async ({ page }) => {
  await freshLibrary(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles("tests/fixtures/clip.mp4");
  await expect(page.locator(".vid-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Quality")).toHaveValue("maximum");
  await page.getByRole("button", { name: "Export MP4…" }).first().click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 90_000 }), page.getByRole("dialog").getByRole("button", { name: "Export MP4", exact: true }).click()]);
  const out = mp4Samples(readFileSync((await download.path())!));
  expect(out).toEqual(mp4Samples(readFileSync("tests/fixtures/clip.mp4")));
});
