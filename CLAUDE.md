# Focused — guidance for coding agents

Focused is a local-first photography workstation (React + TypeScript + WebGL2/WebGPU)
with three workspaces that share one asset and document system: **Library**, **Develop**
and **Composite**. Read `docs/ARCHITECTURE.md` before changing core modules and keep it
true when a responsibility moves.
`docs/AGENT_GUIDE.md` is the field guide: how performance was measured and fixed, what
did not work and why. Read it before a performance task and add to it after one.

## Commands

- `npm run dev` — Vite dev server with COOP/COEP headers (needed for LibRaw threads).
- `npm run typecheck` — TypeScript for app and config files.
- `npm test` — Vitest unit tests (`tests/*.test.ts`).
- `npm run build` — typecheck + production build.
- `npm run bench` — benchmarks (`bench/`); `smooth.bench.ts` times a person's actions.

## Rules that are easy to break

- Never write to an original. Originals are read through `core/catalog/originals.ts` only.
- Pixels never go into React state or zustand stores. Stores hold records and ids;
  images live in IndexedDB blobs, GPU textures or worker memory.
- Edits keep what they do not touch identical: map over layers with `mapTree`
  (`core/document/operations.ts`), never `layers.map((l) => ({ ...l }))`. The renderer
  reuses what it drew of unchanged layer objects; a rebuilt layer is a full redraw.
- Every edit is data: develop recipes (`core/develop/recipe.ts`) and composite documents
  (`core/document`). A control is not done until changing it changes the render and
  survives a reload. Do not add controls that do nothing.
- Anything that parses untrusted input (paste, presets, project files, IndexedDB) goes
  through the sanitizers (`sanitizeRecipe`, `sanitizeDocument`).
- Heavy work (decoding, thumbnails, AI) runs in workers; AI models load only on first use.
- After editing a source file, restart the dev server before running e2e tests or probes
  that `import("/src/…")` in the page: Vite serves a changed module under a new URL, and
  the test gets a second, empty copy of its stores.
- Animations for work of unknown length (exports, AI, decoding, imports) follow
  `lib/pacing.ts`: show the working state within a frame (`nextPaint()` before heavy
  synchronous work), keep it up at least `PACE.minWorking` and end with a short done beat
  so quick runs still read, loop and report a stage or percentage so long runs never look
  frozen, and honour `prefers-reduced-motion`. Test both a quick and a slow run.
- Computers keep the three-column layout; phones get `app/Shell.tsx`'s compact layout
  and `lib/device.ts` limits. New UI goes inside the shell's panels or toolbars so both
  work; check it at 390 × 664 as well as on a computer.
- File pickers go through `lib/files.ts` (`chooseFiles`, `pickerAccept`): a detached
  `<input type=file>` never delivers on iPhone.
- Dependencies must be MIT/Apache-2.0/ISC/BSD-compatible. Record every new one, with its
  license, in `docs/THIRD_PARTY.md`. Code adapted from a reference repository carries an
  attribution comment naming the project, its license and what was changed.

## Skills

`.claude/skills/` vendors Vercel's agent skills (MIT): `react-best-practices`,
`composition-patterns`, `web-design-guidelines`, `react-view-transitions`. Consult
`react-best-practices` when writing React and `web-design-guidelines` when reviewing UI.
