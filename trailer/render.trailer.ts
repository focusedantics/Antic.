import { test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/**
 * Renders the trailer from trailer/shots/ (`npm run trailer:render`): trailer/out/trailer-16x9.mp4
 * and trailer-9x16.mp4, 60 s at 30 fps, silent. TRAILER_MOTION=reduced renders the
 * reduced-motion cut; TRAILER_STILLS="1.5,6,12" writes PNG frames at those times instead
 * (for checking a scene); TRAILER_H264_WASM points at h264-mp4-encoder's web build for an
 * H.264 file where the browser can't encode H.264 itself (see trailer/README.md);
 * TRAILER_QP=28 makes a smaller preview copy (named …-qp28.mp4).
 */

const OUT = "trailer/out";
const motion = process.env.TRAILER_MOTION === "reduced" ? "reduced" : "full";
const stills = process.env.TRAILER_STILLS?.split(",").map(Number);
const cuts = (process.env.TRAILER_CUTS ?? "16x9,9x16").split(",");
const qp = process.env.TRAILER_QP;

for (const cut of cuts) {
  const vertical = cut === "9x16";
  test(`render the ${cut} trailer`, async ({ page }) => {
    test.setTimeout(3_600_000);
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize(vertical ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
    await page.goto(`/trailer/index.html?render&motion=${motion}${vertical ? "&v=vertical" : ""}${qp ? `&qp=${qp}` : ""}`);
    const wasm = process.env.TRAILER_H264_WASM;
    if (wasm && existsSync(wasm)) await page.addScriptTag({ path: wasm });
    await page.evaluate(() => (window as unknown as { trailer: { ready: Promise<unknown> } }).trailer.ready);
    const suffix = `${motion === "reduced" ? "-reduced" : ""}${qp ? `-qp${qp}` : ""}`;
    if (stills) {
      for (const t of stills) {
        // The canvas's own pixels (a screenshot of it can come back black when headless).
        const png = await page.evaluate(async (at) => {
          await (window as unknown as { trailer: { draw(t: number): Promise<void> } }).trailer.draw(at);
          return (document.getElementById("stage") as HTMLCanvasElement).toDataURL("image/png").split(",")[1];
        }, t);
        writeFileSync(`${OUT}/still-${cut}${suffix}-${t.toFixed(2)}.png`, Buffer.from(png, "base64"));
      }
      return;
    }
    const name = `trailer-${cut}${suffix}.mp4`;
    page.on("console", (m) => console.log(m.text()));
    const [download, codec] = await Promise.all([
      page.waitForEvent("download", { timeout: 3_600_000 }),
      page.evaluate(
        (file) =>
          (window as unknown as { trailer: { encode(n: string, p: (d: number) => void): Promise<string> } }).trailer.encode(file, (done) => {
            if (done % 150 === 0) console.log(`  ${file}: ${done / 30} s`);
          }),
        name,
      ),
    ]);
    await download.saveAs(`${OUT}/${name}`);
    console.log(`${OUT}/${name} (${codec})`);
  });
}
