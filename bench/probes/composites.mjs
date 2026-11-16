// Per-composite pass breakdown while typing a detail and dragging a layer.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const template = process.argv[2] ?? "Club night";
const fieldName = process.argv[3] ?? "Date";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("[page]", m.text().slice(0, 200)); });
await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ backdrop: false, tourDone: true })));
await page.goto("http://localhost:5174/");
await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
await page.getByRole("searchbox").first().fill(template.toLowerCase());
await page.locator(".template-card", { hasText: template }).first().click();
await page.getByRole("toolbar", { name: "Design tools" }).waitFor();
await page.waitForTimeout(4000);
await page.evaluate(async () => {
  const { developEngine } = await import("/src/core/gpu/develop-engine.ts");
  const engine = developEngine();
  const gpu = engine.gpu, gl = gpu.gl;
  const log = (window.__log = []);
  let cur = null;
  const pass = gpu.pass.bind(gpu);
  gpu.pass = (key, frag, opts) => {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const t = performance.now();
    const r = pass(key, frag, opts);
    if (opts.target) { gl.bindFramebuffer(gl.FRAMEBUFFER, opts.target.framebuffer); gl.readPixels(0, 0, 1, 1, gl.RGBA, opts.target.format === "rgba8" ? gl.UNSIGNED_BYTE : gl.FLOAT, opts.target.format === "rgba8" ? new Uint8Array(4) : new Float32Array(4)); }
    if (cur) { const e = (cur.p[key] ??= [0, 0]); e[0]++; e[1] += performance.now() - t; }
    return r;
  };
  for (const name of ["render", "warm"]) {
    const fn = engine.compositor[name].bind(engine.compositor);
    engine.compositor[name] = (...a) => {
      cur = { name, at: Math.round(performance.now()), scale: a[1], live: JSON.stringify(a[4] ?? null), p: {} };
      const t = performance.now();
      const r = fn(...a);
      cur.ms = Math.round(performance.now() - t);
      cur.size = r ? r.width + "x" + r.height : "";
      log.push(cur); cur = null;
      return r;
    };
  }
});
const dump = async (label) => {
  const log = await page.evaluate(() => { const l = window.__log.slice(); window.__log.length = 0; return l; });
  console.log("\n== " + label);
  for (const c of log) console.log(`${c.name} @${c.at} ${c.ms}ms ${c.size} live=${c.live}  ` + Object.entries(c.p).sort((a, b) => b[1][1] - a[1][1]).slice(0, 7).map(([k, [n, ms]]) => `${k}×${n}:${Math.round(ms)}`).join(" "));
};
const field = page.getByRole("textbox", { name: fieldName, exact: true });
await field.focus();
await page.keyboard.press("End");
for (const key of ["Backspace", "Backspace", "J", "A"]) { await page.keyboard.press(key); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); }
await page.waitForTimeout(1500);
await dump("typing");
await browser.close();
