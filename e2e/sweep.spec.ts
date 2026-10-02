import { expect, type Locator, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
  page.on("dialog", (d) => void d.accept());
});

async function freshLibrary(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
  await expect(page.getByText("Your library is empty")).toBeVisible();
}

async function photo(page: Page, name: string, color: string) {
  const base64 = await page.evaluate(async (c) => {
    const canvas = new OffscreenCanvas(600, 400);
    const g = canvas.getContext("2d")!;
    g.fillStyle = c;
    g.fillRect(0, 0, 600, 400);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, color);
  return { name, mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
}

const center = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
};

/** Right-button press at `from`, drag to `to`, release: a sweep. */
async function sweep(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up({ button: "right" });
}

test("sweep select: library photos and composite layers (list and canvas), quick right-click and hold", async ({ page }) => {
  await freshLibrary(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles([await photo(page, "a.jpg", "#c33"), await photo(page, "b.jpg", "#3c3"), await photo(page, "c.jpg", "#33c"), await photo(page, "d.jpg", "#cc3")]);
  const cells = page.locator(".cell");
  await expect(page.locator(".cell img")).toHaveCount(4, { timeout: 30_000 });

  // A quick right-click still opens the ordinary menu for one photo.
  const last = await center(cells.nth(3));
  await page.mouse.click(last.x, last.y, { button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove photo…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu")).toHaveCount(0);

  // Holding without moving selects the photo under the pointer and opens the menu on release.
  const first = await center(cells.nth(0));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down({ button: "right" });
  await page.waitForTimeout(450);
  await expect(page.locator(".sweep-box")).toHaveCount(1);
  await page.mouse.up({ button: "right" });
  await expect(cells.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cell[aria-selected='true']")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Esc during a sweep puts the old selection back.
  const third = await center(cells.nth(2));
  await page.mouse.move(first.box.x - 3, first.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(third.x, third.y, { steps: 8 });
  await expect(page.locator(".cell[aria-selected='true']")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await page.mouse.up({ button: "right" });
  await expect(page.locator(".cell[aria-selected='true']")).toHaveCount(1);
  await expect(page.locator(".menu")).toHaveCount(0);

  // Sweep the first three photos and add them to a new composition in one go.
  await sweep(page, { x: first.box.x - 3, y: first.y }, third);
  await expect(page.locator(".cell[aria-selected='true']")).toHaveCount(3);
  await page.getByRole("menuitem", { name: "Add to Composite" }).click();
  const rows = page.locator(".layer-row");
  await expect(rows).toHaveCount(3, { timeout: 15_000 });

  // Layers panel: sweep two rows, delete both from the batch menu.
  const r0 = await center(rows.nth(0));
  const r1 = await center(rows.nth(1));
  await sweep(page, { x: r0.x, y: r0.box.y + 2 }, { x: r1.x, y: r1.y });
  await expect(page.locator(".layer-row[aria-selected='true']")).toHaveCount(2);
  await page.getByRole("menuitem", { name: "Delete 2 layers" }).click();
  await expect(rows).toHaveCount(1);

  // Canvas: duplicate the last layer, then sweep the whole canvas to catch both.
  await rows.first().click();
  await page.keyboard.press("Control+j");
  await expect(rows).toHaveCount(2);
  const view = (await page.locator(".composite-view").boundingBox())!;
  await sweep(page, { x: view.x + 30, y: view.y + 30 }, { x: view.x + view.width - 30, y: view.y + view.height - 30 });
  await expect(page.locator(".layer-row[aria-selected='true']")).toHaveCount(2);
  await page.getByRole("menuitem", { name: "Delete 2 layers" }).click();
  await expect(rows).toHaveCount(0);

  // Back in the Library: sweep all four photos and remove them together.
  await page.keyboard.press("g");
  await expect(cells).toHaveCount(4);
  const fourth = await center(cells.nth(3));
  await sweep(page, { x: (await cells.nth(0).boundingBox())!.x - 3, y: fourth.y }, fourth);
  await page.getByRole("menuitem", { name: "Remove 4 photos…" }).click();
  await expect(page.getByText("Your library is empty")).toBeVisible();
});

test("sweep select: video segments and clips (batch delete and insert)", async ({ page }) => {
  await freshLibrary(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Photos…" }).click()]);
  await chooser.setFiles("tests/fixtures/clip.mp4");
  await expect(page.getByTestId("viewer")).toBeVisible({ timeout: 30_000 });
  const segments = page.getByTestId("segment");
  await expect(segments).toHaveCount(1);

  // Cut into three pieces at one third and two thirds.
  const ruler = (await page.getByRole("slider", { name: "Playhead" }).boundingBox())!;
  for (const f of [0.33, 0.66]) {
    await page.mouse.click(ruler.x + ruler.width * f, ruler.y + ruler.height / 2);
    await page.keyboard.press("s");
  }
  await expect(segments).toHaveCount(3);

  // Quick right-click on one segment: its menu.
  const s2 = await center(segments.nth(2));
  await page.mouse.click(s2.x, s2.y, { button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete Del" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Sweep the first two segments and delete them together.
  const s0 = await center(segments.nth(0));
  const s1 = await center(segments.nth(1));
  await sweep(page, { x: s0.box.x + 12, y: s0.y }, s1);
  await expect(page.locator(".vt-seg[aria-selected='true']")).toHaveCount(2);
  await page.getByRole("menuitem", { name: "Delete 2 segments" }).click();
  await expect(segments).toHaveCount(1);

  // A second clip in the Videos list, then sweep both clips and insert them at the playhead.
  const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "+ Import" }).click()]);
  await chooser2.setFiles("tests/fixtures/clip-28.96fps.mp4");
  const clips = page.locator(".vid-clip");
  await expect(clips).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("viewer")).toBeVisible();
  const before = await segments.count();
  const c0 = await center(clips.nth(0));
  const c1 = await center(clips.nth(1));
  await sweep(page, { x: c0.x, y: c0.box.y + 2 }, c1);
  await expect(page.locator(".vid-clip[data-selected]")).toHaveCount(2);
  await page.getByRole("menuitem", { name: "Insert 2 clips at the playhead" }).click();
  await expect(segments).toHaveCount(before + 2);
});
