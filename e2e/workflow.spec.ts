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

/** Imports the test clip and waits for the video editor. */
async function openTestClip(page: Page) {
  await freshLibrary(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles("tests/fixtures/clip.mp4");
  await expect(page.getByTestId("viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("segment")).toHaveCount(1);
  await expect(page.getByTestId("timecode")).toHaveText("0:00.00 / 0:02.00");
}

/** Decodes MP4 video tracks in the page and counts frames whose YUV planes are identical. */
async function identicalFrames(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([x, y]) => {
      // Loaded from the dev server inside the page.
      const path = "/src/core/video/demux.ts";
      type Demux = (file: Blob) => Promise<{ video: { config: VideoDecoderConfig; track: { timescale: number }; samples: { is_sync: boolean; cts: number; data?: Uint8Array }[] } }>;
      const { demux } = (await import(/* @vite-ignore */ path)) as { demux: Demux };
      const decodeAll = async (b64: string) => {
        const d = await demux(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
        const v = d.video;
        const out: { ts: number; data: Uint8Array }[] = [];
        const pending: Promise<void>[] = [];
        const dec = new VideoDecoder({
          output: (f) => {
            const buf = new Uint8Array(f.allocationSize());
            pending.push(f.copyTo(buf).then(() => (out.push({ ts: f.timestamp, data: buf }), f.close())));
          },
          error: (e) => console.error(e),
        });
        dec.configure(v.config);
        for (const s of v.samples) dec.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: Math.round((s.cts / v.track.timescale) * 1e6), data: s.data! }));
        await dec.flush();
        await Promise.all(pending);
        return out.sort((p, q) => p.ts - q.ts);
      };
      const [fa, fb] = [await decodeAll(x), await decodeAll(y)];
      let same = 0;
      for (let i = 0; i < Math.min(fa.length, fb.length); i++) if (fa[i].data.length === fb[i].data.length && fa[i].data.every((v, k) => v === fb[i].data[k])) same++;
      return { a: fa.length, b: fb.length, same };
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

async function exportVideo(page: Page) {
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), dialog.getByRole("button", { name: "Export", exact: true }).click()]);
  await expect(dialog.getByTestId("export-result")).toBeVisible();
  const result = (await dialog.getByTestId("export-result").textContent()) ?? "";
  await dialog.getByRole("button", { name: "Done" }).click();
  return { name: download.suggestedFilename(), bytes: readFileSync((await download.path())!), result };
}

test("video: scrub, cut and poop a clip, export a lossless MKV with every frame", async ({ page }) => {
  await openTestClip(page);
  // Scrub: drag along the ruler.
  const ruler = page.getByRole("slider", { name: "Playhead" });
  const box = (await ruler.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + 8, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("timecode")).not.toHaveText("0:00.00 / 0:02.00");
  // Play moves the playhead.
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);
  await page.keyboard.press("Space");
  await expect(page.getByTestId("timecode")).not.toHaveText("0:00.00 / 0:02.00");
  // Cut at exactly one second (frame 30), then stutter and reverse the second half.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("timecode")).toHaveText("0:01.00 / 0:02.00");
  await page.keyboard.press("s");
  await expect(page.getByTestId("segment")).toHaveCount(2);
  await page.getByRole("button", { name: "Stutter", exact: true }).click();
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  await expect(page.getByTestId("segment").nth(1)).toContainText("REV · STUT×4");
  // 60 frames + 3 repeats of a 4-frame stutter.
  await expect(page.getByText("frame 31 of 72")).toBeVisible();
  const out = await exportVideo(page);
  expect(out.name).toBe("clip-edit.mkv");
  expect(out.result).toContain("72 frames, none dropped");
  expect([...out.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML (Matroska)
  // The timeline survives a reload.
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByRole("button", { name: /^Video/ }).click();
  await expect(page.getByTestId("segment")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("segment").nth(1)).toContainText("REV · STUT×4");
});

test("video: lossless MP4 frames are bit-identical to the source, and an untouched clip is copied", async ({ page }) => {
  await openTestClip(page);
  const source = readFileSync("tests/fixtures/clip.mp4");
  // A cut timeline, re-encoded losslessly: every frame decodes to exactly the source's YUV.
  await page.getByLabel("Format").selectOption("mp4-lossless");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("s");
  await expect(page.getByTestId("segment")).toHaveCount(2);
  const cut = await exportVideo(page);
  expect(cut.name).toBe("clip-edit.mp4");
  expect(cut.result).toContain("60 frames, none dropped");
  expect(cut.result).toContain("lossless");
  expect(await identicalFrames(page, source, cut.bytes)).toEqual({ a: 60, b: 60, same: 60 });
  // Undo the cut: an untouched clip is copied sample for sample.
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("segment")).toHaveCount(1);
  const copy = await exportVideo(page);
  expect(copy.result).toContain("copied bit for bit");
  expect(mp4Samples(copy.bytes)).toEqual(mp4Samples(source));
});

test("video: reversed and stuttered playback moves on screen", async ({ page }) => {
  await openTestClip(page);
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  await page.getByRole("button", { name: "Stutter", exact: true }).click();
  await expect(page.getByTestId("segment").first()).toContainText("REV");
  const viewer = page.getByTestId("viewer");
  await page.keyboard.press("Space");
  const seen = new Set<string>();
  const start = Date.now();
  while (Date.now() - start < 1500) seen.add(createHash("md5").update(await viewer.screenshot()).digest("hex"));
  await page.keyboard.press("Space");
  expect(seen.size).toBeGreaterThanOrEqual(3);
});

