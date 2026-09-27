# Roadmap and status

A control counts as implemented only when changing it changes the image correctly and
the result survives a reload.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Shell, Library, catalog, import, thumbnails, RAW previews | Done |
| 2 | Develop renderer, adjustments, histogram, crop, before/after, recipes, presets | Done (see below) |
| 3 | Mask engine: brush, linear, radial, range masks, per-mask adjustments | Done (see below) |
| 4 | Local AI: Select Subject/Sky/Object, Remove Background | Planned |
| 5 | Composite document: layers, groups, transforms, opacity, blend modes, masks | Planned |
| 6 | Gradients, text, shapes | Planned |
| 7 | Retouching: healing, clone, dodge/burn | Planned |
| 8 | Presets, sync, snapshots, `.focused` project files | Planned |
| 9 | Performance: WebGPU backend, tiled export, region-of-interest rendering | Planned |
| 10 | PSD interoperability, advanced export | Planned |

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
