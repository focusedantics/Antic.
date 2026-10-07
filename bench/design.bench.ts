import { type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Speed benchmark for Design. A five-slide carousel (the "Five tips" template, 16 layers,
 * 5400 × 1350) with three photos added is edited the way people do: a layer dragged,
 * nudged with the arrow keys, slides tapped (the view glides), zoom in and out, a pan.
 * Each phase reports its wall time, how many times the canvas was composited and how
 * long that took (the GPU waited for, so the cost is real even on a software GPU),
 * the pixels composited, the longest gap between two frames and the long-task time.
 *
 *   npm run bench -- design.bench.ts                → prints tables, writes bench/results/design-<label>-<device>.json
 *   BENCH_LABEL=after npm run bench -- design.bench.ts
 *   BENCH_PORT=5175 runs against another dev server (e.g. a worktree of an older commit)
 */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

type Phase = { phase: string; ms: number; frames: number; worstFrameMs: number; renders: number; renderMs: number; mpx: number; longTaskMs: number };

const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
const settle = async (page: Page, ms = 600) => {
  await page.waitForTimeout(ms);
  await nextFrame(page);
};

/** Counts composites (waiting for the GPU so their time is real), frames and long tasks. */
async function instrument(page: Page) {
  await page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const engine = developEngine();
    const w = window as unknown as { __bench: { renders: number; renderMs: number; px: number; frames: number; worst: number; last: number; long: number } };
    w.__bench = { renders: 0, renderMs: 0, px: 0, frames: 0, worst: 0, last: performance.now(), long: 0 };
    const wrap = () => {
      const comp = engine.compositor;
      if (comp.__wrapped) return;
      const render = comp.render.bind(comp);
      comp.render = (...args: unknown[]) => {
        const t = performance.now();
        const out = render(...args);
        // gl.finish does not wait in Chromium: reading a pixel of the result does.
        const gl = engine.gpu.gl as WebGL2RenderingContext;
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, out.format === "rgba8" ? gl.UNSIGNED_BYTE : gl.FLOAT, out.format === "rgba8" ? new Uint8Array(4) : new Float32Array(4));
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        w.__bench.renders++;
        w.__bench.renderMs += performance.now() - t;
        w.__bench.px += out.width * out.height;
        return out;
      };
      comp.__wrapped = true;
    };
    wrap();
    const tick = (now: number) => {
      wrap();
      w.__bench.frames++;
      w.__bench.worst = Math.max(w.__bench.worst, now - w.__bench.last);
      w.__bench.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__bench.long += e.duration;
    }).observe({ type: "longtask", buffered: false });
  });
}

async function measure(page: Page, phase: string, run: () => Promise<void>): Promise<Phase> {
  console.log(`  … ${phase}`);
  await page.evaluate(() => {
    const b = (window as unknown as { __bench: Record<string, number> }).__bench;
    Object.assign(b, { renders: 0, renderMs: 0, px: 0, frames: 0, worst: 0, last: performance.now(), long: 0 });
  });
  const t = Date.now();
  await run();
  await settle(page, 300);
  const ms = Date.now() - t;
  const b = await page.evaluate(() => (window as unknown as { __bench: Record<string, number> }).__bench);
  return { phase, ms, frames: b.frames, worstFrameMs: Math.round(b.worst), renders: b.renders, renderMs: Math.round(b.renderMs), mpx: Math.round(b.px / 1e5) / 10, longTaskMs: Math.round(b.long) };
}

/** A design to edit: the Five tips carousel with three photos on slides 2–4. */
async function openCarousel(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true }));
  });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
  await page.waitForTimeout(800);
  // Photos into the Library (3000 × 2000, with detail so they decode like real ones).
  await page.evaluate(async () => {
    const files: File[] = [];
    for (let i = 0; i < 3; i++) {
      const c = new OffscreenCanvas(3000, 2000);
      const g = c.getContext("2d")!;
      const gr = g.createLinearGradient(0, 0, 3000, 2000);
      gr.addColorStop(0, `hsl(${i * 90} 60% 30%)`);
      gr.addColorStop(1, `hsl(${i * 90 + 60} 70% 70%)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 3000, 2000);
      for (let k = 0; k < 400; k++) {
        g.fillStyle = `hsla(${(k * 37) % 360} 60% 50% / 0.5)`;
        g.fillRect((k * 7919) % 3000, (k * 104729) % 2000, 60, 60);
      }
      files.push(new File([await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })], `photo-${i}.jpg`, { type: "image/jpeg" }));
    }
    const { importFilesToLibrary } = await import("/src/features/composite/actions.ts" as string);
    (window as unknown as { __photos: string[] }).__photos = await importFilesToLibrary(files);
  });
}

async function startTemplate(page: Page, phone: boolean) {
  if (phone) {
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Design" }).tap();
  } else {
    await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
  }
  await page.getByRole("searchbox").first().fill("five tips");
  const card = page.locator(".template-card", { hasText: "Five tips" });
  if (phone) await card.tap();
  else await card.click();
  await page.getByRole("toolbar", { name: "Slides" }).waitFor();
}

async function addPhotos(page: Page) {
  await page.evaluate(async () => {
    const { addAssetsToComposite } = await import("/src/features/composite/actions.ts" as string);
    const { focusSlide } = await import("/src/features/design/Carousel.tsx" as string);
    const ids = (window as unknown as { __photos: string[] }).__photos;
    for (let i = 0; i < ids.length; i++) {
      focusSlide(i + 1, false);
      await addAssetsToComposite([ids[i]]);
    }
    focusSlide(0, false);
  });
}

const onScreen = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([dx, dy]) => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      return developEngine().docToClient(dx, dy) as { x: number; y: number };
    },
    [x, y] as const,
  );

async function run(page: Page, label: string, phone: boolean) {
  const phases: Phase[] = [];
  await openCarousel(page);
  await instrument(page);
  phases.push(await measure(page, "open the template", () => startTemplate(page, phone)));
  phases.push(await measure(page, "add 3 photos", async () => {
    await addPhotos(page);
    // Photos decode in the background: wait until the composite has them.
    await page.waitForFunction(async () => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      return !developEngine().compositeLoading;
    }, undefined, { timeout: 900_000, polling: 1000 });
  }));
  await settle(page, 1000);

  // Drag the big title on slide 1 (doc 540, 670) right and back, a frame per step.
  phases.push(await measure(page, "drag a layer (12 steps)", async () => {
    const from = await onScreen(page, 540, 670);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from.x + Math.sin((i / 12) * Math.PI) * 60, from.y + i * 2);
      await nextFrame(page);
    }
    await page.mouse.up();
  }));

  phases.push(await measure(page, "nudge with arrows (10)", async () => {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(i < 5 ? "ArrowRight" : "ArrowLeft");
      await nextFrame(page);
    }
  }));

  const bar = page.getByRole("toolbar", { name: "Slides" });
  phases.push(await measure(page, "tap through 5 slides", async () => {
    for (const i of [2, 3, 4, 5, 1]) {
      const b = bar.getByRole("button", { name: `Slide ${i}`, exact: true });
      if (phone) await b.tap();
      else await b.click();
      await page.waitForTimeout(350);
    }
  }));

  phases.push(await measure(page, "zoom in and out (12 steps)", async () => {
    await page.evaluate(async () => {
      const { zoomComposite } = await import("/src/features/composite/View.tsx" as string);
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const engine = developEngine();
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const base = engine.compositeScale();
      for (let i = 1; i <= 6; i++) {
        zoomComposite(base * 1.25 ** i);
        await frame();
      }
      for (let i = 5; i >= 0; i--) {
        zoomComposite(base * 1.25 ** i);
        await frame();
      }
    });
  }));

  phases.push(await measure(page, "pan zoomed in (12 steps)", async () => {
    await page.evaluate(async () => {
      const { zoomComposite } = await import("/src/features/composite/View.tsx" as string);
      const { composite } = await import("/src/core/document/session.ts" as string);
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      zoomComposite(developEngine().compositeScale() * 2);
      await frame();
      for (let i = 0; i < 12; i++) {
        const { view } = composite.getState();
        composite.setState({ view: { ...view, centerX: view.centerX + 0.01 } });
        await frame();
      }
    });
  }));

  mkdirSync("bench/results", { recursive: true });
  writeFileSync(`bench/results/design-${label}.json`, JSON.stringify(phases, null, 2));
  console.log(`\n${label}`);
  console.table(phases);
}

const LABEL = process.env.BENCH_LABEL ?? "run";

test.describe("design speed: phone", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  test("phone", async ({ page }) => run(page, `${LABEL}-phone`, true));
});

test.describe("design speed: computer", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  test("computer", async ({ page }) => run(page, `${LABEL}-computer`, false));
});
