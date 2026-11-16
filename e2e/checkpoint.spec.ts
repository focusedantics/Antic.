import { expect, test } from "@playwright/test";

/**
 * While a design is edited the compositor goes on from a checkpoint: a picture of the
 * layers below the one being edited, kept from the frame before. Whatever is edited, and
 * wherever, that must draw exactly what drawing every layer again draws.
 */
test("a render resumed from a checkpoint is the full render", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false })));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Design/ }).click();
  await page.getByRole("searchbox").first().fill("club night");
  await page.locator(".template-card", { hasText: "Club night" }).first().click();
  await page.getByRole("toolbar", { name: "Design tools" }).waitFor();
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.waitForTimeout(1500);

  const out = await page.evaluate(async () => {
    const { developEngine } = await import("/src/core/gpu/develop-engine.ts" as string);
    const { composite } = await import("/src/core/document/session.ts" as string);
    const ops = await import("/src/core/document/operations.ts" as string);
    const engine = developEngine();
    const compositor = engine.compositor;
    const gl: WebGL2RenderingContext = engine.gpu.gl;
    const scale = 0.3;
    const read = (target: any) => {
      const px = new Float32Array(target.width * target.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      engine.pipelineRef.release(target);
      return px;
    };
    const diff = (a: Float32Array, b: Float32Array) => {
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        sum += d;
        if (d > worst) worst = d;
      }
      return { worst, mean: sum / a.length };
    };
    let passes = 0;
    const pass = engine.gpu.pass.bind(engine.gpu);
    engine.gpu.pass = (...args: unknown[]) => (passes++, pass(...args));
    const counted = (fn: () => any) => {
      passes = 0;
      const target = fn();
      return { px: read(target), passes };
    };

    let doc = composite.getState().doc;
    const top = (name: string) => doc.layers.findIndex((l: any) => l.name === name || l.field === name);
    const steps: [string, () => { focus: number | undefined }][] = [
      ["first frame with the subtitle selected", () => ({ focus: top("Subtitle") })],
      ["move the subtitle", () => ((doc = ops.updateLayer(doc, doc.layers[top("Subtitle")].id, (l: any) => ({ ...l, transform: { ...l.transform, x: l.transform.x + 40, y: l.transform.y + 25 } }))), { focus: top("Subtitle") })],
      ["move it again", () => ((doc = ops.updateLayer(doc, doc.layers[top("Subtitle")].id, (l: any) => ({ ...l, transform: { ...l.transform, x: l.transform.x - 15 } }))), { focus: top("Subtitle") })],
      ["a layer above it changes", () => ((doc = ops.updateLayer(doc, doc.layers[top("Date")].id, (l: any) => ({ ...l, style: { ...l.style, text: "FRI 9 JAN" } }))), { focus: top("Subtitle") })],
      ["a layer below it changes (nothing says so but the layers)", () => ((doc = ops.updateLayer(doc, doc.layers[2].id, (l: any) => ({ ...l, opacity: 0.4 }))), { focus: top("Subtitle") })],
      ["inside the group at the bottom", () => {
        const burst = doc.layers[0].children[1];
        doc = ops.updateLayer(doc, burst.id, (l: any) => ({ ...l, transform: { ...l.transform, rotation: 30 } }));
        return { focus: top("Subtitle") };
      }],
      ["nothing selected", () => ((doc = ops.updateLayer(doc, doc.layers[top("Time")].id, (l: any) => ({ ...l, opacity: 0.5 }))), { focus: undefined })],
      ["a layer is hidden below", () => ((doc = ops.updateLayer(doc, doc.layers[4].id, (l: any) => ({ ...l, visible: false }))), { focus: top("Time") })],
      ["a layer is removed below", () => ((doc = ops.removeLayers(doc, [doc.layers[3].id])), { focus: top("Time") })],
      ["sent to the back", () => ((doc = ops.arrangeLayers(doc, [doc.layers[top("Sticker")].id], "back")), { focus: 0 })],
      ["the background changes", () => ((doc = { ...doc, background: "#102030" }), { focus: top("Time") })],
      ["the effect on top changes", () => ((doc = ops.updateLayer(doc, doc.layers[doc.layers.length - 1].id, (l: any) => ({ ...l, opacity: 0.6 }))), { focus: doc.layers.length - 1 })],
    ];
    const results: { step: string; worst: number; livePasses: number; fullPasses: number }[] = [];
    for (const [step, edit] of steps) {
      const { focus } = edit();
      const live = counted(() => compositor.render(doc, scale, 0, undefined, { focus }));
      const full = counted(() => compositor.render(doc, scale, 0));
      results.push({ step, worst: diff(live.px, full.px).worst, livePasses: live.passes, fullPasses: full.passes });
    }
    // A draft (half the size, content at full detail) starts from the sharp checkpoint
    // resampled; it must be the same picture as a draft drawn from nothing, within what
    // resampling a halftone does.
    const focus = top("Time");
    read(compositor.render(doc, scale, 0, undefined, { focus }));
    const draft = counted(() => compositor.render(doc, scale / 2, 0, undefined, { focus, detail: 2 }));
    compositor.dispose();
    const fresh = counted(() => compositor.render(doc, scale / 2, 0, undefined, { detail: 2 }));
    engine.gpu.pass = pass;
    return { results, draft: { ...diff(draft.px, fresh.px), passes: draft.passes, fresh: fresh.passes } };
  });

  if (process.env.DEBUG_CHECKPOINT) console.log(out);
  for (const r of out.results) expect(r.worst, r.step).toBeLessThan(1e-4);
  // Moving the selected layer again draws only it and what is above: far fewer passes.
  const again = out.results.find((r) => r.step === "move it again")!;
  expect(again.livePasses).toBeLessThan(again.fullPasses * 0.7);
  expect(out.draft.mean).toBeLessThan(0.03);
  expect(out.draft.passes).toBeLessThan(out.draft.fresh * 0.7);
});
