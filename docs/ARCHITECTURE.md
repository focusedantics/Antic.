# Focused architecture

Focused is one application with three workspaces — **Library**, **Develop**,
**Composite** — built on one asset system and one rendering engine. This file is the
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
| 2 | `src/features/*` | Workspace UIs: library, develop, composite | `core`, `components`, `app/state` |
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
The pipeline is written against a small backend interface so a WebGPU backend can be
added for large exports and compute-heavy passes; `core/gpu/capabilities.ts` reports
what the browser supports.

## Composite

A **document** (`core/document`) is a layer tree:

```
Document
 ├── canvas (width, height, background)
 ├── assets referenced by id
 ├── layers: image (asset + recipe) · raster · fill · gradient · text · shape · adjustment · group
 │     each: visibility, lock, opacity, fill opacity, blend mode, transform, crop,
 │           mask (vector/raster), clipping, name
 └── history, snapshots
```

Compositing runs on the GPU with separable and non-separable blend modes following the
W3C Compositing and Blending spec, in premultiplied alpha, with isolated groups.
PNG/WebP exports keep alpha; JPEG flattens against a chosen background.

## Workers

| Worker | Work |
| --- | --- |
| `core/image/image.worker.ts` (pool of ≤4) | metadata, embedded previews, thumbnails, previews |
| LibRaw worker (inside libraw-wasm) | RAW decoding |
| AI worker | model loading and inference (Transformers.js, WebGPU → WASM) |

## Status

See `docs/ROADMAP.md` for what is implemented, stage by stage.
