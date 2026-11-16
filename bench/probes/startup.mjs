// Startup probe against a production build (vite preview): what loads before the app is idle.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:4173/";
const phone = process.argv[3] === "phone";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true }));
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
});
const client = await ctx.newCDPSession(page);
await client.send("Network.enable");
await client.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU ?? 4) });
const reqs = new Map();
client.on("Network.responseReceived", (e) => reqs.set(e.requestId, { url: e.response.url, type: e.type }));
client.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
const t0 = Date.now();
await page.goto(url, { waitUntil: "load" });
await page.getByRole("button", { name: /Import/ }).first().waitFor();
const shell = Date.now() - t0;
await page.waitForTimeout(6000);
const perf = await page.evaluate(() => ({ long: window.__long, fcp: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0), nodes: document.querySelectorAll("*").length }));
const rows = [...reqs.values()].filter((r) => r.bytes);
const by = (f) => rows.filter(f).reduce((a, r) => a + r.bytes, 0);
const name = (u) => u.split("/").pop().split("?")[0];
console.log(JSON.stringify({ phone, shellMs: shell, fcpMs: perf.fcp, longTasks: perf.long, longTotal: perf.long.reduce((a, b) => a + b, 0), domNodes: perf.nodes,
  jsKB: Math.round(by((r) => /\.m?js$/.test(name(r.url))) / 1024), cssKB: Math.round(by((r) => /\.css$/.test(name(r.url))) / 1024), fontKB: Math.round(by((r) => /\.woff2?$/.test(name(r.url))) / 1024), otherKB: Math.round(by((r) => !/\.(m?js|css|woff2?)$/.test(name(r.url))) / 1024), requests: rows.length }, null, 1));
console.log(rows.sort((a, b) => b.bytes - a.bytes).slice(0, 22).map((r) => `${String(Math.round(r.bytes / 1024)).padStart(6)} kB  ${name(r.url)}`).join("\n"));
await browser.close();
