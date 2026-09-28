# Deployment

Focused is a static site (`npm run build` → `dist/`). The host must send these headers on
every response. They make the page cross-origin isolated, which the multithreaded LibRaw
WebAssembly build needs for RAW decoding:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Vercel

`vercel.json` sets the headers, the build command and the output directory. Import the
repository in Vercel with the **Vite** preset, keep the root directory `./` and deploy.
Pushes to the production branch redeploy automatically; other branches get preview URLs.

## Other hosts

- **Netlify / Cloudflare Pages:** add the two headers in a `_headers` file (`/*`).
- **GitHub Pages** cannot set response headers. It needs a service-worker shim such as
  `coi-serviceworker`, which is not included.

To check a deployment, open the browser console and run `crossOriginIsolated`. It must
print `true`.
