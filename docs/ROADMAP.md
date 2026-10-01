# Roadmap and status

Last updated with Stage 7 (partial).

A control counts as implemented only when changing it changes the image correctly and
the result survives a reload.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Shell, Library, catalog, import, thumbnails, RAW previews | Done |
| 2 | Develop renderer, adjustments, histogram, crop, before/after, recipes, presets | Done (see below) |
| 3 | Mask engine: brush, linear, radial, range masks, per-mask adjustments | Done (see below) |
| 4 | Local AI: Select Subject/Sky/Object, Remove Background | Done (see below) |
| 5 | Composite document: layers, groups, transforms, opacity, blend modes, masks | Done (see below) |
| 6 | Gradients, text, shapes | Done (see below) |
| 7 | Retouching: healing, clone, dodge/burn | Partly done: Develop spot heal/clone, dodge/burn brushes |
| 8 | Presets, sync, snapshots, `.focused` project files | Done |
| 9 | Performance: WebGPU backend, tiled export, region-of-interest rendering | Planned |
| 10 | PSD interoperability, advanced export | Planned |
| — | Effects (48 GPU stylizations, 19 animated, effect layers, browser) | Done (see below) |
| — | Animated export: GIF, MP4 loop, still frame at a chosen time | Done (see below) |
| — | Video: YTP editor (segments, scrubbing, audio treatments), lossless export | Done (see below) |

## Stage 1 — Library

Done:
- Import files, folders (recursive), drag and drop; reference-in-place on Chromium.
- Duplicate detection by content fingerprint.
- Worker pool for metadata, thumbnails (480 px) and previews (2560 px).
- RAW: embedded preview extraction for ARW/CR2/CR3/NEF/DNG/RAF/RW2/ORF/PEF…, LibRaw fallback.
- JPEG, PNG (with alpha), WebP, AVIF, GIF, BMP, TIFF (utif2), HEIC (WebCodecs HEVC, or native on Safari).
- EXIF: camera, lens, ISO, shutter, aperture, focal length, bias, flash, metering, GPS, ICC profile name.
- Ratings 0–5, Pick/Reject flags, five color labels, keywords, title, caption.
- Collections, smart collections with rules (any/all), folder tree.
- Search, filters (rating, flag, label, type, edited), sorting, stacks.
- Virtualized grid and filmstrip; Loupe, Compare and Survey views.
- Keyboard: G/E/N/Shift+C views, D/C workspaces, 0–5 rating, P/X/U, 6–9 labels, arrows, Ctrl+A, Ctrl+G stack, Delete.

Known limitations:
- Browser storage quotas apply to copied originals; Import Folder (Chromium) avoids copying.
- Embedded ICC profiles are read but thumbnails are rendered in sRGB.
- HEIC needs WebCodecs HEVC support (Chrome/Edge on hardware with HEVC) or Safari.

## Stage 2 — Develop

Done:
- WebGL2 pipeline in linear Rec.2020 / RGBA16F: geometry → white balance & exposure →
  local-contrast pyramid → tone & color → (masks) → noise reduction → sharpening → effects → display.
- RAW via LibRaw (linear 16-bit Rec.2020); the catalog preview shows immediately while the
  original decodes. As Shot white balance from the camera matrix; Kelvin/tint with presets,
  Auto (gray world) and a white-balance selector (W).
- Camera base curve for RAW, calibrated against camera JPEGs (median within ~4 levels).
- Exposure, contrast, highlights, shadows, whites, blacks (OpenLight's calibrated operators),
  texture, clarity, dehaze, vibrance, saturation, Color/B&W profile.
- Tone curve: parametric regions plus point curves for RGB, R, G, B.
- Color mixer (Oklab hue/saturation/luminance, 8 ranges), color grading (3 wheels + global,
  blending, balance).
- Detail: sharpening (amount, radius, detail, masking), noise reduction (luminance, detail, color).
- Lens corrections: manual distortion and vignetting. Effects: post-crop vignette, grain.
- Crop with aspect presets and handles, straighten with automatic constraint, 90° rotation,
  flips, vertical/horizontal keystone.
- Live histogram with clipping indicators, clipping overlay (J), before/after split and
  side-by-side (5 / Y / \), zoom Fit/1:1/2:1 (1/2/3), wheel zoom, pan (drag or Space).
- History with gesture grouping and merging, History panel, undo/redo (Ctrl+Z / Ctrl+Shift+Z).
- Snapshots, presets (built-in + user, amount slider, JSON import/export), copy/paste
  (Ctrl+Shift+C / Ctrl+Shift+V), sync to selected photos, reset.
- Draft-resolution rendering while dragging, full resolution on release.
- Library thumbnails and previews re-rendered from the recipe after edits.
- Export JPEG/PNG/WebP with resizing, quality, JPEG background for transparency, EXIF metadata,
  folder destination on Chromium.

Known limitations:
- Automatic chromatic-aberration removal and lens profiles are not implemented yet (no
  controls are shown for them).
- Zoomed-in views render the whole image at the zoom resolution; region-of-interest
  rendering is planned (Stage 9).
- Recipes pasted or synced onto photos that are not open keep their old thumbnails until
  the photo is opened in Develop.
- Exports are 8-bit sRGB; 16-bit TIFF export is planned (Stage 10).

## Stage 3 — Masks

Done:
- Masks are recipe data: ordered components with Add / Subtract / Intersect, per-component
  invert and opacity, mask-level invert, amount and visibility. Coordinates live in the
  oriented source, so masks survive crops, rotation and any preview size.
- Components: brush (strokes with size, feather, flow, density, pressure; paint/erase),
  linear gradient, radial gradient (feather, handles), luminance range, color range
  (up to 5 samples, refine), and AI rasters (Stage 4).
- Brush coverage is rasterized on the GPU with instanced dabs in source space and cached;
  while painting only the newest stroke is redrawn.
- Local adjustments per mask: temperature, tint, exposure, contrast, highlights, shadows,
  whites, blacks, texture, clarity, dehaze, hue, saturation.
- Red overlay (O) or black & white coverage view of the edited mask; handles on canvas;
  Masks tool (M), Brush (B), brush size with [ and ].

## Stage 4 — Local AI

Done:
- An AI worker (Transformers.js + ONNX Runtime Web), created on first use, WebGPU with
  WASM fallback; ONNX Runtime's WASM is served from the app's own origin.
- Select Subject / Background: BiRefNet Lite (best), MODNet (fast) or the bundled
  U²-Netp (offline). If the Hub is unreachable, the bundled model is used automatically.
- Select Sky and Select People: DETR panoptic segmentation classes.
- Select Object: SlimSAM with positive clicks and Alt-click exclusions; the image
  embedding is computed once per photo and reused for every click.
- Every AI result is edge-refined with a guided filter against the photo, stored as a
  coverage raster in IndexedDB, and used as a mask component with live Feather and
  Shift edge (contract/expand) controls — combinable with brushes and gradients.
- Remove Background: an AI subject mask marked as the photo's transparency ("cutout").
  Add a brush to restore, subtract one to erase; PNG/WebP exports and Library
  thumbnails keep the transparency, JPEG flattens onto a chosen color.

Verified in this repository's test environment: the offline U²-Netp path end to end
(detect → refine → mask → transparency → display). The BiRefNet, MODNet, DETR and
SlimSAM paths use the documented Transformers.js APIs but could not be exercised here
because the sandbox blocks huggingface.co; they need a check in a normal browser.

Known limitations:
- No color decontamination at cutout edges yet (a thin fringe of the old background can
  remain on soft edges).
- Depth Range masks need a depth model and are not implemented.

## Stages 5 & 6 — Composite

Done:
- Documents: canvas size, background color or transparency, guides; autosaved to IndexedDB
  with thumbnails; open/delete from the Compositions panel.
- Layers: image (a library photo, live-developed with its recipe — including its cutout),
  solid fill, gradient (linear/radial, angle, scale, offset, up to 16 stops with opacity),
  text (font, size, weight, italic, color, alignment, line height, tracking), shapes
  (rectangle with corner radius, ellipse, fill, stroke), adjustment layers (exposure,
  tone, vibrance, saturation, B&W) and groups.
- Per layer: visibility, lock, opacity, fill opacity (Photoshop semantics for the special
  modes), 24 blend modes, clipping masks, transform (move, scale, rotate, flip, perspective),
  crop, editable layer masks (brush, linear, radial; add/subtract; invert; density).
- GPU compositing in premultiplied display space following the W3C spec; groups isolate.
- Tools: click-select topmost layer, drag handles, rotate knob, Ctrl-drag perspective,
  snapping to canvas, guides and other layers (Alt bypasses), rulers → guides, align and
  distribute, arrow-key nudging, drag photos from the filmstrip onto the canvas.
- Export PNG/WebP (with transparency) and JPEG (flattened onto a chosen color) at
  25–400 % (up to 8192 px on the long side), with a quality setting for JPEG and WebP.

Known limitations:
- Groups are always isolated (no "pass through"); layer styles (shadows, strokes on
  raster content) are not implemented.
- Text is a single style per layer (no per-character styling). 18 bundled fonts (sans,
  serif, display, neon, 3D, colour, script, handwriting, mono, pixel) plus system fonts.
- Animated text (typewriter, pop in, wave, bounce, rainbow, pulse, neon flicker, glitch)
  uses the composition's loop. Letters are placed one by one while animating, so kerning
  pairs are not applied, and letters that move past the layer's box are clipped.
- Image layers render at up to 4096 px per layer; exports cap at 8192 px on the long side.

## Effects

Done:
- 48 original GLSL effects in ten categories: Light & glass, Type & code, Halftone & dither,
  Textile & craft, Pixel & 3D, Edges & outlines, Analog & glitch, Experimental,
  Tracking & interface, and Motion. Every parameter is real: the GPU reads each one.
- 19 animated effects. Motion adds Snowfall, Rain, Sparkles, Film Grain & Flicker, Light
  Leaks, Bokeh Float, Heat & Water, Color Cycle, Camera Motion and Confetti. Code Rain,
  CRT, VHS, Datamosh Glitch, Kaleidoscope, Liquid Warp, Aura Gradient, Tracking HUD and
  Night Vision now move too. They all loop seamlessly over the composition's loop (1–10 s,
  6–30 fps, set in the effect's Loop section). They play live in the canvas (toolbar
  toggle) and in the video player. The browser has an **Animated** section and badges.
- Composition export: **GIF** (one shared palette, optional dithering, up to 1600 px),
  **MP4** (the loop played 1–10 times, up to 3840 px), or PNG/JPEG/WebP of the frame at a
  chosen time. The progress bar counts frames, and the watermark and destinations work
  as for stills.
- Effect layers in Composite. Each is non-destructive and applies to everything below it,
  or only to its clipping base. It has opacity, fill, a blend mode and a layer mask, and
  it is saved in documents and `.focused` files with sanitized parameters.
- Sizes are in 1/1000 of the document's long side, so the canvas, the previews and a 400 %
  export show the same number of cells, dots and lines.
- Effects browser: categories with counts, search, grid and list views, and live previews
  rendered on the GPU from the layers the effect will sit on. It can add a new layer or
  swap the effect on an existing one.
- Entry points: Composite toolbar and **Shift+E**, the **+ Layer** menu, Develop's
  **Effects…** button, and Library's **Apply an Effect…** context-menu item.

Known limitations:
- GIF is limited to 256 colours per file (shared across frames) and has no partial
  transparency; transparent areas are flattened onto the chosen background.
- Animation runs on one clock per composition. Effects cannot be keyframed individually.
- Text effects use the platform's monospace font. Katakana in Code Rain needs a font that
  has those glyphs; otherwise the browser falls back.

## Video

Done:
- Video workspace with a clip list stored locally (IndexedDB `videos` and `videoFiles`).
  MP4, M4V and MOV files dropped anywhere, or picked through Import, are routed there.
- Editor with a frame-accurate viewer and a zoomable timeline: thumbnails, a soundtrack
  waveform, and a ruler and waveform you can scrub, with sound. It has play, pause and
  loop, frame stepping, J/K/L, and Home/End. Zoom with the − / Fit / + buttons, +/−/0 or
  Ctrl+scroll (around the playhead, down to about 24 px per frame).
- Segments: split at the playhead (S), delete, duplicate, copy/cut/paste, drag to
  reorder, trim either edge, and insert any other imported clip at the playhead. This
  makes sentence mixing across sources possible.
- Per-segment YTP treatments, each one click ("poopisms") or a fine slider:
  - Timing: stutter, reverse, dance (ping-pong), stare down (freeze and zoom), speed
    (chipmunk / slow-mo, or pitch-preserving).
  - Sound: pitch up/down, ear rape, sus (harmonizer), echo, reverb, chorus, vibrato,
    bitcrush, volume and mute.
  - Picture: mirror, flip, invert, hue and rainbow, zoom, shake, deep fry, and any
    library effect.
  - Generators: random poop (YTP+ style random treatments) and chop & shuffle (random
    sentence mixing).
- A whole-video effect from the library, also saved and applied by Looks.
- Export with no dropped frames, checked at the end:
  - Lossless master (MKV): lossless VP9 plus uncompressed audio.
  - Lossless video (MP4): lossless VP9 plus AAC 320k / Opus 510k.
  - Compatible (MP4, H.264, near-lossless).
  - Untreated frames come out bit-identical to the source. An untouched clip exported as
    MP4 is copied sample for sample.
- Edits have undo/redo, save automatically, survive a reload, and older trims migrate.

Known limitations:
- Needs WebCodecs: current Chrome, Edge and Firefox (lossless VP9 encoding), and Safari
  for the Compatible format. HEVC (the iPhone default) decodes only where the browser and
  OS support it.
- Lossless files are large (around 0.6 bytes per pixel per frame). The Compatible format
  is for sharing.
- Non-integer frame rates (29.97, 28.96…) are kept exactly: the MP4 time base is chosen
  so each frame lasts a whole number of ticks.
- The output frame rate is the clip's average rate. Variable-frame-rate phone clips play
  each frame for an equal time (none are dropped), so their timing can shift by a few
  milliseconds.
- The preview shows the last decoded frame if decoding falls behind on a slow machine.
  Exports always render every frame.
- One video track: there are no overlays, picture-in-picture or transitions yet. Sound
  is one track rendered from the segments, so there is no separate music track yet.
- The file is read into memory for export. Very long 4K recordings may run out of memory.

## Looks

Done:
- A look (`core/looks/look.ts`) holds any subset of: develop groups (masks optional,
  crop optional), the non-photo layers of a composition (effects, adjustments, text,
  gradients, fills, shapes, groups, with their masks and blend modes, stored relative to
  the canvas), and a video effect with its strength.
- Save from Develop, Composite or Video (**Looks…** in each toolbar). Apply to the
  selected photos in Library (develop settings, plus a new composition per photo with the
  look's layers), to the open photo, to the open composition (layers added on top,
  develop settings applied to its photos) or to the open video.
- AI mask components store what they selected, not another photo's pixels. On apply,
  they run the same selection (subject, background, sky, people, or object from the
  stored points) on each photo. Components that fail are dropped, never reused.
- Looks are stored in IndexedDB (`looks`, schema v3). They download as `.focused` files
  (a ZIP with `look.json`) and import through Looks → Import, Composite → Open .focused…,
  or by dropping the file on the window. Project files still open as projects.

Limits: brush and gradient mask positions are relative to the frame, so they land in the
same place on a differently framed photo. Spot-removal circles are not included, since
they are photo-specific.

## Export and feedback

- Photo, composition and video exports share one set of controls
  (`features/export/ExportParts.tsx`):
  - a checklist to choose several items;
  - a destination: Downloads, one ZIP, or a folder via the File System Access API
    (Chrome/Edge);
  - a watermark (`core/export/watermark.ts`): text, seven font families, bold/italic,
    color, size and margin relative to the short side, opacity, shadow, nine positions
    or tiled. For video it is burned into every frame.
  - a progress bar with Stop.
- File names never collide within one export run.

- Every dialog keeps its action buttons pinned and visible, and scrolls its content in
  short windows. Library has an **Export…** button, a context-menu item and
  **Ctrl+Shift+E**. They open the shared export dialog, which also serves Develop.
- Exports are checked. A full-size photo or composition export is compared, on a coarse
  grid of block averages, with a 512 px reference render (`core/gpu/verify.ts`). If the
  GPU ran out of memory or returned stale pixels, the result differs. GPU caches are then
  freed and the render retried once; a second failure shows an error instead of saving a
  broken file. Idle render targets are kept only within a 320 MB budget, so large exports
  no longer pin GPU memory.
- A 2 px activity line along the top edge shows whenever work runs: renders, decoding,
  AI, imports, exports, previews and library changes. It completes and fades out after
  at least about 0.3 s, so instant changes still register.

## Stage 7 — Retouching

Done: Develop spot removal (heal and clone) as recipe data with automatic source search,
manual Alt-drag sources and draggable circles; Dodge/Burn brush masks.
Not done: pixel painting tools in Composite (clone stamp, smudge, blur/sharpen brushes),
content-aware fill.

## Stage 8 — Presets, sync, snapshots, projects

Done: presets with amount and JSON import/export, copy/paste/sync of setting groups,
named snapshots, `.focused` project files (document + recipes + AI rasters, optional
originals; reopening relinks by fingerprint or imports the included originals).

## Stages 9 & 10 — Not started

- WebGPU backend, tiled full-resolution export beyond 8192 px, region-of-interest
  rendering at 1:1, background thumbnail regeneration for synced photos.
- PSD import/export, 16-bit TIFF export, embedded ICC profiles in exports.
- Tauri desktop packaging.

## Tests

- `npm test` — unit tests: history, library queries, geometry and brush dabs, white balance
  colorimetry, EXIF writer, raster ops (guided filter), document operations, heal source search,
  effect registry/parameter sanitizing/effect layers.
- `npm run e2e` — Playwright in Chromium: Library → Develop → reload persistence; a brush
  mask; composite with an AI cutout (bundled model) and PNG export; effects browser → effect
  layer → edit, swap, undo and export. Set `CHROMIUM_PATH` to use
  a preinstalled Chromium.
