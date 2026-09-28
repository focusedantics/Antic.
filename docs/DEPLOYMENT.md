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

## Google Drive export (optional)

The "Google Drive" destination needs an OAuth client for your deployment. Without one,
the option is shown as "not set up on this site" and everything else works.

1. In Google Cloud Console, create or choose a project and enable the **Google Drive API**.
2. Under **APIs & Services → OAuth consent screen**, configure the app. Add yourself as a
   test user while the app is unverified. The only scope needed is
   `https://www.googleapis.com/auth/drive.file`, which gives access only to files the app
   creates.
3. Under **Credentials → Create credentials → OAuth client ID**, choose **Web application**:
   - Authorized JavaScript origins: `https://<your-app>.vercel.app`
   - Authorized redirect URIs: `https://<your-app>.vercel.app/oauth-callback.html`
4. In Vercel → Project → **Settings → Environment Variables**, add
   `VITE_GOOGLE_CLIENT_ID` = the client ID (it is public; there is no secret), then
   redeploy.

Exports then go to a "Focused exports" folder in your Drive. For local development, add
`http://localhost:5173` and `http://localhost:5173/oauth-callback.html` to the same client
and put the variable in `.env.local`.
