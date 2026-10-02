import { chromium } from "@playwright/test";
const dir = process.argv[2];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => console.log("pageerror", e.message));
p.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 300)); });
await p.addInitScript(() => { localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false })); localStorage.setItem("ai-quality", "offline"); });
await p.goto("http://localhost:5174/");
await p.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
await p.reload();
const b64 = await p.evaluate(async () => {
  const c = new OffscreenCanvas(1200, 800); const g = c.getContext("2d");
  g.fillStyle = "#5f7d57"; g.fillRect(0, 0, 1200, 800);
  for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${90 + (i % 40)}, 30%, ${25 + (i % 30)}%)`; g.fillRect((i * 137) % 1200, (i * 71) % 800, 40, 40); }
  g.fillStyle = "#dc5a28"; g.beginPath(); g.ellipse(600, 450, 150, 260, 0, 0, Math.PI * 2); g.fill();
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
  let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s);
});
const [ch] = await Promise.all([p.waitForEvent("filechooser"), p.getByRole("button", { name: "Import Photos…" }).click()]);
await ch.setFiles({ name: "subject.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
await p.locator(".cell img").first().waitFor({ timeout: 30000 });
await p.locator(".cell").first().click();
await p.keyboard.press("d");
await p.getByRole("slider", { name: "Exposure" }).waitFor();
await p.waitForTimeout(1500);
await p.keyboard.press("m");
const view = await p.locator(".develop-view").boundingBox();
await p.mouse.move(view.x + view.width * 0.35, view.y + view.height * 0.45);
await p.getByRole("button", { name: "Remove BG" }).click();
await p.mouse.move(view.x + view.width * 0.4, view.y + view.height * 0.5, { steps: 5 });
await p.locator(".cutout-fx").waitFor();
await p.waitForTimeout(500);
await p.screenshot({ path: dir + "/cut-scan.png", clip: view });
await p.locator(".cutout-fx[data-phase=reveal]").waitFor({ timeout: 60000 });
const t0 = Date.now();
while (Date.now() - t0 < 2500) {
  const busy = await p.locator(".cutout-fx").count();
  if (!busy) break;
  await p.screenshot({ path: `${dir}/cut-reveal-${Date.now() - t0 < 600 ? "a" : Date.now() - t0 < 1100 ? "b" : "c"}.png`, clip: view });
}
await p.waitForTimeout(800);
await p.screenshot({ path: dir + "/cut-after.png", clip: view });
console.log("fx left:", await p.locator(".cutout-fx").count());
await b.close();
