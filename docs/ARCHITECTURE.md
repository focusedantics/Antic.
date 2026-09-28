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
| `originals` | asset id | Copied original bytes (import-by-copy only) |
| `thumbs` | asset id | Thumbnail + preview blobs, revision they were rendered for |
| `rasters` | id | Coverage rasters for AI masks (8-bit), referenced by recipes |
| `presets` | id | Develop presets (recipe groups) |
| `snapshots` | id | Named develop snapshots per asset |
| `documents` | id | Composite documents |
| `settings` | key | Preferences |

Writes to asset records are batched (250 ms) and flushed on `pagehide`.

### Import (`core/catalog/import.ts`)

Files come from the file picker, a folder picker, or drag and drop (folders are walked
recursively). On Chromium, **Import Folder** uses the File System Access API and
*references* files in place; everything else is copied into the library. Each file is
fingerprinted (size + SHA-256 of first/last 64 KB) to skip duplicates, appears in the
grid immediately, and is analyzed by a pool of image workers (`core/image`):
metadata via exifr, orientation, a thumbnail and a preview. For camera RAW the largest
embedded JPEG is used (format-agnostic JPEG marker scan — 74 ms on a 30 MB ARW);
without one, LibRaw decodes at half size.

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

### Transparency (Remove Background)

A develop mask can be the photo's *cutout* (`mask.cutout`): its coverage multiplies the
alpha channel. Remove Background creates an AI subject mask marked as the cutout, so the
cutout is refined like any mask (add a brush to restore, subtract one to erase, feather or
shift the AI edge) and flows into Library thumbnails, exports and compositions.

### Project files

`.focused` files (`core/document/project.ts`) are ZIPs holding the document, each
referenced photo's recipe and metadata, the AI rasters the recipes reference and,
optionally, the original files. Photos are relinked by content fingerprint.

## Video (`core/video`, `features/video`)

A clip is a record in IndexedDB (`videos`, holding metadata, a poster frame and the
serialized edit) plus its file (`videoFiles`). The file is copied on import and never
modified. `session.ts` opens a clip with an undo history over its `VideoEdit`
(`model.ts`, sanitized on load) and saves changes after a short delay.

Preview: the player plays the file in a hidden `<video>`. On each presented frame
(`requestVideoFrameCallback`), it draws the frame into a 2D canvas at the working size,
which applies rotation, and `VideoRenderer` (`renderer.ts`) runs it through its own
WebGL context. That context has the same `EffectRunner` as Composite, and the effect
strength mixes the result with the original frame. Preview and export use output-relative
effect units, so they match.

Export (`export.ts`): mp4box.js demuxes the file (`demux.ts`, which also rebuilds decoder
descriptions: avcC/hvcC/vpcC/av1C, AAC AudioSpecificConfig, OpusHead). `VideoDecoder`
starts at the keyframe before the trim start. Frames outside the range, or above the
target frame rate, are dropped. The rest are rotated, scaled and stylized by a
`VideoRenderer` on an `OffscreenCanvas` and wrapped as `VideoFrame`s. `VideoEncoder`
uses the first supported codec (H.264 → HEVC → VP9 → AV1), and `mp4-muxer` writes the
file. Audio packets inside the range are copied, not re-encoded. Queues are bounded by
awaiting `decodeQueueSize` / `encodeQueueSize`, so memory stays flat during long clips.

## Activity (`lib/activity.ts`)

A counter of running work, plus "pulses" for instant changes. The engine's frame
requests, source decoding, AI calls, exports, effect previews and video work register
with it. `app/ActivityBar.tsx` turns it into the thin line at the top of the window.

## Workers

| Worker | Work |
| --- | --- |
| `core/image/image.worker.ts` (pool of ≤4) | metadata, embedded previews, thumbnails, previews |
| LibRaw worker (inside libraw-wasm) | RAW decoding |
| `core/ai/ai.worker.ts` | model loading and inference: Transformers.js (BiRefNet, MODNet, DETR, SlimSAM) and ONNX Runtime directly for the bundled U²-Netp; WebGPU → WASM |

## Status

See `docs/ROADMAP.md` for what is implemented, stage by stage.
