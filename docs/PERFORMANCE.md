# Performance and memory

This file is the record of the memory work on Focused. It notes the state before
each change, what is changed, and what the measurements show, so any step can be
understood and reverted on its own.

## Why memory matters most

iOS gives a Safari tab (every browser on iPhone is Safari underneath: Arc, Chrome,
Firefox) a fixed amount of memory. Over it, the tab is killed without warning and
reloaded: the page "just reloads", or shows a blank or grey screen. No JavaScript
error or `webglcontextlost` event comes first. On iPhone the GPU shares the phone's
memory, so textures count against the same limit as JavaScript and decoded images.
WebKit's guidance and field reports put a safe WebGL page at a few hundred MB.

The aim is therefore **low peak memory**, not only low average memory: one spike
(a full-size decode, a model's activations) is enough to lose the page.

## Measuring

`npm run bench` (`bench/memory.bench.ts`) drives an iPhone-sized session (390 × 664,
3× screen, iPhone user agent, so the `lite` device profile) through:

1. importing four 24 MP JPEGs (6000 × 4000);
2. opening the first in Develop;
3. swiping three photos on (with neighbour preloading);
4. Select Subject (bundled model) and a brush mask with an exposure change;
5. 100 % zoom, panning across the photo;
6. going back to the Library.

Every 100 ms it reads the proportional set size (PSS) of Chromium's renderer and GPU
processes. Its software GPU (SwiftShader) keeps textures in ordinary memory, so,
as on an iPhone, the GPU's memory is counted too. Each phase reports its peak and
the settled value 1.5 s later, with the engine's own count of live GPU texture
memory (`DevelopEngine.stats()`, from `Gpu.textureBytes`). `BENCH_LABEL=name` names
the result file in `bench/results/`.

## Baseline (commit `d3eb0fc`, before any change below)

| Phase | Peak MB | Settled MB | GPU textures MB | CPU copies of photos MB |
| --- | --- | --- | --- | --- |
| start | 216 | 216 | 0 | 0 |
| import 4 × 24 MP | 1228 | 883 | 0 | 0 |
| open in Develop | 1412 | 1297 | 119 | 92 |
| swipe × 3 | 1785 | 1526 | 286 | 183 |
| Select Subject + brush | 1951 | 1723 | 313 | 183 |
| zoom 100 % and pan | **2529** | 1934 | 542 | 183 |
| back to Library | 1934 | 1596 | 315 | 183 |

A peak of 2.5 GB, and 1.6 GB after returning to the Library with nothing open, is
far over what an iPhone tab can hold.

## State of each subsystem at the baseline

**Photo sources (`core/develop/source-loader.ts`, `core/gpu/develop-engine.ts`,
`core/gpu/pipeline.ts`)**
- JPEG/HEIC/PNG decode at full size with `createImageBitmap` (a 48 MP iPhone photo
  is a 190 MB bitmap). The bitmap is then drawn into a second, smaller canvas when
  the photo is over `device.maxSide` (4096 on phones).
- The decoded data is kept in `DevelopEngine.sources[...].data` for as long as the
  photo stays loaded (meant for WebGL context-loss recovery). Bitmaps are never
  closed; RAW keeps its 16-bit array. This is the "CPU copies" column.
- On the GPU every source is linear Rec.2020 **RGBA16F with mipmaps**: 8 bytes per
  pixel × 4/3 (135 MB for 4096 × 3072), uploaded through a staging texture.
- RAW decodes at full size on every device (a 48 MP ProRAW is about 400 MB inside
  LibRaw).
- The engine keeps the open photo, its warm neighbours (one on phones), the
  composition's photos, and otherwise the last two used; no byte budget.
- Spot-removal results: a second full RGBA16F copy per photo, up to four kept.
- Context loss: rebuilt from the kept CPU copies.

**View rendering** — the view renders the whole cropped photo at the display scale.
At 100 % zoom that is the full working resolution (4096 px) for every pass, the
before image and the mask overlay, however little of it is on screen.

**Masks (`core/gpu/masks.ts`)** — a brush component keeps two R16F rasters of up to
4096 px (50 MB) for as long as the page lives, for every component ever drawn
(other photos' too). AI rasters stay on the GPU once loaded.

**AI (`core/ai`)** — one worker, created on first use and never ended. Every model
used stays loaded (BiRefNet or MODNet, DETR panoptic, SlimSAM), with its ONNX
Runtime session, its WebGPU buffers or WASM heap (a WASM heap only grows). Select
Sky / People runs DETR-ResNet-50 panoptic in fp32 at 800 × 1333 input; its mask head
runs once per query (100 queries) at a quarter of the input resolution, a very
large transient memory need.

**Library (`app/thumbs.ts`, `core/image`)** — up to 800 object URLs, thumbnails and
2560 px previews mixed in one LRU. Import decodes each photo at full size in a
worker (two workers on phones), then draws the preview and then the thumbnail from
the full-size image; metadata is read from the whole file in memory.

**Storage (`core/catalog/db.ts`)** — on iPhone originals and (when Safari refuses a
Blob) video files are stored as `ArrayBuffer` bytes; reading one loads it whole into
memory (up to 600 MB for a video).

**Composite (`core/gpu/compositor.ts`)** — each image layer's developed content is
cached as an RGBA16F mipmapped texture up to 4096 px; its cache key serialises the
whole recipe (`JSON.stringify`) on every frame.

## Plan

Ordered by expected effect. Each item is a separate commit with a measurement.

1. **Free decoded pixels after upload.** Close bitmaps, drop RAW arrays. After a lost
   context, sources are decoded again from the originals.
2. **Decode at the working size.** `createImageBitmap` with `resizeWidth/Height`
   (Safari 15+) to the size the GPU keeps, checked against the expected
   orientation; phones decode RAW at half size when that still covers the working
   size.
3. **8-bit photos stay 8-bit on the GPU.** JPEG/HEIC/PNG sources become mipmapped
   `SRGB8_ALPHA8` textures (4 bytes per pixel, no staging copy); the geometry pass
   converts to linear Rec.2020 when it samples. A start-up self-test of sRGB
   mipmapping falls back to RGBA16F where a driver gets it wrong. Spot-removal
   copies keep the source's format.
4. **Byte budgets instead of counts** for sources, spot-removal copies, brush
   rasters and AI rasters; least recently used first; phones get smaller budgets.
5. **Render only what is on screen when zoomed in**, with a margin for blurs; the
   histogram and the dehaze estimate come from a small render of the whole photo.
6. **AI memory**: on phones one model at a time, and the worker is ended after a
   short idle time (the only way to give back a WASM heap and its GPU buffers).
   Sky/People run DETR at a reduced input size on phones.
7. **Library**: previews get their own small LRU; import decodes at preview size
   and makes the thumbnail from the preview; metadata from the head of the file.
8. **Composite** image layers cached as 8-bit (they are already display-encoded),
   keyed by recipe identity instead of serialising it every frame.
9. **Memory pressure**: on phones, a hidden page frees neighbours and caches too.

Reverting: every item is a separate commit on `claude/sleepy-bardeen-lyzaon`;
`git revert <commit>` undoes one, `git checkout d3eb0fc -- src` restores all of the
source as it was at the baseline.

## Results

The same benchmark (with the export and idle phases added during the work) run three
times on the baseline code (`918262d`: `d3eb0fc` plus the instrumentation) and three
times on the result; medians.

| Phase | Peak MB before | Peak MB after | Settled MB before | Settled MB after | GPU textures MB before | after | Time s before | after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| start | 205 | 204 | 205 | 204 | 0 | 0 | 0.0 | 0.0 |
| import 4 × 24 MP | 1219 | 886 | 868 | 622 | 0 | 0 | 7.4 | 6.8 |
| open in Develop | 1430 | 898 | 1322 | 705 | 119 | 62 | 1.2 | 1.8 |
| swipe × 3 | 1776 | 905 | 1540 | 588 | 286 | 123 | 14.3 | 13.9 |
| Select Subject + brush | 2113 | 1016 | 1707 | 797 | 313 | 136 | 6.5 | 5.7 |
| zoom 100 % and pan | 2538 | 933 | 1744 | 862 | 542 | 147 | 13.1 | 4.5 |
| export full size JPEG | 1993 | 1053 | 1543 | 932 | 279 | 76 | 6.0 | 6.7 |
| back to Library | 1549 | 932 | 1547 | 651 | 279 | 73 | 0.5 | 0.5 |
| idle 20 s | 1547 | 651 | 1382 | 512 | 279 | 73 | 20.0 | 20.0 |

The highest point of a whole session went from about 2.5 GB to about 1.05 GB (each run:
2538 / 2496 / 2550 → 1053 / 1042 / 1067 MB), and what stays in use after it from
1.4 GB to 0.5 GB. About 200 MB of every figure is the browser itself (the "start" row).

## What changed, step by step

Measured with the benchmark after each step (single runs, so ±10 % noise).

| Step | Commit message | Effect |
| --- | --- | --- |
| 1–2 | Free decoded photos after upload and decode at the size they are used | The CPU copies (183 MB) are gone; the browser decodes at 4096 px (Develop) or about 2560 px (import); import reads only the file's head; idle image workers end. Peak 2529 → about 1700 MB. |
| 3 | Keep 8-bit photos as 8-bit sRGB textures on the GPU | GPU textures after the swipes 286 → 172 MB. Renders match the float path to 1/255 at full size. |
| 4 | AI: one model at a time on phones, lighter Sky/People, end the worker when idle | The renderer drops from 552 to 213 MB once the worker ends. Sky/People: DETR's mask head at a sixth of the input pixels, 8-bit, on the CPU. |
| 5 | Zoomed in, render only the part of the photo on screen | Zoom phase peak 1771 → 1170 MB, GPU 428 → 243 MB, 12.9 → 7.2 s. |
| 6 | Budget mask rasters; phones keep only what is in use | GPU at 100 % 243 → 154 MB; back in the Library 221 → 73 MB. |
| 7 | Read back through a corner of the canvas (reverted in 8) | Measured slower in Chromium (a copy out of a canvas costs the whole canvas): reverted; the immediate repaint stayed. |
| 8 | Memoize derived recipes; separate preview cache; lighter composite layers | Found while checking 7: `recipeFor` built a new recipe on every call for photos not open in Develop; the animated-export test went 2.0 → 1.2 min once memoized. |
| 9 | iPhone: keep originals and clips in the private file system | Originals and clips read from disk on demand instead of whole into memory (no change in this benchmark: its files are 10 MB). |
| 10 | Export photos in tiles, with one full-size copy on the CPU | Export peak 1302 → 1058 MB at the same speed; narrower margins when no local contrast make panning at 100 % 8.0 → 4.6 s. |
| 11 | Video sound: transfer decoded audio, budget rendered segments by bytes | One copy fewer of a clip's sound; the segment cache is bounded by size, not count. |
| 12 | AI on phones: smaller Sky/People input, free caches before a selection | DETR at 320 px; the neighbour and idle targets make room before inference. |
| 13 | Library: sort by precomputed ranks | 20,000 photos: by name 80 → 13 ms, camera 160 → 17 ms, rating 59 → 12 ms per catalog change. Same order (tested). |
| 14 | Library: run the query on a deferred copy of the catalog | Imports no longer re-run the query for every analysed photo while React is busy. |

## Alternatives considered

- **`gl.readPixels` instead of the canvas read-back**: faster in principle, but the
  project moved away from it because some browser/GPU combinations return wrong pixels
  (see ARCHITECTURE.md). Kept as is; reading through a canvas corner was tried and
  measured slower (step 7).
- **R11F_G11F_B10F for RAW sources** (4 bytes per pixel instead of 8): too little
  precision for heavy edits (6-bit mantissa); RAW stays RGBA16F.
- **A lighter semantic model for Sky/People** (SegFormer, MobileViT-DeepLab, UperNet):
  SegFormer's and MobileViT's weights are not under an MIT/Apache/BSD-compatible license;
  UperNet could not be downloaded and checked here. DETR stays, made lighter on phones.
- **Rendering the zoomed view in fixed tiles with a tile cache**: the window approach
  gives most of the saving with one render per pan step and no new cache; tiles are
  used for exports only.

## Not verified here

- The test machine has no iPhone: the numbers are Chromium's, with SwiftShader keeping
  GPU memory in ordinary memory as an iPhone does. WebKit's own costs differ, but every
  change reduces what is allocated, not how one engine accounts for it.
- The downloadable AI models (MODNet, BiRefNet, DETR, SlimSAM) cannot be fetched from
  this environment; the AI changes were tested with the bundled U²-Netp, and the
  DETR/SlimSAM paths only by type checking and reading Transformers.js's code.
