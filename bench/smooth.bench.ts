import { type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * "Does it feel smooth" benchmark, across the app: the Library (120 photos: scroll, step,
 * rate), Develop (a slider dragged), the Design home (open, scroll, change category) and a
 * stylized poster (opened, a detail typed, a layer dragged and nudged). Each phase reports
 * its wall time, the frames and the longest gap between two, long-task time, React commits,
 * and how many times the canvas was composited or a photo developed and for how long (the
 * GPU waited for, so the cost is real on a software GPU too).
 *
 *   npm run bench -- smooth.bench.ts
 *   BENCH_LABEL=after npm run bench -- smooth.bench.ts     → bench/results/smooth-<label>-<device>.json
 *   BENCH_ONLY=design|library runs part of it
 */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

type Phase = { phase: string; ms: number; frames: number; worstFrameMs: number; longTaskMs: number; commits: number; composites: number; compositeMs: number; mpx: number; develops: number; developMs: number };
type Counters = { frames: number; worst: number; last: number; long: number; commits: number; composites: number; compositeMs: number; px: number; develops: number; developMs: number };

const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
const settle = async (page: Page, ms = 500) => {
  await page.waitForTimeout(ms);
  await nextFrame(page);
};

/** Before the app loads: count React commits (through the DevTools hook React looks for) and long tasks. */
async function prepare(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("focused:prefs")) localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true }));
    const w = window as unknown as { __bench: Counters; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__bench = { frames: 0, worst: 0, last: performance.now(), long: 0, commits: 0, composites: 0, compositeMs: 0, px: 0, develops: 0, developMs: 0 };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      onCommitFiberRoot: () => w.__bench.commits++,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      checkDCE: () => {},
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__bench.long += e.duration;
    }).observe({ type: "longtask", buffered: false });
    const tick = (now: number) => {
      w.__bench.frames++;
      w.__bench.worst = Math.max(w.__bench.worst, now - w.__bench.last);
      w.__bench.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("ai-quality", "offline");
    indexedDB.deleteDatabase("focused-catalog");
  });
  await page.reload();
  await page.waitForTimeout(800);
}

/** Times the view's composites and photo develops, waiting for the GPU (gl.finish doesn't in Chromium). */
async function instrumentEngine(page: Page) {
  await page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const engine = developEngine();
    const b = (window as unknown as { __bench: Counters }).__bench;
    const gl = engine.gpu.gl as WebGL2RenderingContext;
    const wait = (out: { framebuffer: WebGLFramebuffer; format: string }) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, out.format === "rgba8" ? gl.UNSIGNED_BYTE : gl.FLOAT, out.format === "rgba8" ? new Uint8Array(4) : new Float32Array(4));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    let depth = 0;
    const wrap = () => {
      const comp = engine.compositor;
      if (comp && !comp.__wrapped) {
        const render = comp.render.bind(comp);
        comp.render = (...args: unknown[]) => {
          const t = performance.now();
          depth++;
          const out = render(...args);
          depth--;
          wait(out);
          b.composites++;
          b.compositeMs += performance.now() - t;
          b.px += out.width * out.height;
          return out;
        };
        comp.__wrapped = true;
      }
      const pipe = engine.pipeline;
      if (pipe && !pipe.__wrapped) {
        const render = pipe.render.bind(pipe);
        pipe.render = (...args: unknown[]) => {
          // Develops inside a composite are part of that composite's time.
          if (depth) return render(...args);
          const t = performance.now();
          const out = render(...args);
          wait(out);
          b.develops++;
          b.developMs += performance.now() - t;
          return out;
        };
        pipe.__wrapped = true;
      }
    };
    wrap();
    setInterval(wrap, 200);
  });
}

async function measure(page: Page, phases: Phase[], phase: string, run: () => Promise<void>, rest = 300) {
  console.log(`  … ${phase}`);
  await page.evaluate(() => {
    const b = (window as unknown as { __bench: Counters }).__bench;
    Object.assign(b, { frames: 0, worst: 0, last: performance.now(), long: 0, commits: 0, composites: 0, compositeMs: 0, px: 0, develops: 0, developMs: 0 });
  });
  const t = Date.now();
  await run();
  await settle(page, rest);
  const ms = Date.now() - t;
  const b = await page.evaluate(() => (window as unknown as { __bench: Counters }).__bench);
  phases.push({
    phase,
    ms,
    frames: b.frames,
    worstFrameMs: Math.round(b.worst),
    longTaskMs: Math.round(b.long),
    commits: b.commits,
    composites: b.composites,
    compositeMs: Math.round(b.compositeMs),
    mpx: Math.round(b.px / 1e5) / 10,
    develops: b.develops,
    developMs: Math.round(b.developMs),
  });
}

/** `count` small photos into the Library (1200 × 800 JPEGs with some detail). */
async function importPhotos(page: Page, count: number) {
  await page.evaluate(async (n) => {
    const files: File[] = [];
    for (let i = 0; i < n; i++) {
      const c = new OffscreenCanvas(1200, 800);
      const g = c.getContext("2d")!;
      const gr = g.createLinearGradient(0, 0, 1200, 800);
      gr.addColorStop(0, `hsl(${(i * 37) % 360} 60% 30%)`);
      gr.addColorStop(1, `hsl(${(i * 37 + 80) % 360} 70% 70%)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 1200, 800);
      for (let k = 0; k < 60; k++) {
        g.fillStyle = `hsla(${(k * 53 + i) % 360} 60% 50% / 0.5)`;
        g.fillRect((k * 7919 + i * 31) % 1200, (k * 104729) % 800, 50, 50);
      }
      files.push(new File([await c.convertToBlob({ type: "image/jpeg", quality: 0.85 })], `photo-${String(i).padStart(3, "0")}.jpg`, { type: "image/jpeg" }));
    }
    const { importFilesToLibrary } = await import("/src/features/composite/actions.ts" as string);
    await importFilesToLibrary(files);
  }, count);
}

const go = async (page: Page, phone: boolean, name: string) => {
  if (phone) {
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name }).tap();
  } else await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
};

const onScreen = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([dx, dy]) => {
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      return developEngine().docToClient(dx, dy) as { x: number; y: number };
    },
    [x, y] as const,
  );

async function library(page: Page, phases: Phase[], phone: boolean) {
  await measure(page, phases, "import 120 photos", () => importPhotos(page, 120), 1500);
  const grid = page.locator(".grid-scroll").first();
  await measure(page, phases, "scroll the grid (24 steps)", async () => {
    const box = (await grid.boundingBox()) ?? { x: 200, y: 200, width: 400, height: 400 };
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 24; i++) {
      await page.mouse.wheel(0, i < 12 ? 400 : -400);
      await nextFrame(page);
    }
  });
  if (!phone) {
    await page.locator(".cell").first().click();
    await measure(page, phases, "step through 20 photos (→)", async () => {
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press("ArrowRight");
        await nextFrame(page);
      }
    });
    await measure(page, phases, "rate 10 photos", async () => {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press(String((i % 5) + 1));
        await page.keyboard.press("ArrowLeft");
        await nextFrame(page);
      }
    });
    await measure(page, phases, "open in Develop", async () => {
      await page.keyboard.press("d");
      await page.waitForFunction(
        async () => {
          const { develop } = await import("/src/core/develop/session.ts" as string);
          return !develop.getState().loading && develop.getState().source !== "preview";
        },
        undefined,
        { timeout: 120_000, polling: 250 },
      );
    }, 800);
    await instrumentEngine(page);
    await settle(page, 300);
    await measure(page, phases, "drag Exposure (16 steps)", async () => {
      const slider = page.getByRole("slider", { name: "Exposure" }).first();
      await slider.focus();
      for (let i = 0; i < 16; i++) {
        await page.keyboard.press(i < 8 ? "ArrowRight" : "ArrowLeft");
        await nextFrame(page);
      }
    }, 900);
    await measure(page, phases, "next photo in Develop × 4", async () => {
      await page.locator("body").click({ position: { x: 700, y: 400 } });
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(700);
      }
    }, 800);
    await page.keyboard.press("g");
  }
}

async function design(page: Page, phases: Phase[], phone: boolean) {
  // A few saved designs first, as a returning user has.
  await page.evaluate(async () => {
    const { createDocument } = await import("/src/core/document/operations.ts" as string);
    const { putDocument } = await import("/src/core/catalog/db.ts" as string);
    for (let i = 0; i < 6; i++) {
      const d = createDocument(1080, 1350, `Poster ${i + 1}`, "#223344", "design");
      await putDocument({ id: d.id, name: d.name, updatedAt: Date.now() - i * 1000, data: d });
    }
  }).catch(() => undefined);
  await measure(page, phases, "open the Design home", async () => {
    await go(page, phone, "Design");
    await page.getByRole("heading", { name: "Templates" }).waitFor();
  }, 600);
  await measure(page, phases, "scroll the home to the end (30 steps)", async () => {
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 500);
      await nextFrame(page);
    }
  });
  const nodes = await page.evaluate(() => document.querySelectorAll("*").length);
  console.log(`    DOM nodes on the Design home: ${nodes}`);
  await page.evaluate(() => document.querySelector(".design-home")?.closest("main, .center, .workspace")?.scrollTo?.(0, 0));
  await page.mouse.wheel(0, -20000);
  await measure(page, phases, "show the Stylized category", async () => {
    const chip = page.getByRole("button", { name: "Stylized", exact: true });
    await chip.scrollIntoViewIfNeeded();
    if (phone) await chip.tap();
    else await chip.click();
    await page.locator(".template-card", { hasText: "Club night" }).waitFor();
  });
  await instrumentEngine(page).catch(() => undefined);
  await measure(page, phases, "open a stylized poster", async () => {
    const card = page.locator(".template-card", { hasText: "Club night" });
    if (phone) await card.tap();
    else await card.click();
    await page.getByRole("toolbar", { name: "Design tools" }).waitFor();
    await instrumentEngine(page);
  }, 1500);
  await instrumentEngine(page);
  await settle(page, 1200);

  if (phone) await page.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Details" }).tap();
  await measure(page, phases, "type a detail (8 keys)", async () => {
    const field = page.getByRole("textbox", { name: "Date", exact: true });
    await field.focus();
    await page.keyboard.press("End");
    for (const key of ["Backspace", "Backspace", "Backspace", "J", "A", "N", " ", "9"]) {
      await page.keyboard.press(key);
      await nextFrame(page);
    }
  }, 600);
  if (phone) {
    const close = page.getByTestId("sheet").getByRole("button", { name: /^Close/ });
    if (await close.isVisible()) await close.tap();
  }

  // Drag the subtitle ("RITUAL", around the middle of the poster) and back.
  await measure(page, phases, "drag a layer (12 steps)", async () => {
    const from = await onScreen(page, 1275, 1520);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from.x + Math.sin((i / 12) * Math.PI) * 50, from.y + i * 2);
      await nextFrame(page);
    }
    await page.mouse.up();
  }, 600);
  await measure(page, phases, "nudge with arrows (10)", async () => {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(i < 5 ? "ArrowRight" : "ArrowLeft");
      await nextFrame(page);
    }
  }, 600);
  await measure(page, phases, "zoom in and out (12 steps)", async () => {
    await page.evaluate(async () => {
      const { zoomComposite } = await import("/src/features/composite/View.tsx" as string);
      const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const base = developEngine().compositeScale();
      for (let i = 1; i <= 6; i++) {
        zoomComposite(base * 1.25 ** i);
        await frame();
      }
      for (let i = 5; i >= 0; i--) {
        zoomComposite(base * 1.25 ** i);
        await frame();
      }
    });
  }, 900);
  await measure(page, phases, "idle 3 s (nothing should run)", () => page.waitForTimeout(3000), 0);
}

async function run(page: Page, label: string, phone: boolean) {
  const phases: Phase[] = [];
  const only = process.env.BENCH_ONLY;
  await prepare(page);
  if (!only || only === "library") await library(page, phases, phone);
  if (!only || only === "design") await design(page, phases, phone);
  mkdirSync("bench/results", { recursive: true });
  writeFileSync(`bench/results/smooth-${label}.json`, JSON.stringify(phases, null, 2));
  console.log(`\n${label}`);
  console.table(phases);
}

const LABEL = process.env.BENCH_LABEL ?? "run";

test.describe("smooth: computer", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  test("computer", async ({ page }) => run(page, `${LABEL}-computer`, false));
});

test.describe("smooth: phone", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  test("phone", async ({ page }) => run(page, `${LABEL}-phone`, true));
});
