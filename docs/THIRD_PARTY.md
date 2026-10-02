# Third-party software and references

## Runtime dependencies

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| react, react-dom | 19.3.0 | MIT | UI |
| zustand | 5.0.15 | MIT | Vanilla stores for catalog, UI and editing sessions |
| idb | 8.0.3 | ISC | IndexedDB wrapper for the catalog |
| exifr | 7.1.3 | MIT | EXIF/TIFF/GPS/ICC metadata |
| @tanstack/react-virtual | 3.14.13 | MIT | Virtualized grid and filmstrip |
| libraw-wasm | 1.6.0 | ISC (wrapper) | Camera RAW decoding in a worker |
| ↳ LibRaw 0.22 (bundled WASM) | — | LGPL-2.1 **or** CDDL-1.0 (dual) | RAW decoding; distributed unmodified as a separate module |
| utif2 | 4.1.0 | MIT | TIFF decoding |
| fflate | 0.8.3 | MIT | ZIP containers for `.focused` project files |
| @huggingface/transformers | 4.3.0 (lazy) | Apache-2.0 | Local AI segmentation (loaded only when an AI tool is used) |
| ↳ onnxruntime-web | 1.31 (lazy) | MIT | Inference runtime (WebGPU / WASM); WASM served from our own origin |
| mp4box | 2.4.1 (lazy) | BSD-3-Clause | Demuxing MP4/MOV files for video export (tracks, samples, codec configuration) |
| mp4-muxer | 5.2.2 (lazy) | MIT | Writing the exported MP4 (video from WebCodecs, audio copied through) |
| @fontsource/* (18 families: Inter, Montserrat, Oswald, Playfair Display, DM Serif Display, Bebas Neue, Anton, Righteous, Monoton, Bungee Shade, Nabla, Lobster, Pacifico, Caveat, Permanent Marker, Space Mono, VT323, Press Start 2P) | 5.3.0 | SIL OFL 1.1 (Permanent Marker: Apache-2.0) | Fonts for text layers and watermarks (Latin subset, loaded on first use). OFL permits bundling with any software; the fonts are not sold on their own or renamed |
| webm-muxer | 5.1.4 | MIT | Writing the lossless Matroska (.mkv) video export (VP9 + PCM audio) |
| gifenc | 1.0.3 | MIT | LZW compression and GIF block writing for animated GIF export (palette building uses its quantizer; palette mapping and dithering are ours). Typings in `src/types/gifenc.d.ts` |

LibRaw is used under its CDDL-1.0 option. It is loaded as an unmodified, separately
distributed WebAssembly module, so application code is not affected by its terms. Its
license text ships in `node_modules/libraw-wasm` and must accompany redistributions.

### AI model weights (downloaded on first use, cached by the browser)

| Model | License | Use |
| --- | --- | --- |
| `onnx-community/BiRefNet_lite-ONNX` | MIT | Select Subject / Remove Background (quality) |
| `Xenova/modnet` | Apache-2.0 | Portrait matting (fast fallback) |
| `Xenova/slimsam-77-uniform` | Apache-2.0 | Click-to-select objects (SAM) |
| `Xenova/detr-resnet-50-panoptic` | Apache-2.0 | Select Sky and Select People (COCO panoptic classes) |
| U²-Netp (`public/models/u2netp/`, bundled) | Apache-2.0 | Offline Select Subject / Remove Background; fallback when the Hub is unreachable. Notice and license ship next to the file. |

`briaai/RMBG-1.4` is **not** used by default: its BRIA license is non-commercial. Model
choices are recorded in `src/core/ai/models.ts`; check a model's license before adding it.

## Development dependencies

vite (MIT), @vitejs/plugin-react (MIT), typescript (Apache-2.0), vitest (MIT),
@playwright/test (Apache-2.0), fake-indexeddb (Apache-2.0), @types/* (MIT).

## Code adapted from reference projects

| Source | License | What | Where |
| --- | --- | --- | --- |
| [OpenLight](https://github.com/roprgm/openlight) © 2026 roprgm | MIT | HEIF box parser for WebCodecs HEIC decoding | `src/core/image/heic.ts` |
| OpenLight | MIT | Fitted tone operators (exposure, white balance response, highlights, shadows, whites, blacks, contrast, vibrance) ported from WGSL to GLSL | `src/core/gpu/shaders/tone.glsl.ts` |
| OpenLight | MIT | Oklab-based color mixer approach and hue anchor angles | `src/core/gpu/shaders/mixer.glsl.ts` |
| Björn Ottosson, Oklab | Public domain | Oklab matrices | shaders |
| [Originkit](https://www.originkit.dev/) "Ribbon Glow 2" | MIT | Ribbon glow field and finish shaders, pointer swirl; reworked as a class with per-workspace looks | `src/features/backdrop/ribbon.ts` |
| [Vercel agent-skills](https://github.com/vercel-labs/agent-skills) | MIT | Agent skills vendored into `.claude/skills/` | `.claude/skills/` |

## Effects

All effect shaders in `src/core/effects/library/` were written for this project. The
look of the effects browser was inspired by screenshots of Ladybug.app. None of its code,
assets or effect implementations were available or used. Retro dither palettes use the
published color values of the PICO-8 (CC0 palette), Game Boy (DMG) and CGA palettes. The
toy-brick palette is a generic set of plastic colors and uses no trademarks. Glyph atlases
are drawn at runtime with the platform's monospace font, so no font files are bundled.

## Studied for architecture only (no code copied)

- **OpenShop** (MIT) — layered document, adjustment layers, local AI tool set.
- **Pikado** (MIT) — copy-on-write layer buffers, compact tiles, blend-mode math,
  selection model, history contract.
- **raw-viewer** (no license file) — LibRaw settings for linear 16-bit output,
  decoder fallback chain (LibRaw → embedded preview). Ideas only.
- **WebSAM**, **Maskify**, **AlphaVeil** (no license files) — worker-based
  segmentation, SAM prompt handling, model catalog and GPU/WASM fallback. Ideas only.
- **Transformers.js** (Apache-2.0) — used as a dependency.
- **liquid-glass-js** (dashersw, MIT), **liquid-logo** (collidingScopes, MIT) and
  **shadergradient** (ruucm, MIT) — the looks of edge refraction with rim light and
  frost, flowing metal over a shape, and noise-driven colour flow. Liquid Glass, Glass
  Blobs and Liquid Metal (`src/core/effects/library/liquid.ts`) are original shaders.
