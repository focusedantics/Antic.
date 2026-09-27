# Focused

A local-first photography workstation in the browser: a **Library** for managing
photographs, a **Develop** workspace for non-destructive RAW development with
masking, and a **Composite** workspace for layered, Photoshop-style composition. All
three share one asset system, so a photo flows from import through development and
masking into a composition without ever being flattened, and originals are never
modified.

Everything runs on your machine: decoding in workers, rendering on the GPU, local AI
models in the browser. Photos are not uploaded anywhere.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
```

The dev server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Camera RAW decoding (LibRaw, a
multithreaded WebAssembly build) needs them, so any production host must send them too.

```sh
npm test          # unit tests
npm run typecheck
npm run build
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — the data model, pipeline and module rules.
- [Roadmap and status](docs/ROADMAP.md) — what works today, stage by stage.
- [Third-party software](docs/THIRD_PARTY.md) — dependencies, licenses and reference projects.

## License

MIT for Focused's own code. See `docs/THIRD_PARTY.md` for dependencies.
