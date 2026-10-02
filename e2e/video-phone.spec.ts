import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { moovAtEnd } from "../tests/fixtures/moov";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const clip = () => readFileSync("tests/fixtures/clip.mp4");

async function open(page: Page, extra?: () => void) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
  if (extra) await page.addInitScript(extra);
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
}

async function importVideo(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, compact = false) {
  if (compact) {
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Video" }).tap();
  } else await page.getByRole("button", { name: "Video", exact: true }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Video…" }).click()]);
  await chooser.setFiles(file);
  await expect(page.getByTestId("viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("segment")).toHaveCount(1, { timeout: 30_000 });
}

/** Average colour of the viewer canvas (WebGL; read through a 2D copy). */
const viewerColor = (page: Page) =>
  page.getByTestId("viewer").evaluate((c: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = 32;
    copy.height = 18;
    const g = copy.getContext("2d")!;
    g.drawImage(c, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let r = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      b += d[i + 2];
    }
    return { r: r / (d.length / 4), b: b / (d.length / 4) };
  });

test("iPhone-style file: the index after the media (.MOV) imports, plays and steps frame by frame", async ({ page }) => {
  await open(page);
  await importVideo(page, { name: "IMG_0042.MOV", mimeType: "video/quicktime", buffer: Buffer.from(moovAtEnd(new Uint8Array(clip()))) });
  await expect(page.getByTestId("timecode")).toHaveText("0:00.00 / 0:02.00");
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-decoder", "webcodecs");
  await page.getByTestId("viewer").focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("timecode")).toHaveText("0:01.00 / 0:02.00");
});

test("when WebCodecs can't decode a clip, the browser's player supplies the frames (and export still works)", async ({ page }) => {
  await open(page, () => localStorage.setItem("focused:video-decoder", "element"));
  await importVideo(page, { name: "clip.mp4", mimeType: "video/mp4", buffer: clip() });
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-decoder", "element");
  await expect(page.getByText("Compatibility playback")).toBeVisible();
  await expect(page.getByTestId("timecode")).toHaveText("0:00.00 / 0:02.00");
  await page.waitForTimeout(800);
  const first = await viewerColor(page);
  expect(first.r + first.b).toBeGreaterThan(30); // a picture, not an empty canvas
  await page.getByTestId("viewer").focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(800);
  const last = await viewerColor(page);
  // The fixture fades from red towards blue.
  expect(last.b - last.r).toBeGreaterThan(first.b - first.r + 10);
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog");
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await download;
  await expect(dialog.getByTestId("export-result")).toBeVisible();
});

test("a clip nothing here can decode (HEVC in this browser) is refused with advice, not a vague error", async ({ page }) => {
  await open(page);
  // The fixture relabelled as HEVC: neither WebCodecs nor the player in this test browser decodes it.
  const bytes = Buffer.from(clip());
  const at = bytes.indexOf("vp09");
  bytes.write("hvc1", at, "latin1");
  await page.getByRole("button", { name: "Video", exact: true }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Video…" }).click()]);
  await chooser.setFiles({ name: "IMG_0001.MOV", mimeType: "video/quicktime", buffer: bytes });
  await expect(page.locator(".toast.error")).toContainText("HEVC", { timeout: 30_000 });
  await expect(page.locator(".toast.error")).toContainText("Most Compatible");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("the Edit panel floats over the frame, not the transport or the timeline", async ({ page }) => {
    await open(page);
    await importVideo(page, { name: "clip.mp4", mimeType: "video/mp4", buffer: clip() }, true);
    const timeline = (await page.locator(".vt").boundingBox())!;
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Edit" }).tap();
    const sheet = page.getByTestId("sheet");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((el) => [getComputedStyle(el).position, !!el.closest(".vv-stage")])).toEqual(["absolute", true]);
    const s = (await sheet.boundingBox())!;
    const stage = (await page.locator(".vv-stage").boundingBox())!;
    expect(Math.abs(s.y + s.height - (stage.y + stage.height))).toBeLessThan(2);
    // The transport and the timeline stay where they were, uncovered.
    expect((await page.locator(".vt").boundingBox())!).toEqual(timeline);
    // Still in reach while the panel is open: step, then split.
    for (let i = 0; i < 20; i++) await page.getByRole("button", { name: "Next frame" }).tap();
    await page.getByRole("button", { name: "Split at the playhead" }).tap();
    await expect(page.getByTestId("segment")).toHaveCount(2);
  });

  test("no text selection on long presses (iOS needs the -webkit- prefix)", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).webkitUserSelect)).toBe("none");
  });

  test("video: transport with edit actions, tap to select, pinch to zoom, hold to move", async ({ page }) => {
    await open(page);
    await importVideo(page, { name: "clip.mp4", mimeType: "video/mp4", buffer: clip() }, true);
    // The desktop toolbar is replaced by the transport row.
    await expect(page.getByRole("toolbar", { name: "Video tools" })).toBeHidden();
    const split = page.getByRole("button", { name: "Split at the playhead" });
    await expect(split).toBeVisible();
    for (let i = 0; i < 30; i++) await page.getByRole("button", { name: "Next frame" }).tap();
    await split.tap();
    const segs = page.getByTestId("segment");
    await expect(segs).toHaveCount(2);
    await expect(segs.nth(1)).toHaveAttribute("title", /^2: 0:01\.00/);

    // Tap selects.
    await segs.nth(0).tap();
    await expect(segs.nth(0)).toHaveAttribute("aria-selected", "true");

    // Pinch out on the timeline: it zooms.
    const zoom = page.getByTestId("timeline-zoom");
    await expect(zoom).toHaveText("Fit");
    await segs.nth(0).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const fire = (target: EventTarget, type: string, id: number, x: number) =>
        target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }));
      fire(el, "pointerdown", 1, r.left + 60);
      fire(el, "pointerdown", 2, r.left + 100);
      for (let i = 1; i <= 8; i++) {
        fire(window, "pointermove", 1, r.left + 60 - i * 6);
        fire(window, "pointermove", 2, r.left + 100 + i * 6);
      }
      fire(window, "pointerup", 1, r.left + 12);
      fire(window, "pointerup", 2, r.left + 148);
    });
    await expect(zoom).not.toHaveText("Fit");
    await page.getByRole("button", { name: "More playback options" }).tap();
    await page.getByRole("menuitem", { name: "Fit the timeline" }).tap();
    await expect(zoom).toHaveText("Fit");

    // Press and hold the second segment, then drag it before the first.
    const second = (await segs.nth(1).boundingBox())!;
    const first = (await segs.nth(0).boundingBox())!;
    await segs.nth(1).evaluate((el, [sx, tx, y]) => {
      el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, pointerType: "touch", clientX: sx, clientY: y, bubbles: true, cancelable: true }));
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, pointerType: "touch", clientX: tx, clientY: y, bubbles: true }));
          window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, pointerType: "touch", clientX: tx, clientY: y, bubbles: true }));
          resolve();
        }, 500),
      );
    }, [second.x + second.width / 2, first.x + 4, second.y + second.height / 2]);
    await expect(segs.nth(0)).toHaveAttribute("title", /^1: 0:01\.00/);
  });

  test("composite: large tool icons, alignment in a menu", async ({ page }) => {
    await open(page);
    const b64 = await page.evaluate(async () => {
      const c = new OffscreenCanvas(600, 400);
      const g = c.getContext("2d")!;
      g.fillStyle = "#3a6";
      g.fillRect(0, 0, 600, 400);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
    await chooser.setFiles({ name: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
    await expect(page.locator(".cell img")).toHaveCount(1, { timeout: 30_000 });
    await page.locator(".cell").first().tap();
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Composite" }).tap();
    await page.getByRole("button", { name: /Start from 1 selected/ }).tap();
    const tools = page.getByRole("toolbar", { name: "Composite tools" });
    const move = tools.getByRole("button", { name: "Move & transform" });
    await expect(move).toHaveAttribute("aria-pressed", "true");
    const box = (await move.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    await tools.getByRole("button", { name: "Align and distribute" }).tap();
    await expect(page.getByRole("menuitem", { name: "Align left to canvas" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Align left to canvas" }).tap();
    await expect(page.getByRole("banner").getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  });
});

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("the dock is a rail on the right and panels open beside the picture", async ({ page }) => {
    await open(page);
    await importVideo(page, { name: "clip.mp4", mimeType: "video/mp4", buffer: clip() }, true);
    const dock = page.getByRole("navigation", { name: "Panels" });
    const d = (await dock.boundingBox())!;
    expect(d.x).toBeGreaterThan(700);
    expect(d.height).toBeGreaterThan(d.width);
    await dock.getByRole("button", { name: "Edit" }).tap();
    const sheet = (await page.getByTestId("sheet").boundingBox())!;
    const viewer = (await page.getByTestId("viewer").boundingBox())!;
    expect(sheet.x).toBeGreaterThanOrEqual(viewer.x + viewer.width - 1);
    expect(viewer.height).toBeGreaterThan(120);
  });
});
