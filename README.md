# Focused

A local-first photography workstation in the browser, with four workspaces that share
one asset system and one effects library:

- **Library**: import (files, folders, drag and drop), camera RAW, ratings, flags,
  color labels, keywords, collections, smart collections, search, filters, stacks, and
  Loupe/Compare/Survey views.
- **Develop**: non-destructive RAW development on the GPU, with white balance in Kelvin
  from the camera's As Shot values, tone, curves, color mixer, color grading, detail,
  lens corrections, crop, straighten and keystone, and effects. It also has masks
  (brush, gradients, luminance and color ranges, and local AI for subject, sky, people
  and objects), spot healing, presets, snapshots, history, and export.
- **Composite**: layered compositions of developed photos, gradients, text (18 bundled
  fonts, and animated text: typewriter, wave, bounce, neon flicker, glitch and more), shapes and
  adjustment layers, with 24 blend modes, clipping, layer masks, transforms with
  perspective, transparency, and `.focused` project files.
- **Effects**: 48 GPU stylization effects added as layers, 19 of them animated (snow, rain,
  sparkles, film flicker, light leaks, bokeh, heat haze, camera shake, confetti, moving
  code rain, VHS, glitch and more). Animated compositions export as a looping GIF or MP4,
  or as a still frame at any moment of the loop. The library also has ASCII and code
  rain, CMYK and one-ink halftone, retro dither palettes, risograph, engraving, cross
  stitch, knit, tile mosaic, paper cutout, toy bricks, iso cubes, LED wall, relief, ink
  drawing, neon edges, topographic contours, blueprint, pencil hatching, CRT, VHS,
  datamosh glitch, fluted glass, stained glass, halation, prism, aura gradient,
  kaleidoscope, liquid warp, a tracking HUD, thermal and night vision. You pick them from
  a browser with live previews of your own image. Every effect is editable and can be
  masked, blended and exported.
- **Looks**: save your edits as a reusable look: Develop settings, masks, effect, text
  and adjustment layers, and video effects. Apply it to many photos at once, to a
  composition or to a video, and share it as a `.focused` file. AI masks (subject, sky,
  people, objects) are detected again on each photo.
- **Export**: progress bars; pick several photos, compositions or videos; save to
  Downloads, one ZIP or a folder on your computer (Chrome/Edge); add a text watermark with font, size, opacity, color, shadow and
  one of nine positions, or tile it across the image.
- **Video**: import MP4/MOV clips; trim with handles on a frame strip; export at the
  original's quality by default, or lower the resolution, quality (bitrate) and frame rate; drop or keep the audio; apply any effect
  with a strength control; and export a new MP4 with a size estimate. Decoding, effects
  and encoding all run on your device with WebCodecs and the GPU.

A photo flows through all three without being flattened. Import a RAW, develop it,
remove its background with the local AI, place it over another photo, add a gradient,
set its opacity and blend mode, and export. Every step stays editable, and originals are
never modified.

Everything runs on your machine: decoding happens in workers, rendering on the GPU, and
AI models run in the browser. Photos are never uploaded.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
```

The dev server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Camera RAW decoding (LibRaw, a multithreaded
WebAssembly build) needs them, so a production host must send them too.

```sh
npm test          # unit tests
npm run e2e       # end-to-end tests in Chromium (CHROMIUM_PATH=… to use an installed browser)
npm run typecheck
npm run build
```

Chromium-based browsers get the most complete experience: File System Access allows
importing folders in place and exporting straight to a folder. Firefox and Safari work
with import-by-copy and download-based export.

## Keyboard

| Where | Keys |
| --- | --- |
| Everywhere | **G** Library grid · **E** Loupe · **N** Survey · **Shift+C** Compare · **D** Develop · **C** Composite · **←/→** previous/next photo · **P/X/U** pick/reject/unflag · **6–9** color labels · **Tab** hide panels · **Shift+F** filmstrip |
| Library | **0–5** rating · **Ctrl+A** select all · **Ctrl+G** stack · **Delete** remove |
| Develop | **1** fit · **2** 100 % · **3** 200 % · **5 / Y** cycle before/after · **\\** toggle before · **J** clipping · **R** crop · **M** masks · **B** brush mask · **Q** heal · **W** white balance selector · **Shift+U** auto white balance · **[ ]** brush size · **O** mask overlay · **Space** pan · **Ctrl+Z / Ctrl+Shift+Z** undo/redo · **Ctrl+Shift+C / V** copy/paste settings · **Ctrl+Shift+E** export |
| Video | **Space** play/pause · **I / O** set trim start/end at the playhead · **← / →** step a frame (Shift ×10) · **Home / End** jump to trim start/end · **Ctrl+Z** undo · **Ctrl+Shift+E** export |
| Library | **Ctrl+Shift+E** export the selected photos |
| Composite | **Shift+E** effects browser · **V** move · **1** fit · **2** 100 % · **arrows** nudge (Shift ×10) · **Ctrl+J** duplicate · **Ctrl+G / Ctrl+Shift+G** group/ungroup · **Ctrl+Alt+G** clipping mask · **Ctrl+[ ]** arrange · **Ctrl+;** guides · **Delete** delete layer · **Ctrl+Z** undo |

## Documentation

- [Architecture](docs/ARCHITECTURE.md): the data model, rendering pipeline and module rules.
- [Roadmap and status](docs/ROADMAP.md): what works today, stage by stage, with known limitations.
- [Third-party software](docs/THIRD_PARTY.md): dependencies, model licenses and reference projects.
- `CLAUDE.md`: guidance for coding agents working in this repository. `.claude/skills/`
  vendors Vercel's React and web-design skills.

## License

MIT for Focused's own code. See `docs/THIRD_PARTY.md` for dependencies and models.
