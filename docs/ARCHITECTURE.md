# Focused architecture

Focused is one application with four workspaces — **Library**, **Develop**,
**Composite** and **Video** — built on one asset system and one rendering engine. This file is the
contract: when a change moves a responsibility, update it in the same change.

```
                     ┌──────────────────────── React UI (app/, features/) ─────────────────────────┐
                     │  Library             Develop                     Composite                  │
                     └──────┬──────────────────┬───────────────────────────┬───────────────────────┘
                            │ ids, records     │ recipe edits              │ document edits
                  ┌─────────▼─────────┐ ┌──────▼─────────────┐   ┌─────────▼──────────┐
                  │ core/catalog      │ │ core/develop       │   │ core/document       │
                  │ assets, collections│ │ recipe, presets    │   │ layers, masks, tree │
                  │ query, import     │ │ copy/paste/sync    │   │ serialization       │
                  └───┬──────────┬────┘ └──────┬─────────────┘   └─────────┬──────────┘
                      │          │             │  history (core/history) ◄─┘
             IndexedDB│   workers│      ┌──────▼──────────────────────────────▼──────┐
     (records, blobs) │ (decode, │      │ core/gpu — WebGL2 render graph             │
                      │  thumbs, │      │ develop pipeline · mask coverage ·         │
                      │  AI)     │      │ layer compositing · histogram · export     │
                      ▼          ▼      └────────────────────────────────────────────┘
```

## Layers of the codebase

| Layer | Path | Owns | May import |
| --- | --- | --- | --- |
| 0 | `src/lib` | Pure utilities (math, colorimetry, ids) | nothing app-specific |
| 1 | `src/core/*` | Data models, persistence, decoding, rendering. No React. | `lib`, other `core` |
| 1 | `src/components` | UI primitives (Slider, Panel, Menu, Dialog) | `lib` |
| 2 | `src/features/*` | Workspace UIs: library, develop, composite, video; shared `effects` (browser, parameter editor) and `export` (photo export dialog host) | `core`, `components`, `app/state` |
| 3 | `src/app` | Shell, global UI state, shortcuts, composition | everything |

Rules: core never imports React; features do not import each other except through
`app/` (or a documented action module); stores hold records and ids, never pixels.

## One asset system

An **asset** (`core/catalog/types.ts`) is a photograph in the catalog:

```
Asset
 ├── original        stored copy (IndexedDB) or a disk handle — never written
 ├── thumbnail       480 px, from the embedded preview or a real decode
 ├── preview         2560 px for Loupe/Compare/Survey
 ├── metadata        EXIF summary, capture time, size, orientation
 ├── rating · flag · label · keywords · title · caption
 ├── collectionIds · stackId/stackIndex
 └── develop         DevelopRecipe (absent = never developed) + developRevision
```

Library, Develop and Composite all address photos by asset id. Composite image
layers reference an asset id plus its develop recipe, so a developed RAW flows into a
composition without being flattened, and editing its recipe later updates the layer.

### Persistence (`core/catalog/db.ts`)

One IndexedDB database, `focused-catalog`:

| Store | Key | Content |
| --- | --- | --- |
| `assets` | id | Asset records (small; loaded eagerly at start) |
| `collections` | id | Collections and smart collections (rules) |
| `originals` | asset id | Copied original (import-by-copy only): a Blob, or `{ bytes, type }` on iPhone/iPad and wherever a Blob is refused (`StoredBytes`) |
| `thumbs` | asset id | Thumbnail + preview blobs, revision they were rendered for |
| `rasters` | id | Coverage rasters for AI masks (8-bit), referenced by recipes |
| `presets` | id | Develop presets (recipe groups) |
| `snapshots` | id | Named develop snapshots per asset |
| `documents` | id | Composite documents |
| `settings` | key | Preferences |

Writes to asset records are batched (250 ms) and flushed on `pagehide`.

### Import (`core/catalog/import.ts`)

Files come from the file picker, a folder picker, or drag and drop (folders are walked
recursively). Every picker goes through `lib/files.ts` `chooseFiles`, which keeps the
input in the document until it delivers: iOS Safari (every browser on iPhone and iPad)
never reports files for a detached input. On iPhone and iPad the accept list is
`image/*,video/*` (`pickerAccept`), so the photo library offers everything; HEIC
arrives converted to JPEG (naming HEIC would make Safari convert every JPEG and PNG to
HEIC instead). Failures and skipped files end in a toast, since the status pill's
details are a tooltip. Without `crypto.subtle` (an http:// page) the fingerprint falls
back to FNV-1a. On Chromium, **Import Folder** uses the File System Access API and
*references* files in place; everything else is copied into the library. Each file is
fingerprinted (size + SHA-256 of first/last 64 KB) to skip duplicates, appears in the
grid immediately, and is analyzed by a pool of image workers (`core/image`):
metadata via exifr, orientation, a thumbnail and a preview. For camera RAW the largest
embedded JPEG is used (format-agnostic JPEG marker scan — 74 ms on a 30 MB ARW);
without one, LibRaw decodes at half size. HEIC goes to the browser's own decoder first
(Safari), then to WebCodecs' HEVC decoder with our HEIF parser (`decodeHeicImage`).

## RAW decoding

LibRaw 0.22 (via LibRaw-Wasm) decodes in its own worker. For development it returns
**linear 16-bit Rec.2020** (`gamm [1,1]`, `noAutoBright`, camera white balance,
`output_color 8`). Camera white-balance multipliers and the camera matrix give the
**As Shot** temperature/tint (`lib/colorimetry.ts`). LibRaw is a pthreads build and
needs a cross-origin isolated page (COOP/COEP headers; see `vite.config.ts`).
Nothing is converted to JPEG and presented as RAW: the Library's embedded preview is
labelled as the camera's rendering until Develop has decoded the real sensor data.

## Develop

A **recipe** (`core/develop/recipe.ts`) is the complete description of a rendering:
profile, white balance, basic tone, tone curve (parametric + point curves per channel),
color mixer, color grading, detail, lens corrections, geometry (rotate, flip,
straighten, crop, keystone), effects, and **masks**. It is data only. Everything that
reads a recipe from outside goes through `sanitizeRecipe`, which fills defaults and
clamps values. Copy/paste/sync and presets operate on recipe *groups*.

**Copied edits** (`core/develop/clipboard.ts`, commands in `features/develop/copy-edits.ts`)
move edits between photos without a file: "Copy Edits" takes any photo's recipe (open in
Develop or not; everything but crop, masks and spot removal unless the Copy… dialog says
otherwise) and "Paste Edits" applies it to any selection, one undoable step in each
photo's history. They are in the photo menu (so the phone's select-mode Actions), Develop's
⋯ menu on phones, its left panel, and Ctrl+Shift+C / V in the Library and Develop. The clip
is kept in localStorage and read back through `sanitizeRecipe` after the modules load.
Photos edited without being opened (pasted, synced) get their Library thumbnail and
preview re-rendered in the background (`DevelopEngine.refreshThumbnailsOf`: decode,
render, free, one at a time).

**Seeing the original**: pressing and holding the photo (still, a finger or the mouse)
sets `develop.peek`; the engine draws the before-render in place of the edit and an
"Original" pill shows until it is let go. A move before it shows hands the press to a
swipe or pan instead.

**Preloading** (`prefetchNeighbours` in `features/develop/loader.ts`): once the open
photo has decoded, the photos beside it in the Library's order decode in the background
(quietly, one at a time) and are uploaded without disturbing the render
(`preloadSource`); `setWarm` tells eviction to keep exactly those. Computers keep both
neighbours; lite devices only the one in the direction of travel and never a RAW, to stay
inside mobile memory. Opening a photo whose preload is still running takes that decode
over instead of starting another; leaving Develop cancels and frees them.

History (`core/history/history.ts`) stores immutable recipe states. States share
structure, so a step costs only the objects that changed; a slider drag is one group
and one labelled step. Snapshots are named recipes stored per asset.

### Render pipeline (`core/gpu`)

The working space is **linear Rec.2020, RGBA16F**, scene-referred with headroom above
1.0. Passes (fullscreen fragment shaders over render targets):

1. **Source** — upload once per photo: RAW as linear 16-bit, rendered files as sRGB 8-bit
   decoded to linear Rec.2020 in the shader.
2. **Geometry** — orientation, flip, straighten, keystone, lens distortion, CA and crop,
   resampled into the working resolution (preview size while interacting, full size
   for export).
3. **Prepare** — white balance (Bradford adaptation between as-shot and requested
   illuminants), exposure.
4. **Local contrast** — blurred luminance at two scales for texture and clarity, and a
   haze estimate for dehaze.
5. **Tone & color** — highlights, shadows, whites, blacks, contrast, parametric and point
   curves, color mixer (Oklab), color grading, vibrance, saturation, profile.
6. **Masks** — each mask's coverage (brush strokes, gradients, ranges, AI rasters,
   combined with add/subtract/intersect/invert) scopes its local adjustments.
7. **Detail** — noise reduction and sharpening with edge masking.
8. **Effects** — post-crop vignette, grain.
9. **Display** — gamut-clip to sRGB, encode, clipping overlays, before/after split.

Radii are specified in full-resolution pixels and scaled by the working resolution, so a
low-resolution preview matches the full-resolution export. While a slider is dragged the
pipeline renders at reduced resolution and re-renders at full view resolution on release.

WebGL2 is the baseline because it runs everywhere (including headless test browsers).
Rendering code only talks to `core/gpu/gl.ts` (`Gpu.pass`, targets, textures), which is the
seam for a future WebGPU backend. AI inference already uses WebGPU when available.

Spot repairs (`recipe.retouch`) are applied first, to a cached, mipmapped copy of the
source, so every later pass sees the repaired pixels.

### One engine, one canvas

`core/gpu/develop-engine.ts` owns a single canvas and WebGL2 context. Develop and
Composite both attach it to their view (it is moved, not recreated), so decoded photos,
retouched sources and mask rasters on the GPU are shared: an image layer in a composition
reuses the photo already decoded for Develop. The canvas is the view's first child; React
tool overlays (crop frame, mask handles, transform handles) render above it.

## Composite

A **document** (`core/document`) is a layer tree:

```
Document
 ├── canvas (width, height, background)
 ├── assets referenced by id
 ├── layers: image (asset + recipe) · fill · gradient · text · shape · adjustment · effect · group
 │     each: visibility, lock, opacity, fill opacity, blend mode, transform, crop,
 │           mask (vector/raster), clipping, name
 └── history, snapshots
```

`core/gpu/compositor.ts` renders a document bottom to top: each layer's content (a
developed photo, a text or shape raster, a procedural gradient or fill) is placed on a
canvas-sized target through the layer's homography with its crop and mask, then blended
onto the backdrop. Blending follows the W3C Compositing and Blending spec in
premultiplied, display-encoded space (like Photoshop), including the non-separable
Hue/Saturation/Color/Luminosity modes and Photoshop's fill opacity for the eight special
modes. Clipped layers composite "atop" their base; groups render in isolation; adjustment
layers convert the backdrop to linear Rec.2020 and reuse the develop tone/color shaders.
Per-layer content is cached by its inputs and evicted when unused.

PNG/WebP exports keep alpha; JPEG flattens against a chosen background.

### Effects (`core/effects`)

An effect is data: `{ id, params }` on an `effect` layer. `registry.ts` lists the
definitions. Each one declares typed parameters (number, select, color, toggle, text),
which drive both the Properties UI and the sanitizer. Each also has a `render` function
made of one or more GLSL passes from `library/*`.

`runtime.ts` (`EffectRunner`) copies the backdrop into a mipmapped texture. Effects can
then read a cell's average color in one `textureLod`, which is how ASCII, halftone,
mosaics and bricks stay cheap at any size. The runner also binds the shared prelude
(`glsl.ts`: hashing, value noise, Oklab palette matching, Bayer matrices, anti-aliased
coverage, auto-leveling) and lends pooled targets and blurs for multi-pass effects. It
builds glyph atlases for the text effects with Canvas 2D, sorted by ink coverage for
density ramps.

The compositor treats an effect layer like an adjustment layer. It runs the effect on the
backdrop (or on its clipping base), applies the mask and fill, then blends the result
with the layer's mode and opacity. Spatial parameters are in units of 1/1000 of the
document's long side, so results do not depend on render scale. The Effects browser asks
the engine for previews (`DevelopEngine.effectPreviews`). The engine renders the layers
below the insertion point once, then runs each effect on that image at 360 px.

**Post-processing** (`post.ts`). Every definition gets the same extra parameters
(`POST_PARAMS`, appended in `registry.ts`, in a "Post-processing" section): bloom
(soft-knee threshold → two blurs of different widths added back, spilling onto
transparent pixels) and film grain (per-cell triangular noise, strongest in the
mid-tones, re-rolled per frame for animated effects). The runner applies them after the
effect's own passes. Both default to off, so documents saved earlier load unchanged; a
definition's `initial` values (ASCII: both on) apply only to newly added effects.
Parameters can also carry `group`, `short` (visible label) and `showIf` (shown while
another parameter has a value), which the shared `EffectParams` editor follows.

**Animated effects.** A definition with `animated: true` moves over time. The runner
passes `uTime`, `uLoop` (loop length in seconds) and `uPhase` (0–1 through the loop) to
every pass. Animated shaders only move in whole cycles per loop (`loopCircle`,
`loopNoise`, `frameHash` in the prelude, and integer "Speed" parameters), so the last
frame leads back into the first without a jump. A composition's loop settings are data:
`CompositeDocument.animation` (`{ duration, fps }`, optional, sanitized;
`core/document/animation.ts` has the defaults and `isAnimated`). `Compositor.render(doc,
scale, time)` renders any moment of the loop. The engine plays it in the canvas while
`composite.playing` is set, on its own timer outside `requestRender` so the activity bar
stays quiet, and `holdAnimation()` freezes it during exports. Video clips pass the clip
time with a fixed 4 s loop (`VIDEO_EFFECT_LOOP`).

**Animated export** (`core/export/animated.ts`). Still formats take a "frame at" time.
GIF renders a few frames spread over the loop to build one shared palette, then renders
every frame on the GPU and streams it to `gif.worker.ts`, which maps it to the palette
(optional Floyd–Steinberg dithering) and compresses it with gifenc, with at most three
frames in flight. MP4 plays the loop N times through WebCodecs and mp4-muxer, reusing the
video workspace's encoder choice. Both flatten onto an opaque background and stamp the
watermark. Only the first frame goes through `verifiedRender`; the rest reuse its caches.

### Text and fonts (`core/text`)

`fonts.ts` lists the fonts: bundled open-licensed families (Fontsource, declared in
`styles/fonts.css`, Latin subset) and a few system fonts. A text layer stores a CSS
family stack. Font files download on first use. Canvas text does not trigger that
download reliably, so the compositor calls `ensureFont` and adds
`fontLoads.generation` to the text raster's cache key. The engine re-renders when the
generation changes. Exports and watermarks `await loadFonts` before drawing.

`draw.ts` draws a text style into its box. With `style.motion` (typewriter, pop in,
wave, bounce, rainbow, pulse, neon flicker, glitch), letters are laid out one by one and
moved for the loop phase. The raster's cache key then includes the phase, so moving text
is redrawn each frame and still text is drawn once. Repeating motions complete whole
cycles per loop. Flicker and glitch use a hash of the frame number, so the preview and
the export match.

### Transparency (Remove Background)

A develop mask can be the photo's *cutout* (`mask.cutout`): its coverage multiplies the
alpha channel. Remove Background creates an AI subject mask marked as the cutout, so the
cutout is refined like any mask (add a brush to restore, subtract one to erase, feather or
shift the AI edge) and flows into Library thumbnails, exports and compositions. Restore
background (Develop's Masks panel, Composite's layer properties) clears the cutout and
keeps the mask, as one undoable step.

### Project files

`.focused` files (`core/document/project.ts`) are ZIPs holding the document, each
referenced photo's recipe and metadata, the AI rasters the recipes reference and,
optionally, the original files. Photos are relinked by content fingerprint.

## Video (`core/video`, `features/video`)

A clip is a record in IndexedDB (`videos`, holding metadata, a poster frame and the
serialized edit) plus its file (`videoFiles`). The file is copied on import and never
modified. `session.ts` opens a clip with an undo history over its `VideoEdit` and saves
changes after a short delay.

**Reading files** (`demux.ts`): only the index (`moov`) is parsed, in 1 MB reads that
jump over the media data wherever it is (iPhone .MOV files put the index last). Samples
are a table of offsets, sizes and times; their bytes stay in the file and a
`SampleReader` per consumer reads them through a 4 MB sliding window. Fragmented MP4s
(no sample table in `moov`) are read whole. Dolby Vision tracks ("dvh1") are decoded
as their HEVC base layer (`hevcCodec` builds the codec string from hvcC). The audio
track is the first one with a codec we decode (newer iPhones add a spatial APAC track),
and AAC is decoded from an ADTS stream of the track alone (`adtsStream`), trimmed by
the edit list's priming; other codecs go through the whole file (refused above 300 MB on
phones). Import probes the file with the browser's player and falls back to the index
and a WebCodecs frame when the player can't show the picture.

**The edit** (`model.ts`, version 3, sanitized on load; version 1–2 trims migrate to one
segment) is a list of segments. Each segment is a source range of this clip or another
clip, with its own treatment: speed (tape-style or pitch-preserving), pitch, reverse,
stutter, ping-pong ("dance"), hold ("stare down"), volume and mute, audio effects (ear
rape, sus harmonizer, echo, reverb, chorus, vibrato, bitcrush), picture treatments
(mirror, flip, invert, hue and rainbow, zoom, shake, deep fry) and an optional library
effect. A whole-video effect sits on top (Looks save and apply it).

**The timeline compiler** (`timeline.ts`) turns segments into pieces: contiguous plays of
a source frame range at a rate, forwards or backwards, or a held frame. It maps every
output frame to exactly one source frame. Frames are counted with cumulative rounding,
so at speed 1 a segment emits each source frame once: nothing dropped, nothing doubled.
Splits, moves, duplicates and inserts are pure functions over the edit. Output is
constant frame rate at the clip's average rate.

**Audio** (`dsp.ts`, run in `soundtrack.worker.ts` via `soundtrack.ts`): each clip's audio
is decoded once at 48 kHz. Each segment is rendered from the same pieces as its pictures:
sliced and reversed, resampled for tape-style speed or time-stretched (WSOLA) to keep
pitch, pitch-shifted, then treated. The worker caches rendered segments by their job, so
an edit re-renders only what changed. Preview and export use the same soundtrack.

**Frames** (`frames.ts`): `FrameSource` decodes a clip with WebCodecs by presentation
index. It continues a running decode for the next frames, and restarts from the keyframe
before a wanted frame otherwise. That gives frame-accurate random access for scrubbing,
reverse play and stutters. Decoded frames go through a store (scaled bitmaps for the
viewer, exact plane copies for export) into a byte-bounded LRU (smaller on phones).
`openFrames` picks the decoder: WebCodecs when `isConfigSupported`, else
`ElementFrameSource`, which seeks a hidden `<video>` to the middle of each frame and
grabs it upright (so `rotation` is 0), for HEVC where only the browser's player decodes
it; the viewer says "Compatibility playback". When neither can decode the clip,
`cannotDecode` explains the HEVC options. `localStorage["focused:video-decoder"] =
"element"` forces the fallback (tests).

**Editor** (`features/video`): `engine.ts` owns playback. The rendered soundtrack plays
through Web Audio, and its clock drives the frame on screen. Scrubbing plays short
grains of the soundtrack. The viewer draws the frame through `VideoRenderer`
(`renderer.ts`: rotation and letterboxing, the picture treatments, then library effects
through the shared `EffectRunner`). The timeline (`Timeline.tsx`) draws thumbnails and
the waveform of the visible range only. `actions.ts` holds the editing commands, the
one-click YTP treatments and the random generators. On phones the toolbar row folds into
the transport (play, frame steps, time, split, duplicate, delete, ⋯), the timeline is
shorter, and touch has its own gestures on segments: tap selects and seeks, a sideways
swipe scrolls, a press held for 380 ms picks the selection up to move, two fingers pinch
to zoom; trim handles appear, thumb-wide, on the selected segment only.

**Export** (`export.ts`):
- An MP4 of an untouched clip copies the original compressed samples bit for bit (VP9/AV1
  need the colour description the file states, read from vpcC or colr).
- The lossless formats encode VP9 at quantizer 0. That is VP9's lossless mode: decoding
  returns exactly the YUV that went in. Frames shown as they are go to the encoder in the
  decoder's own YUV, cropped, converted from NV12 and rotated exactly (`yuv.ts`), so they
  come out bit-identical to the source. Treated frames are rendered on the GPU first.
- The MKV (webm-muxer, Matroska) carries uncompressed float PCM audio. The MP4 carries
  AAC 320k or Opus 510k.
- The Compatible format is near-lossless H.264 (`encoder.ts`).
- Every timeline frame is encoded exactly once, in order, with bounded queues. The export
  fails, rather than saving, if the encoder returns a different number of frames.

## Looks (`core/looks`, `features/looks`)

A look is plain data (see ROADMAP → Looks) validated by `sanitizeLook`. Develop values
are validated again by `sanitizeRecipe` when pasted. `fitLayers` refits canvas-relative
layers to another canvas: canvas-wide layers cover it, positions scale per axis, and
sizes scale uniformly. `features/looks/apply.ts` pastes develop groups, runs the AI
selections again for AI mask components, and builds compositions through
`features/composite/actions.photoSize`.

## Export destinations and watermark (`core/export`)

`ExportSink` delivers one export run to a `Destination`: separate downloads, a ZIP built
with fflate (store only), or a directory handle. Watermarks are drawn with Canvas 2D after readback (photos and compositions) or uploaded
once as an overlay texture (video frames).

Frames (`core/export/frame.ts`) are data like the watermark (`ExportFrame`, read through
`sanitizeFrame`, the last one remembered per browser). `frameLayout` gives the finished
size and the opening: *inside* draws over the image's edges at the same size, *around*
(and Polaroid, with its deeper bottom edge) grows the file by the band. `composeExport`
is the one place a still is finished: it draws the photo (clipped to the rounded
opening), the band — Glass: the photo itself blurred, slightly magnified and tinted
inside the band, with a bevel, rim lights and an inner shadow; Solid/Polaroid: a mat —
and then the watermark inside the opening. Photo export (`encodePixels`), composition
stills and the animated `Flattener` (GIF/MP4) all go through it. Video stamps only a
solid inside frame (`drawFrameOverlay`) into the same overlay texture as its watermark,
so the clip keeps its size and a still-frame copy path is never framed by mistake.

## Pacing and working animations (`lib/pacing.ts`)

Work of unknown length (exports, AI, decoding) answers within a frame and never looks
frozen. `nextPaint()` resolves after the browser has painted; callers use it after
showing a working state and before synchronous GPU work (develop render and read-back),
so the click lands visibly. `holdAtLeast(start)` keeps a working animation up for
`PACE.minWorking` (900 ms) so fast runs still read, followed by a `PACE.doneBeat`
(650 ms) completion moment. Long runs loop and show a stage or a percentage.

- Photo export reports stages (`exportAsset(…, onStage)`: reading the original,
  developing W × H, encoding, saving) with a paint between each. The dialog's byte
  estimate (a real export) only runs for outputs up to 12 MP and never during an export.
- **Remove Background** (`components/cutoutFx.ts`, used by Develop and Composite through
  `runCutout`; Composite passes the layer's on-screen rectangle as `area`, so the globe
  is made of that layer's pixels, not the whole composition). One run at a time (`cutoutRun`; the buttons are disabled meanwhile), and
  the result always lands on the photo the run started on. Everything moves on the GPU
  in `components/particleGlobe.ts` (WebGL2 points): while the AI runs, the photo's
  pixels (one averaged sample per particle, about one per 4 CSS px) lift into a turning
  globe — one spring morphs every particle between its place in the picture and a
  Fibonacci-sphere point, with per-particle turbulence and depth shading; the pointer
  tilts the globe and parts the particles; a dotted ring fills while the model
  downloads. A hidden live region carries the status. At least 1.5 s, as long as
  needed. Then the spring returns the particles, the exact frame (a GPU copy of the
  viewer canvas) is held on top while the cutout is applied underneath, the changed
  particles are found by comparing two small samples, and the dissolve runs in the same
  shader: background particles burst outward and scatter from the pointer, the outline
  glows, subject particles vanish over the real cutout. The photo's bounds come from a
  640 px probe, widened by one probe pixel so no edge peeks out. Leaving the viewer
  (another workspace or photo) removes the animation at once; the result still lands.
  Reduced motion or no WebGL2: a 250 ms crossfade.

## Export marble (`features/export/marble.ts`)

Every export dialog (photos, compositions, videos) opens with `ExportHero`: the
marble holding the selection and, beside it, what will be exported or the progress
(never covered). The marble takes up to five previews, most recently selected first
(the active photo or open composition/clip leads), shows the first while you choose,
crossfades through them while the export runs (two card textures, 520 ms), and shows a
counter: the number of items, or "2/7" while rendering. It moves idle → working → a
"done" burst. It is a glass marble ray-marched in its own small WebGL2
canvas (adapted from Originkit's Magic Marble, MIT). Pigment is a 3D value-noise
texture made on the CPU and sliced along each refracted ray; a card with a preview of
what is being exported floats inside, facing the viewer. Each dialog passes an
`ExportPreview` (`key` + `load`): photos use their library thumbnails; compositions their
saved thumbnails, rendered at time 0 (the first frame of a GIF or MP4); videos frame 0 of
the edit (from the timeline thumbnails for the open clip; other clips show their poster
until their export starts, then their first frame decoded by a muted `<video>`). Previews are shrunk to 192 px before upload. The
marble renders at most 30 fps (12 on software GL), holds still under reduced motion,
and frees its context when the export ends. It is decorative (`aria-hidden`); the bar
and its label carry the progress.

## Reading pixels back

Every image that leaves the GPU goes through `Gpu.readImage`: exports, thumbnails,
previews, effect previews and the AI input image. It draws the (straight-alpha) result
into the engine's own canvas in tiles of up to 2048 px, and copies each tile out with a
2D canvas `drawImage`. That is the same path the browser uses to show the canvas.
`gl.readPixels` on offscreen framebuffers is kept only for small analysis reads (the
histogram and the eyedropper), because some browser/GPU combinations return it wrong:
blank, shrunken or stale images. The canvas is borrowed for the duration of one
synchronous call and redrawn right after. A one-time background job re-renders developed
thumbnails made before this change.

## GPU memory and export verification

`DevelopPipeline` pools render targets by size and format, but keeps idle targets only
within a 320 MB budget (64 MB on phones and tablets, `lib/device.ts`); anything beyond is
freed on release. Before and after an export,
`DevelopEngine.freeMemory()` also drops layer, effect and preview caches.
`exportDocument` / `exportPixels` check the full-size result against a 512 px reference
(`gpu/verify.ts`) and check `gl.getError()` for out-of-memory and context loss. They
retry once, then fail with a clear message. Drivers that run out of memory can otherwise
return blank or stale pixels without any error.

## Glow backdrop and guided tour (`features/backdrop`, `features/tour`)

- **Backdrop.** `features/backdrop/ribbon.ts` draws an animated ribbon glow (adapted
  from Originkit's "Ribbon Glow 2"; see `docs/THIRD_PARTY.md`) into its own WebGL2
  canvas, fixed behind the whole app at `z-index: -1`. Panels stay opaque; the viewers
  are transparent around the photo, so the glow shows only there. For that, the develop
  `display` and `compositeDisplay` passes and the video renderer clear to and output
  transparent pixels outside the image, and `.develop-view`, `.composite-view` and
  `.vid-editor` paint their old surround colours in CSS. With the glow off the screen is
  unchanged; with it on, image pixels are unchanged (they are opaque). Each workspace
  has a look in `looks.ts` (two colours, angle, size, speed, brightness); the glow
  blends to the active workspace's look over about 1.2 s. It holds still while
  anything calls `holdMotion()` (`lib/motion.ts`); the Video workspace does so while a
  clip plays or exports, so playback has the GPU to itself. It renders at a capped field
  resolution and 30 fps (15 on software GL), pauses in hidden tabs, holds still under
  `prefers-reduced-motion`, and frees its context when switched off.
- **Prefs** (`app/prefs.ts`): the glow on/off, whether the tour was finished, which
  panels are shown and their widths, and the phone sheet's height, in localStorage
  under `focused:prefs`, sanitized on read. They are viewer conveniences,
  not edits.
- **Tour.** `features/tour/steps.ts` lists the cards (the eight chapters of the
  tutorial); `tour.ts` is the store (start, next, back, skip chapter, end).
  `Tour.tsx` (lazy) spotlights the first on-screen element matching each step's
  selectors, re-measured every frame, and places the card beside a small target,
  inside a large one, or centred. The overlay ignores the pointer, so the app stays
  usable during the tour. ←/→/Enter/Esc drive the tour (captured before app
  shortcuts); other keys reach the app. The welcome card opens once for a new visitor;
  the top bar's ? button replays the tour or any chapter, and ◐ toggles the glow.

## Sweep selection (`components/sweep.ts`)

`useSweepSelect(host, options)` turns right-click-and-hold (280 ms) or right-drag
(6 px) inside `host` into a selection box. It holds back the browser's `contextmenu`
(sent on press on macOS/Linux) until it knows: a quick click re-dispatches it to the
original target, so existing context menus work unchanged; a sweep swallows it and
calls `onDone` for a batch menu. Items are found by `hits(box)` — `domHits` for
elements with `data-sweep-id`, or a geometric test (the Composite canvas tests
`layerBounds` in document space). The box is anchored in the scroller's content
coordinates and auto-scrolls at the edges; items a virtual list unmounts keep their
caught state (`mergeCaught`). Selections go to the surfaces' existing stores
(`ui.selection`, `composite.selection`, the video `editor` store's `selection` and
`clipSelection`), so every existing action applies to them.

Phones batch-select in **select mode** (`app/select-mode.ts`, `app/SelectBar.tsx`),
like the Photos app. A `SelectScope` describes one kind of item (photos, layers,
clips, segments): its selection's getter, setter and subscription, every item in view
(Select All), and its batch actions (the same menu the sweep opens). A list passes its
scope to `useSweepSelect`, whose touch path (phone layout only) turns a press held still
on an item (`LONG_PRESS_MS`) into select mode with that item; in select mode a tap
toggles an item (the item's own handlers and the emulated mouse events stand down), a
swipe across the list's scroll direction (`axis`) sweeps a box that adds what it
touches, and a swipe along it scrolls. A list's `SelectButton` (Library top bar,
Layers and Clips panel headers; the video transport's ⋯ menu for segments) enters it
from nothing. While a scope is active `SelectBar` replaces the dock: Done, the count,
All/None, Actions. The timeline keeps its own finger gestures (hold to move the
selection), with a tap toggling in select mode. Changing workspace, Escape (when no
menu or dialog is open) or growing to the computer layout leaves select mode; the
selection stays.

## Gallery swipe (`components/GallerySwipe.tsx`)

The Library's loupe and Develop's viewer let a finger (or pen) swipe between photos
like a phone's gallery. `GallerySwipe` lays the previous and next photos' previews over
the viewer (kept loaded but hidden, so a swipe shows them at once) and, once a drag is
clearly sideways, moves the viewer's own element (the loupe image, the Develop canvas)
with the finger while the neighbour slides in beside it, placed where the viewer will
draw it (`placePicture` in `lib/fit.ts`, which mirrors the viewers' fitting, the
floating panel included). Released past a third of the width or with a flick it glides
on (280 ms) and calls `go` (`selectAsset`); otherwise it springs back; at either end the
drag gives like a rubber band. After switching, the preview stays where it landed until
the viewer reports the new photo (`ready`: the loupe image loaded, or Develop's source
for the new asset), so the change never flashes; a new swipe finishes that wait at
once. Develop allows it only while editing at fit with no comparison, and only on the
photo itself (not the curve, split handle or other overlays); zoomed in, a drag pans.
A vertical drag, a second finger (a pinch) and mouse input are left alone; with
reduced motion the switch happens without the glide.

## Layout on computers and phones (`app/Shell.tsx`, `app/layout.ts`, `lib/device.ts`)

Every workspace renders through `Shell` with `left`, `center`, `right` and an optional
`dock`. Design notes and sources: `docs/MOBILE.md`.

- **Computers** keep the three columns. Each side panel sits in a `.side-frame` with a
  `role="separator"` handle on its inner edge: drag it (the width lives on the element
  while dragging and is written to prefs once), use the arrow keys, or double-click for
  the stylesheet default (`leftWidth`/`rightWidth` null). The top bar's panel toggles
  (and Tab / Shift+F) show or hide the left panel (Develop: presets, snapshots,
  history), the filmstrip and the right panel; all of it persists.
- **Phones** (`COMPACT_QUERY`: up to 780 px wide, or a touch screen up to 520 px tall)
  get the compact layout, modelled on Lightroom mobile: the viewer fills the screen; a
  bottom dock in thumb reach opens one side's panels in a sheet (`layout.sheet`); the
  sheet's grip drags to resize and snaps to 30/50/85 % of the screen (or closes below
  20 % or on a downward flick; it opens at 36 %). Held upright every sheet *floats*,
  translucent, over the bottom of the picture, like Lightroom mobile's panels: it
  renders inside `.center` (or, portalled, in the area a workspace registers with
  `setFloatHost`: Video floats panels over the frame so the transport and timeline stay
  in reach) and reports the height it covers (`layout.cover`, also the `--cover` CSS
  variable). Viewers make room with `placeClear` (`lib/fit.ts`): Develop's Edit and
  Video keep the picture at the size that fits the whole viewer but place it clear of
  the panel when it fits above it (else from the top, the rest seen through the panel);
  tools that reach the picture's edges (Crop, Masks, Heal, Composite's layer handles)
  fit it whole above the panel (`DevelopEngine.setCover`, `VideoEngine.setCover`); the
  Library's grid, loupe and survey pad their bottoms by `--cover`. Held sideways
  sheets sit beside the picture instead. Develop's dock is Presets · Edit · Crop ·
  Masks · Heal (Crop, Masks and Heal open a sheet holding just that tool; Composite's
  dock adds Effects, which opens the browser). Edit opens `EditDeck` in a *fitted*
  sheet (`DockItem.fit`): Lightroom mobile's short panel, one group at a time (Light,
  Curve, Color, Mixer, Grading, Effects, Detail, Optics; Effects and Detail split into
  parts under sub-tabs) with about three sliders showing and the groups in a row
  beneath, no title row. Its height is the content's; dragging the grip up stretches
  it until it closes. Curve draws the curve over the photo (`CurveOverlay`, the panel's
  `CurveGraph` in overlay mode, sized in its box's pixels) and shrinks the panel to a
  bar (`CurveBar`: channels, parametric sliders, Reset, Done). The groups reuse the
  desktop panels' bodies (`ToneSliders`, `WhiteBalance`, `SharpeningSliders`…; each
  `…Panel` is those bodies in a collapsible `Panel`). Sliders in a phone sheet put the
  name and value on one line over a wide track; a finger drags a slider sideways from
  where it is (`Slider`'s touch path: a tap does nothing, a vertical swipe scrolls,
  `touch-action: pan-y`). The histogram floats, small and translucent, in the photo's
  top-left corner (`FloatingHistogram`, only while editing, so crop handles and brushes
  keep the corner; `prefs.showHistogram`, toggled in the ⋯ menu); it lets touches
  through to the photo. The
  top bar has a workspace switcher (a menu), the workspace's main actions (in the Library a
  centred Liquid Glass Import button that shows progress while it runs; the newest photo is
  refracted through it), and a ⋯ menu (menus on phones are Liquid Glass too: a
  backdrop blur of the photo behind, rim lights, 48 px rows with icons in the system font)
  for import, the filmstrip, the histogram (Develop), the glow and the tour. Main actions (undo, redo, export)
  render through `<CompactActions>` into the top bar's slot (`actionsSlot`), and the
  toolbar's own copies carry `wide-only` and hide; toolbars scroll sideways for the
  rest (Composite's becomes large icons with alignment in a menu). Held sideways
  (landscape, up to 520 px tall) the dock is a rail on the right and panels open beside
  the picture. `-webkit-user-select: none` (Safari ignores the unprefixed property) keeps
  long presses from selecting the interface. The effects browser goes full screen with a search, a row of category chips
  and two columns of previews (240 px renders on lite devices), and does not raise the
  keyboard by itself. Dialogs and the browser are portalled outside `.app`, so the
  root carries `data-compact` for their styles. `(pointer: coarse)` raises touch targets (sliders 36 px, buttons 32–34 px,
  16 px inputs so iOS does not zoom). The Develop viewer adds touch gestures: two
  fingers pinch-zoom and pan (captured before tools), a double tap toggles 100 %.
- **Device profile** (`lib/device.ts`, decided once per load; desktops get the full
  profile, which changes nothing). `lite` (phones, tablets, ≤2 GB): photos are uploaded
  at most 4096 px on the long side (`DevelopPipeline.upload`; RAW goes through
  `sourceRgb16Box`, which averages the samples each pixel covers, since integer
  textures cannot be filtered) and exported at most that size (`exportSize`, with a
  note in the export dialogs); the pool budget is 64 MB; viewer canvases render at most
  2 device pixels per CSS pixel (`viewDpr`); two decode workers; idle GPU targets are
  freed when the tab is hidden; the AI defaults to the small model. `phone`: the glow
  starts off, the export marble holds still and Remove Background uses its crossfade
  instead of the particle globe. `localStorage["focused:device"]` overrides the guess.

## Activity (`lib/activity.ts`)

A counter of running work, plus "pulses" for instant changes. The engine's frame
requests, source decoding, AI calls, exports, effect previews and video work register
with it. `app/ActivityBar.tsx` turns it into the thin line at the top of the window.

## Workers

| Worker | Work |
| --- | --- |
| `core/image/image.worker.ts` (pool of ≤4, ≤2 on phones) | metadata, embedded previews, thumbnails, previews |
| LibRaw worker (inside libraw-wasm) | RAW decoding |
| `core/ai/ai.worker.ts` | model loading and inference: Transformers.js (BiRefNet, MODNet, DETR, SlimSAM) and ONNX Runtime directly for the bundled U²-Netp; WebGPU → WASM |

## Status

See `docs/ROADMAP.md` for what is implemented, stage by stage.
