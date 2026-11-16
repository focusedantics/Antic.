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

### 3. A lighter start

Measured with a production build (`npm run build`, `npx vite preview --port 4173`) and
a probe that lists every request and long task before the first screen is idle, at 4×
CPU throttle. Per-module sizes of a chunk come from its source map.

- **mp4box (176 kB of the 613 kB main script) loaded for everyone.** The chain was
  `App → LooksDialog → video/session → media → demux → mp4box`. `demux()` is already
  async, so the library is now `await import("mp4box")` inside it
  (`core/video/demux.ts`); types stay as `import type`.
- **The render engine (148 kB + the 132 kB effects registry) and a WebGL context were
  created four seconds into every visit** by a one-time thumbnail repair that only then
  read its "already done" flag. The flag is now read first
  (`core/catalog/repair.ts`), and an empty catalog is marked done without the engine.
- Start-up script: **297 kB → 212 kB compressed**; main chunk 613 → 424 kB.

**How to find the next one:** `npx vite build` prints chunk sizes; a chunk that the first
screen cannot need (video, effects, AI) appearing in `dist/index.html`'s
`modulepreload` list is the tell. Follow the static imports back from it.

### 4. The glow rests

The animated backdrop is a second WebGL context drawing 30 times a second for as long as
the page is open. It now holds still while the picture is being edited, panned or zoomed
(`DevelopEngine.working` → `holdMotion()`), so the GPU's frames go to the picture, and
after 20 s without a pointer move or key (`Backdrop.tsx`, `useAway`).

### 5. Smaller things

- `DetailsPanel` rebuilt a JSON signature of every text layer on *every* store change
  (each pan, zoom and selection). It is now cached per layer list in a `WeakMap`: the
  same structural-sharing idea, on the React side.
- Pressing on the canvas blurs a focused panel field, so arrow keys nudge the layer
  instead of moving a caret nobody is looking at (found by the benchmark: "nudge" did
  no renders at all).
- The Design home read every saved design's whole record to show thumbnails. Tiles now
  read their own (`features/design/thumbs.ts`), cached by design and save time.

## The Storage tab

Asked for: "see all the categories and how much storage they are taking up".

- **Browsers will not tell you.** `navigator.storage.estimate()` gives one number;
  Chromium's `usageDetails` splits it by API (IndexedDB, caches), not by what the app
  means (previews, masks), and Safari has no breakdown at all. So the app counts its own
  stores (`core/catalog/usage.ts`).
- **Counting must not load what it counts.** Blobs in IndexedDB come back as handles:
  `.size` reads nothing. But a record that holds raw bytes comes back whole. Hence:
  originals are sized by the photo's recorded file size (keys only), and mask rasters,
  the one store that has to be read, go one record at a time with a pause between.
- **A leftover is only a leftover if nothing is about to claim it.** An import writes the
  file before its database record, so a file is called leftover only when no key names
  it *and* it is ten minutes old, and cleaning is disabled while an import runs.
- It is a workspace tab (`Workspace` gained `"storage"`): TypeScript then pointed at
  every `Record<Workspace, …>` that needed an entry. It renders through `Shell`, so the
  phone layout (dock, sheet) came for free.
- Tests: `tests/usage.test.ts` runs the count against `fake-indexeddb`;
  `e2e/storage.spec.ts` checks the page, removing models, leftovers and the phone.

## The Design home

Asked for: "it sucks that I have to scroll all the way down to get to my own work".
The page was sizes → every template → your designs. Now: your designs first (a shelf of
the twelve newest, the latest larger and marked Continue; "All designs" opens the grid
with folders), then sizes, then templates; the search covers designs too; with no
designs yet the section is absent and the page starts with sizes.

- Thumbnails are a fixed square with the image absolutely placed inside: an `<img>` with
  `max-height: 100%` in an auto-height box let a tall story stretch its tile.
- `e2e/design-home.spec.ts` checks the order by position on screen, not by DOM order.

## What did not work, and why

- **`content-visibility: auto` on template cards.** Expected: smoother gallery
  scrolling. Measured (three runs each way): identical. The slow first scroll is the
  browser fetching and decoding preview images for the first time; later scrolls were
  already at 33 ms a frame. Not kept. *Lesson: a janky first run and a smooth second run
  means loading, not layout.*
- **Splitting effect definitions from their shaders** so the sanitizer (which needs each
  effect's parameter list at start-up) would not pull in 132 kB of GLSL. It would touch
  all 13 effect libraries for 37 kB compressed, most of it strings that cost almost
  nothing to parse. Not done; worth it only if start-up becomes the complaint again.
- **Caching a dragged layer's styled result and just moving it** (Penpot's backbuffer
  crop, Excalidraw's per-element canvas). After checkpoints and drafts a drag frame was
  already ~10× cheaper, the effect layer on top of the poster has to rerun anyway, and
  sub-pixel moves would blur the cached copy. Not done.
- **Timing a frame by the next `requestAnimationFrame`.** GPU work that is still queued
  does not reliably delay the next frame callback, so slow designs looked fast. A
  `fenceSync` polled on later frames measures the GPU itself.
- **A sharp frame 220 ms after the last edit.** See the draft section: when the draft
  frame itself took longer than that, it fired mid-drag.
