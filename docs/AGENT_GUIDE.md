# Field guide for agents working on Focused

What was done to make the app fast, how it was found, why it worked, and what did not
work. Read this before a performance task; add to it when you finish one. `CLAUDE.md`
has the rules, `docs/ARCHITECTURE.md` says where things live, `docs/PERFORMANCE.md` has
the older measurements. This file is the story and the method.

## The method (use it again)

1. **Measure a person's actions, not functions.** `bench/smooth.bench.ts` drives the real
   app (import, scroll, develop, open a design, type, drag, nudge, zoom, idle) on a
   computer and a phone viewport and records, per action: time, frames, the worst frame,
   long tasks, React commits, composites and megapixels composited.

   ```sh
   npx vite --port 5174 --strictPort &
   BENCH_LABEL=mine CHROMIUM_PATH=/opt/pw-browsers/chromium \
     npx playwright test -c bench/playwright.config.ts smooth.bench.ts -g computer --reporter=line
   # BENCH_ONLY=design|library runs half of it; -g phone for the phone layout
   ```

   Results land in `bench/results/smooth-<label>-<device>.json` (not committed).
2. **Find where the time goes before changing anything.** The benchmark said "a drag
   takes 2.2 s a frame"; a pass-by-pass timing of one frame said which GPU passes. Every
   fix below came from a number, and two ideas that sounded right were dropped because
   the numbers said they would save nothing (see "What did not work").
3. **One change, one measurement.** Re-run the same phase with a new label and compare.
4. **Prove it draws the same.** A cache that draws the wrong thing is worse than no
   cache. `e2e/checkpoint.spec.ts` compares cached renders with full ones, pixel for pixel.

### Traps in this environment

- The test browser has no GPU (SwiftShader, a software renderer). Absolute times are many
  times a real device's. Compare *before and after on the same machine*, and count work
  removed (passes, megapixels), not milliseconds.
- GPU calls return before the GPU has done the work. To time a render, read one pixel
  back afterwards (`gl.readPixels` of 1 × 1) — only in a probe, never in the app (it
  stalls the pipeline). In the app use a fence (`gl.fenceSync`) and look at it on later
  frames, as `DevelopEngine.timeEdit` does.
- After editing a source file with the dev server running, a probe's
  `import("/src/…")` can get a *second copy* of the module (Vite gives changed modules a
  new URL), whose stores are empty. A probe that suddenly sees "nothing happens" is
  seeing that. Restart the dev server before measuring.
- `page.evaluate(() => import("/src/core/gpu/develop-engine.ts"))` gives a probe the
  live engine: wrap `engine.compositor.render` or `engine.gpu.pass` to count and time.

## Where the time went (November 2026 baseline)

Computer viewport 1440 × 900 at 2×, software GPU. "Club night" is a stylized poster with
a CMYK halftone under the type and a prism effect over everything.

| Action | Before | What it was doing |
| --- | --- | --- |
| Type 8 characters into a poster's detail | 17.7 s | 8 full redraws, 2.2 s each |
| Drag a layer on that poster (12 steps) | 25.9 s | 12 full redraws |
| Nudge with arrow keys (phone, 10) | 24.6 s | 10 full redraws |
| The same on a plain carousel | 57 ms a redraw | nothing wrong |

One redraw of the poster, by pass: halftone 843 ms, 19 layer placements 555 ms, blends
392 ms, outline 242 ms, prism 216 ms. Every edit redid all of it, though moving one line
of type changes nothing below it.

## What other editors do (and what was taken from each)

Read from their source on GitHub; file names so you can find them again.

| Project | File | Idea | Used here as |
| --- | --- | --- | --- |
| darktable | `src/develop/pixelpipe_cache.c` | Cache keyed by a hash of every setting up to a point in the pipeline; the input of the module being edited is pinned so edits resume there | The compositor checkpoint |
| Excalidraw | `packages/element/src/renderElement.ts` | `WeakMap<element, canvas>`: an immutable element object *is* the cache key | Layer identity as the checkpoint's validity test |
| Penpot | `render-wasm/src/render.rs` | `fast_mode` while interacting (skip the expensive, redo sharp after) | Draft frames during a run of edits |
| tldraw | `packages/editor/src/lib/editor/derivations/notVisibleShapes.ts` | Cull what is off screen, incrementally | Already there (`Compositor.reach`, `compositeWindow`) |

## What was done

### 1. Checkpoints: redraw from the edited layer up, not from the bottom

`src/core/gpu/compositor.ts` (`resume`, `checkpointIndex`, `depsOf`), wired in
`DevelopEngine.compositeFrame`.

- A checkpoint is a copy of the canvas as it stood just below layer *n*. The next frame
  copies it and draws layers *n…top* only.
- *n* is the top-level layer the selection is in, lowered to the first layer that
  differs from the previous frame's (an undo, a field whose copies sit lower).
- It is valid while the layers below are **the same objects** as when it was taken, and
  the things those layers draw from outside the document have not changed: photos'
  develop recipes, fonts loaded, brush tips loaded (`depsOf`).
- It never sits above an animated layer (stale next frame) or between a layer and the
  layers clipped to it.
- Selecting a layer warms the checkpoint 120 ms later (`scheduleWarm`), so the first
  step of a drag is as quick as the rest.
- Exports and thumbnails do not use it (`render` without `live`).

**Why it worked:** documents are immutable, so "same object" is a free, exact test of
"same content". **What it needed first:** edits that really leave untouched layers
untouched. Two places rebuilt every group on every edit (`mapTree` in
`core/document/operations.ts`, `fillDetail` in `features/design/details.ts`): the
document was equal but not identical, and the checkpoint was thrown away each frame. The
first benchmark run after writing the checkpoint showed *no* gain for typing; printing
which layers kept their identity (`'X===========X==='`) showed the group at index 0
being rebuilt. `tests/document.test.ts` ("structural sharing") now holds that line.

> If you write a function that maps over layers, use `mapTree` (it returns the same
> array, group and layer when nothing in them changed). `layers.map(l => ({ ...l }))`
> silently turns every later frame into a full redraw.

### 2. Draft frames while a heavy design is being edited

`DevelopEngine.edited`, `timeEdit`, `editRested`.

- A fence after each edit's render tells how long the GPU really took. Two late frames
  (> 42 ms) in a row mark the design heavy; from then, frames during a run of edits are
  drawn at half the size (a quarter of the pixels) with content rasters kept at full
  detail, and a sharp frame follows 220 ms after the run rests.
- Fast devices never see a draft: a sharp frame on time clears the mark.
- The draft's checkpoint is the sharp one resampled (one blit), not drawn again.

**A mistake on the way:** the rest timer first counted from the last *edit*. A draft
frame that took longer than the timer was followed at once by a sharp one, mid-drag:
draft, sharp, draft, sharp, slower than before. Rest is now counted from the last draft
frame shown as well.

### Result of 1 + 2

| Action | Before | After |
| --- | --- | --- |
| Type 8 characters (computer) | 17.7 s | 5.5 s (2.3 s of it the first frame, which takes the checkpoint) |
| Drag a layer, 12 steps (computer) | 25.9 s | 4.9 s |
| Drag a layer (phone) | 30.5 s | 6.5 s |
| Nudge ×10 (phone) | 24.6 s | 3.8 s |

One frame of the drag: 2.2 s → about 0.2 s.
