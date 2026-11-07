import { test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Opens each template that has a rendered preview the way the app does (fonts loaded, text
 * boxes fitted), renders it with the real compositor (effects included) and saves
 * public/templates/<id>.webp, plus the fingerprints in template-previews.json.
 * `PREVIEW_ONLY=id1,id2` renders some; `PREVIEW_PNG=dir` also writes large PNGs to look at.
 */
const LONG = 720;

test("render template previews", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false })));
  await page.goto("/");
  const only = process.env.PREVIEW_ONLY?.split(",").filter(Boolean) ?? [];
  const png = process.env.PREVIEW_PNG;
  const ids: string[] = await page.evaluate(async () => {
    const { TEMPLATES } = await import("/src/features/design/templates.ts" as string);
    return TEMPLATES.filter((t: { preview?: boolean }) => t.preview).map((t: { id: string }) => t.id);
  });
  mkdirSync("public/templates", { recursive: true });
  if (png) mkdirSync(png, { recursive: true });
  const HASHES = "src/features/design/template-previews.json";
  const before: Record<string, string> = existsSync(HASHES) ? JSON.parse(readFileSync(HASHES, "utf8")) : {};
  // Only previews that still exist and were rendered (now or before) keep a fingerprint.
  const hashes: Record<string, string> = Object.fromEntries(Object.entries(before).filter(([id]) => ids.includes(id) && only.length && !only.includes(id)));
  for (const id of ids) {
    if (only.length && !only.includes(id)) continue;
    const out = await page.evaluate(
      async ([templateId, long, big]) => {
        const { TEMPLATES } = await import("/src/features/design/templates.ts" as string);
        const { templateDocument } = await import("/src/features/design/actions.ts" as string);
        const { templateHash } = await import("/src/features/design/template-hash.ts" as string);
        const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
        const t = TEMPLATES.find((x: { id: string }) => x.id === templateId);
        const doc = await templateDocument(t);
        await document.fonts.ready;
        const encode = async (size: number, type: string, quality: number) => {
          const image = developEngine().renderDocument(doc, size / Math.max(doc.width, doc.height)) as ImageData;
          const canvas = new OffscreenCanvas(image.width, image.height);
          canvas.getContext("2d")!.putImageData(image, 0, 0);
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer());
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        };
        return { hash: templateHash(t) as string, webp: await encode(long, "image/webp", 0.86), png: big ? await encode(1600, "image/png", 1) : null };
      },
      [id, LONG, !!png] as const,
    );
    hashes[id] = out.hash;
    writeFileSync(`public/templates/${id}.webp`, Buffer.from(out.webp, "base64"));
    if (png && out.png) writeFileSync(`${png}/${id}.png`, Buffer.from(out.png, "base64"));
    console.log(`${id}: ${Math.round(Buffer.from(out.webp, "base64").length / 1024)} kB`);
  }
  writeFileSync(HASHES, `${JSON.stringify(Object.fromEntries(Object.entries(hashes).sort()), null, 2)}\n`);
});
