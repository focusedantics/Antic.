// Times every GPU pass of one composite of a template (each waited for with a 1 px read-back).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const template = process.argv[2] ?? "Club night";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
await page.goto("http://localhost:5174/");
await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
await page.getByRole("searchbox").first().fill(template.toLowerCase());
await page.locator(".template-card", { hasText: template }).first().click();
await page.getByRole("toolbar", { name: "Design tools" }).waitFor();
await page.waitForTimeout(4000);
const out = await page.evaluate(async () => {
  const { developEngine } = await import("/src/core/gpu/develop-engine.ts");
  const { composite } = await import("/src/core/document/session.ts");
  const engine = developEngine();
  const gpu = engine.gpu, gl = gpu.gl;
  const times = new Map();
  const pass = gpu.pass.bind(gpu);
  let last = performance.now();
  const sync = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); };
  gpu.pass = (key, frag, opts) => {
    sync(); const t = performance.now();
    const r = pass(key, frag, opts);
    if (opts.target) { gl.bindFramebuffer(gl.FRAMEBUFFER, opts.target.framebuffer); gl.readPixels(0, 0, 1, 1, gl.RGBA, opts.target.format === "rgba8" ? gl.UNSIGNED_BYTE : gl.FLOAT, opts.target.format === "rgba8" ? new Uint8Array(4) : new Float32Array(4)); }
    const dt = performance.now() - t;
    const e = times.get(key) ?? { n: 0, ms: 0, px: 0 };
    e.n++; e.ms += dt; e.px += opts.target ? opts.target.width * opts.target.height : 0;
    times.set(key, e);
    return r;
  };
  const doc = composite.getState().doc;
  const scale = engine.compositeScale();
  const t0 = performance.now();
  const target = engine.compositor.render({ ...doc }, scale, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
  const total = performance.now() - t0;
  gpu.pass = pass;
  return { scale, size: [target.width, target.height], total: Math.round(total), passes: [...times].map(([k, v]) => ({ key: k, n: v.n, ms: Math.round(v.ms), mpx: Math.round(v.px / 1e4) / 100 })).sort((a, b) => b.ms - a.ms) };
});
console.log(template, JSON.stringify({ scale: out.scale, size: out.size, totalMs: out.total }));
console.table(out.passes.slice(0, 18));
await browser.close();
