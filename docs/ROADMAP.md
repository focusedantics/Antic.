# Roadmap and status

A control counts as implemented only when changing it changes the image correctly and
the result survives a reload.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Shell, Library, catalog, import, thumbnails, RAW previews | In progress |
| 2 | Develop renderer, adjustments, histogram, crop, before/after, recipes, presets | Planned |
| 3 | Mask engine: brush, linear, radial, range masks, per-mask adjustments | Planned |
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
