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
| @huggingface/transformers | 4.x (lazy) | Apache-2.0 | Local AI segmentation (loaded only when an AI tool is used) |

LibRaw is used under its CDDL-1.0 option. It is loaded as an unmodified, separately
distributed WebAssembly module, so application code is not affected by its terms. Its
license text ships in `node_modules/libraw-wasm` and must accompany redistributions.

### AI model weights (downloaded on first use, cached by the browser)

| Model | License | Use |
| --- | --- | --- |
| `onnx-community/BiRefNet_lite-ONNX` | MIT | Select Subject / Remove Background (quality) |
| `Xenova/modnet` | Apache-2.0 | Portrait matting (fast fallback) |
| `Xenova/slimsam-77-uniform` | Apache-2.0 | Click-to-select objects (SAM) |

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
| [Vercel agent-skills](https://github.com/vercel-labs/agent-skills) | MIT | Agent skills vendored into `.claude/skills/` | `.claude/skills/` |

## Studied for architecture only (no code copied)

- **OpenShop** (MIT) — layered document, adjustment layers, local AI tool set.
- **Pikado** (MIT) — copy-on-write layer buffers, compact tiles, blend-mode math,
  selection model, history contract.
- **raw-viewer** (no license file) — LibRaw settings for linear 16-bit output,
  decoder fallback chain (LibRaw → embedded preview). Ideas only.
- **WebSAM**, **Maskify**, **AlphaVeil** (no license files) — worker-based
  segmentation, SAM prompt handling, model catalog and GPU/WASM fallback. Ideas only.
- **Transformers.js** (Apache-2.0) — used as a dependency.
