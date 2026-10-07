import { expect, type Page, test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/**
 * Films the trailer's shots from the real app (1920 × 1080): `npm run trailer:capture`.
 * The media comes from trailer/kit/ (landscape.jpg, subject.jpg, extra.jpg, clip.mp4;
 * see its README); anything missing is a stand-in. Every shot is a PNG in trailer/shots/,
 * named as trailer/scenes.ts uses it.
 */

// In order: the video's stand-in clip is drawn over the edited photo from the first test.
test.describe.configure({ mode: "serial" });

const KIT = "trailer/kit";
const SHOTS = "trailer/shots";
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function save(page: Page, name: string, b64: string, ext = "png") {
  writeFileSync(`${SHOTS}/${name}.${ext}`, Buffer.from(b64, "base64"));
}

/** A screenshot of the whole window (the app as people see it). */
async function snap(page: Page, name: string) {
  await pause(page, 900);
  // After heavy GPU work the first capture can fail; the next one succeeds.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.screenshot({ path: `${SHOTS}/${name}.png` });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await pause(page, 2000);
    }
  }
}

/** The media: yours from the kit, else stand-ins (written to the kit so later runs reuse them). */
async function kit(page: Page) {
  mkdirSync(KIT, { recursive: true });
  const names = ["landscape", "subject", "extra"] as const;
  const have = (n: string) => existsSync(`${KIT}/${n}.jpg`) || existsSync(`${KIT}/standin-${n}.jpg`);
  if (!names.every(have)) {
    const drawn = await page.evaluate(async () => {
      const { drawStandIns } = await import("/trailer/standin.ts" as string);
      return drawStandIns() as Promise<Record<string, string>>;
    });
    for (const n of names) if (!existsSync(`${KIT}/${n}.jpg`)) writeFileSync(`${KIT}/standin-${n}.jpg`, Buffer.from(drawn[n], "base64"));
  }
  const file = (n: string) => (existsSync(`${KIT}/${n}.jpg`) ? `${KIT}/${n}.jpg` : `${KIT}/standin-${n}.jpg`);
  if (!existsSync(`${KIT}/clip.mp4`) && !existsSync(`${KIT}/standin-clip.mp4`)) {
    const backdrop = existsSync(`${SHOTS}/photo-sky.png`) ? `/${SHOTS}/photo-sky.png` : `/${file("landscape")}`;
    const b64 = await page.evaluate(async (url) => {
      const { drawStandInClip } = await import("/trailer/standin-clip.ts" as string);
      return drawStandInClip(url) as Promise<string>;
    }, backdrop);
    writeFileSync(`${KIT}/standin-clip.mp4`, Buffer.from(b64, "base64"));
  }
  const clip = existsSync(`${KIT}/clip.mp4`) ? `${KIT}/clip.mp4` : `${KIT}/standin-clip.mp4`;
  return { landscape: file("landscape"), subject: file("subject"), extra: file("extra"), clip };
}

/** A developed photo as a PNG (base64), `long` px on its long side. */
const photoPng = (page: Page, assetId: string, long: number) =>
  page.evaluate(
    async ([id, size]) => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const { recipeFor } = await import("/src/core/develop/session.ts" as string);
      const engine = developEngine();
      engine.ensureSource(id);
      for (let i = 0; i < 300 && !engine.hasSource(id, "rendered") && !engine.hasSource(id, "raw"); i++) await new Promise((r) => setTimeout(r, 100));
      const canvas = engine.exportPixels(engine.sourceFor(id), recipeFor(id), size) as OffscreenCanvas;
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [assetId, long] as const,
  );

/** The open composition rendered clean (no UI), `long` px on its long side, at time `t`. */
const docPng = (page: Page, long: number, t = 0, type = "image/png") =>
  page.evaluate(
    async ([size, time, kind]) => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const { composite } = await import("/src/core/document/session.ts" as string);
      const doc = composite.getState().doc as { width: number; height: number };
      const image = (await developEngine().renderDocument(doc, size / Math.max(doc.width, doc.height), time)) as ImageData;
      const canvas = new OffscreenCanvas(image.width, image.height);
      canvas.getContext("2d")!.putImageData(image, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: kind, quality: 0.9 })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [long, t, type] as const,
  );

/** Puts one effect over the whole composition (adds the effect layer, or swaps its effect). */
const setEffect = (page: Page, id: string) =>
  page.evaluate(async (effect) => {
    const { composite } = await import("/src/core/document/session.ts" as string);
    const { applyEffect } = await import("/src/features/effects/EffectsBrowser.tsx" as string);
    const doc = composite.getState().doc as { layers: { id: string; kind: string }[] };
    const top = doc.layers.at(-1)!;
    if (top.kind === "effect") applyEffect(effect, { mode: "replace", layerId: top.id });
    else {
      composite.setState({ selection: [top.id] });
      applyEffect(effect, { mode: "add" });
    }
  }, id);

/** The app with an empty library, no tour, no glow, and the bundled (offline) AI. */
async function fresh(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true }));
    localStorage.setItem("ai-quality", "offline");
  });
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
}

test("capture the photo shots", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await fresh(page);
  const media = await kit(page);

  // ── Library: the photos arrive (Ch 1) ──
  await snap(page, "library-empty");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /^Import Photos/ }).first().click()]);
  await chooser.setFiles([media.landscape, media.subject, media.extra]);
  await expect(page.locator(".cell")).toHaveCount(3, { timeout: 60_000 });
  await pause(page, 2500);
  await snap(page, "library");
  const ids = await page.evaluate(async () => {
    const { catalog } = await import("/src/core/catalog/store.ts" as string);
    const all = [...catalog.getState().assets.values()] as { id: string; fileName: string }[];
    const find = (s: string) => all.find((a) => a.fileName.includes(s))!.id;
    return { landscape: find("landscape"), subject: find("subject"), extra: find("extra") };
  });

  // ── Develop: the flat photo, then finished (Ch 2) ──
  await page.locator(".cell").filter({ hasText: "landscape" }).first().click();
  await page.keyboard.press("d");
  await pause(page, 2500);
  await snap(page, "develop-before");
  await save(page, "photo-before", await photoPng(page, ids.landscape, 1920));
  await page.evaluate(async () => {
    const { editRecipe } = await import("/src/core/develop/session.ts" as string);
    editRecipe("Trailer look", (r: { basic: object }) => ({
      ...r,
      basic: { ...r.basic, exposure: 0.15, contrast: 55, highlights: -35, shadows: 25, whites: 45, blacks: -55, clarity: 20, dehaze: 30, vibrance: 50, saturation: 12 },
    }));
  });
  await pause(page, 2500);
  await snap(page, "develop-after");
  await save(page, "photo-after", await photoPng(page, ids.landscape, 1920));

  // ── Masks: only the sky, with the overlay showing where (Ch 2) ──
  await page.evaluate(async () => {
    const { editRecipe, develop } = await import("/src/core/develop/session.ts" as string);
    const { addMask, updateMask } = await import("/src/core/develop/masks.ts" as string);
    editRecipe("Sky", (r: never) => {
      const { recipe, mask } = addMask(r, { kind: "linear", start: { x: 0.5, y: 0.08 }, end: { x: 0.5, y: 0.47 } }, "Sky");
      queueMicrotask(() => develop.setState({ activeMaskId: mask.id, activeComponentId: mask.components[0].id, tool: "mask", maskOverlay: true }));
      return updateMask(recipe, mask.id, (m: { adjustments: object }) => ({ ...m, adjustments: { ...m.adjustments, temperature: 70, tint: 15, exposure: -0.35, contrast: 30, dehaze: 40, saturation: 70 } }));
    });
  });
  await pause(page, 2500);
  await snap(page, "develop-mask");
  await page.evaluate(async () => {
    const { develop } = await import("/src/core/develop/session.ts" as string);
    develop.setState({ maskOverlay: false });
  });
  await pause(page, 1500);
  await snap(page, "develop-sky");
  await save(page, "photo-sky", await photoPng(page, ids.landscape, 1920));
  await save(page, "photo-dunes", await photoPng(page, ids.extra, 1920));
  await page.evaluate(async () => {
    const { develop } = await import("/src/core/develop/session.ts" as string);
    develop.setState({ tool: "adjust", activeMaskId: null });
  });

  // ── Composite: the balloon cut out and put over the lake (Ch 3) ──
  await page.keyboard.press("g");
  await pause(page, 800);
  await page.locator(".cell").filter({ hasText: "landscape" }).first().click();
  await page.locator(".cell").filter({ hasText: "subject" }).first().click({ modifiers: ["Control"] });
  await page.keyboard.press("c");
  await page.getByRole("button", { name: /Start from 2 selected/ }).click();
  await expect(page.locator(".layer-row")).toHaveCount(2, { timeout: 30_000 });
  // The balloon: a third of the frame's height, left of the sun.
  await page.evaluate(async () => {
    const { composite, editDocument } = await import("/src/core/document/session.ts" as string);
    const { updateLayer } = await import("/src/core/document/operations.ts" as string);
    const doc = composite.getState().doc as { width: number; height: number; layers: { id: string; name: string }[] };
    const balloon = doc.layers.find((l) => /subject/.test(l.name))!;
    const h = doc.height * 0.82;
    editDocument("Place", (d: never) => updateLayer(d, balloon.id, (l: { transform: object }) => ({ ...l, transform: { ...l.transform, x: doc.width * 0.3, y: doc.height * 0.47, width: (h * 2) / 3, height: h } })));
    composite.setState({ selection: [balloon.id] });
  });
  await pause(page, 2500);
  await snap(page, "composite-before");
  await save(page, "cut-before", await docPng(page, 1920));
  await page.getByRole("button", { name: "Remove Background" }).click();
  await expect(page.locator(".toast")).toContainText("Background removed", { timeout: 120_000 });
  await pause(page, 2500);
  await snap(page, "composite-after");
  await save(page, "cut-after", await docPng(page, 1920));
  // The cutout on its own (transparent around it), to put anywhere.
  await page.evaluate(async () => {
    const { composite, editDocument } = await import("/src/core/document/session.ts" as string);
    const { updateLayer } = await import("/src/core/document/operations.ts" as string);
    const doc = composite.getState().doc as { layers: { id: string; name: string }[] };
    const back = doc.layers.find((l) => /landscape/.test(l.name))!;
    editDocument("Hide", (d: { background: string | null }) => ({ ...updateLayer(d, back.id, (l: object) => ({ ...l, visible: false })), background: null }));
  });
  await save(page, "balloon", await docPng(page, 1920));
  await page.evaluate(async () => {
    const { compositeHistory } = await import("/src/core/document/session.ts" as string);
    compositeHistory()!.undo();
  });

  // ── Effects: the browser, a grid of looks, halftone, snow (Ch 4) ──
  await page.evaluate(async () => {
    const { openEffectsBrowser } = await import("/src/features/effects/EffectsBrowser.tsx" as string);
    openEffectsBrowser({ mode: "add" });
  });
  await expect(page.locator(".fx-thumb img").first()).toBeVisible({ timeout: 120_000 });
  await pause(page, 6000);
  await snap(page, "effects-browser");
  await page.keyboard.press("Escape");
  const looks = ["halftone-cmyk", "ascii", "bricks", "neon", "stained-glass", "vhs", "cross-stitch", "liquid-glass", "risograph"];
  for (const [i, id] of looks.entries()) {
    await setEffect(page, id);
    await save(page, `fx-${i}`, await docPng(page, 960));
  }
  await setEffect(page, "halftone-cmyk");
  await pause(page, 2000);
  await snap(page, "composite-halftone");
  await save(page, "fx-halftone", await docPng(page, 1920));
  await setEffect(page, "snow");
  for (let f = 0; f < 120; f++) await save(page, `snow-${String(f).padStart(3, "0")}`, await docPng(page, 1600, f / 30, "image/jpeg"), "jpg");

  // ── Design: a two-slide carousel on one backdrop (Ch 3) ──
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
  await page.getByRole("searchbox").first().fill("two photos");
  await page.locator(".template-card", { hasText: "Two photos on one backdrop" }).click();
  await page.getByRole("toolbar", { name: "Slides" }).waitFor();
  await page.evaluate(async (all) => {
    const { placePhotos } = await import("/src/features/composite/actions.ts" as string);
    await placePhotos([all.subject, all.extra, all.landscape]);
  }, ids);
  await page.waitForFunction(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    return !developEngine().compositeLoading;
  }, undefined, { timeout: 300_000, polling: 1000 });
  await pause(page, 2500);
  await snap(page, "design");
  await save(page, "carousel", await docPng(page, 2160));

  writeFileSync(`${SHOTS}/ids.json`, JSON.stringify(ids));
});

test("capture the video shots", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await fresh(page);
  const media = await kit(page);
  // ── Video: a clip, cut and stuttered (Ch 5) ──
  const [videoChooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: /^Import Photos/ }).first().click()]);
  await videoChooser.setFiles(media.clip);
  await expect(page.getByTestId("viewer")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("segment")).toHaveCount(1, { timeout: 30_000 });
  await pause(page, 1500);
  await snap(page, "video-before");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("s");
  await expect(page.getByTestId("segment")).toHaveCount(2);
  // The second half: stutter ("w-w-w-what", a quarter second a repeat) and a stare-down.
  await page.getByRole("button", { name: "Stutter", exact: true }).click();
  await page.getByRole("button", { name: "Stare down", exact: true }).click();
  await page.evaluate(async () => {
    const { editVideo, video } = await import("/src/core/video/session.ts" as string);
    const { updateSegments } = await import("/src/core/video/timeline.ts" as string);
    const id = (video.getState().edit as { segments: { id: string }[] }).segments[1].id;
    editVideo("Stutter length", (e: never) => updateSegments(e, new Set([id]), (seg: object) => ({ ...seg, stutterLength: 0.25 })));
  });
  await pause(page, 1500);
  await snap(page, "video");
  // Every frame of the edit as the viewer shows it.
  await page.keyboard.press("Home");
  await pause(page, 500);
  const total = Number((await page.getByText(/^frame \d+ of \d+$/).textContent())!.match(/of (\d+)/)![1]);
  for (let f = 0; f < total; f++) {
    await expect(page.getByText(`frame ${f + 1} of ${total}`)).toBeVisible();
    await pause(page, 120);
    await page.getByTestId("viewer").screenshot({ path: `${SHOTS}/clip-${String(f).padStart(3, "0")}.jpg`, type: "jpeg", quality: 90 });
    await page.keyboard.press("ArrowRight");
  }
  // Where the stutters start (the cut is at 1 s; each repeat is a quarter second, 8 frames).
  writeFileSync(`${SHOTS}/clip.json`, JSON.stringify({ fps: 30, frames: total, cut: 30, repeat: 8, repeats: 4 }));
});
