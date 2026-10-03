import { expect, type Page, test } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Memory benchmark for phones. An iPhone-sized session imports 24 MP photos, opens
 * them in Develop, swipes between them, makes AI and brush masks and zooms to 100 %.
 * The memory of the browser's renderer and GPU processes (proportional set size, so
 * shared pages are not double counted) is sampled every 100 ms; each phase reports
 * its peak and where it settled, with the engine's own count of GPU texture memory.
 *
 *   npm run bench              → prints a table and writes bench/results/<label>.json
 *   BENCH_LABEL=after npm run bench
 */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const PHOTOS = 4;
const W = 6000;
const H = 4000;
const FIXTURES = ".scratch/bench";

test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

/** PSS (MB) of Chromium's renderer and GPU processes. */
function browserMemory(): number {
  const { renderer, gpu } = memoryByProcess();
  return renderer + gpu;
}

function memoryByProcess(): { renderer: number; gpu: number } {
  const out = { renderer: 0, gpu: 0 };
  for (const line of execSync("ps -eo pid=,args=", { encoding: "utf8" }).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    const type = m && /chrom/i.test(m[2]) ? m[2].match(/--type=(renderer|gpu-process)/)?.[1] : undefined;
    if (!m || !type) continue;
    try {
      const rollup = readFileSync(`/proc/${m[1]}/smaps_rollup`, "utf8");
      out[type === "renderer" ? "renderer" : "gpu"] += Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) / 1024;
    } catch {
      // The process exited between ps and the read.
    }
  }
  return out;
}

type Phase = { phase: string; peakMB: number; settledMB: number; rendererMB: number; gpuProcMB: number; jsHeapMB: number; gpuMB: number; textures: number; sources: number; cpuSourceMB: number; ms: number };

async function engineStats(page: Page) {
  return page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    return { ...(developEngine().stats() as { gpuBytes: number; textures: number; sources: number; cpuBytes: number }), heap };
  });
}

async function photos(page: Page) {
  mkdirSync(FIXTURES, { recursive: true });
  const files = [];
  for (let i = 0; i < PHOTOS; i++) {
    const path = `${FIXTURES}/photo-${i}.jpg`;
    if (!existsSync(path)) {
      const b64 = await page.evaluate(
        async ({ w, h, hue }) => {
          const c = new OffscreenCanvas(w, h);
          const g = c.getContext("2d")!;
          const gr = g.createLinearGradient(0, 0, w, h);
          gr.addColorStop(0, `hsl(${hue} 60% 25%)`);
          gr.addColorStop(1, `hsl(${hue + 60} 70% 70%)`);
          g.fillStyle = gr;
          g.fillRect(0, 0, w, h);
          g.fillStyle = `hsl(${hue + 180} 60% 50%)`;
          g.beginPath();
          g.arc(w / 2, h * 0.55, h * 0.3, 0, 7);
          g.fill();
          // Fine noise so the JPEG has a realistic size (~8–12 MB).
          const tile = g.getImageData(0, 0, 512, 512);
          for (let y = 0; y < h; y += 512)
            for (let x = 0; x < w; x += 512) {
              const t = g.getImageData(x, y, 512, 512);
              for (let k = 0; k < t.data.length; k += 4) {
                const n = (Math.random() - 0.5) * 24;
                t.data[k] += n;
                t.data[k + 1] += n;
                t.data[k + 2] += n;
              }
              g.putImageData(t, x, y);
            }
          void tile;
          const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
          let s = "";
          for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
          return btoa(s);
        },
        { w: W, h: H, hue: i * 80 },
      );
      writeFileSync(path, Buffer.from(b64, "base64"));
    }
    files.push({ name: `IMG_${1000 + i}.JPG`, mimeType: "image/jpeg", buffer: readFileSync(path) });
  }
  return files;
}

test("phone memory: import, develop, swipe, masks, zoom", async ({ page, browser }) => {
  // Fixtures come from a throwaway page so their generation is not measured.
  const scratch = await browser.newPage();
  await scratch.goto("/");
  const files = await photos(scratch);
  await scratch.close();

  await page.addInitScript(() => {
    localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false }));
    localStorage.setItem("ai-quality", "offline");
  });
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  await page.waitForTimeout(1500);

  const results: Phase[] = [];
  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, browserMemory());
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const phase = async (name: string, run: () => Promise<void>) => {
    peak = browserMemory();
    const start = Date.now();
    await run();
    const ms = Date.now() - start;
    await page.waitForTimeout(1500);
    const split = memoryByProcess();
    const settled = split.renderer + split.gpu;
    const s = await engineStats(page);
    results.push({
      phase: name,
      peakMB: Math.round(Math.max(peak, settled)),
      settledMB: Math.round(settled),
      rendererMB: Math.round(split.renderer),
      gpuProcMB: Math.round(split.gpu),
      jsHeapMB: Math.round(s.heap / 1048576),
      gpuMB: Math.round(s.gpuBytes / 1048576),
      textures: s.textures,
      sources: s.sources,
      cpuSourceMB: Math.round(s.cpuBytes / 1048576),
      ms,
    });
  };

  const first = memoryByProcess();
  results.push({ phase: "start", peakMB: Math.round(first.renderer + first.gpu), settledMB: Math.round(first.renderer + first.gpu), rendererMB: Math.round(first.renderer), gpuProcMB: Math.round(first.gpu), jsHeapMB: 0, gpuMB: 0, textures: 0, sources: 0, cpuSourceMB: 0, ms: 0 });

  await phase("import 4 × 24 MP", async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import photos", exact: true }).tap()]);
    await chooser.setFiles(files);
    await expect(page.locator(".cell img")).toHaveCount(PHOTOS, { timeout: 180_000 });
  });

  await phase("open in Develop", async () => {
    await page.locator(".cell").first().tap();
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Develop" }).tap();
    await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 120_000 });
    await expect.poll(async () => (await engineStats(page)).sources, { timeout: 60_000 }).toBeGreaterThan(0);
  });

  const swipe = async () => {
    const cdp = await page.context().newCDPSession(page);
    const box = (await page.locator(".develop-view").boundingBox())!;
    const y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 330, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 330 - i * 27, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.locator("canvas.develop-canvas").evaluate((el) => el.style.transform), { timeout: 30_000 }).toBe("");
    await expect(page.locator(".develop-status")).toHaveCount(0, { timeout: 120_000 });
  };
  await phase("swipe ×3", async () => {
    for (let i = 0; i < 3; i++) {
      await swipe();
      await page.waitForTimeout(1500);
    }
  });

  await phase("Select Subject + brush", async () => {
    await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Masks" }).tap();
    await page.getByRole("button", { name: "+ Create" }).tap();
    await page.getByRole("menuitem", { name: "Select Subject" }).tap();
    await expect(page.getByText("AI: Subject").first()).toBeVisible({ timeout: 120_000 });
    // A brush mask with a long stroke, through the recipe (what painting produces).
    await page.evaluate(async () => {
      const { editRecipe } = await import("/src/core/develop/session.ts" as string);
      const { addMask } = await import("/src/core/develop/masks.ts" as string);
      const points: number[][] = [];
      for (let i = 0; i <= 200; i++) points.push([0.1 + i * 0.004, 0.5 + Math.sin(i / 10) * 0.2, 1]);
      editRecipe("Brush", (r: never) => {
        const { recipe, mask } = addMask(r, { kind: "brush", strokes: [{ points, size: 0.05, feather: 0.5, flow: 1, density: 1, mode: "paint" }] } as never, "Brush");
        type M = { id: string; adjustments: Record<string, number> };
        return { ...recipe, masks: recipe.masks.map((m: M) => (m.id === mask.id ? { ...m, adjustments: { ...m.adjustments, exposure: 0.5 } } : m)) };
      });
    });
  });

  await phase("zoom 100 % and pan", async () => {
    await page.evaluate(async () => {
      const { develop } = await import("/src/core/develop/session.ts" as string);
      develop.setState({ view: { fit: false, zoom: 1, centerX: 0.5, centerY: 0.5 } });
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 300));
        develop.setState({ view: { fit: false, zoom: 1, centerX: 0.3 + i * 0.08, centerY: 0.5 } });
      }
    });
  });

  await phase("back to Library", async () => {
    await page.evaluate(async () => {
      const { develop } = await import("/src/core/develop/session.ts" as string);
      develop.setState({ view: { fit: true, zoom: 1, centerX: 0.5, centerY: 0.5 } });
    });
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Library" }).tap();
  });

  await phase("idle 20 s", async () => {
    await page.waitForTimeout(20_000);
  });

  sampling = false;
  await sampler;
  const label = process.env.BENCH_LABEL ?? "run";
  mkdirSync("bench/results", { recursive: true });
  writeFileSync(`bench/results/${label}.json`, JSON.stringify(results, null, 2));
  console.log(`\n${label}`);
  console.table(results);
});
