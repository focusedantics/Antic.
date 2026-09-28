/**
 * Google Drive export with the narrow `drive.file` scope: Focused can only see
 * the files and the folder it creates. Sign-in uses Google's OAuth 2.0 token
 * flow in a popup that returns to /oauth-callback.html on this site, which
 * hands the token back through a BroadcastChannel (the page is cross-origin
 * isolated, so the popup can't talk to its opener directly).
 *
 * Requires a Google Cloud OAuth client ID in VITE_GOOGLE_CLIENT_ID; see docs/DEPLOYMENT.md.
 */
const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Focused exports";

export const driveConfigured = () => CLIENT_ID.length > 0;

let cached: { token: string; expires: number } | null = null;

export function authUrl(clientId: string, redirectUri: string, state: string) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    prompt: "select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Signs in (a popup; must be called from a click) and returns an access token. */
export function signIn(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return Promise.resolve(cached.token);
  if (!driveConfigured()) return Promise.reject(new Error("Google Drive isn't set up for this site yet."));
  const state = crypto.randomUUID();
  const popup = window.open(authUrl(CLIENT_ID, `${location.origin}/oauth-callback.html`, state), "focused-google", "width=520,height=640");
  if (!popup) return Promise.reject(new Error("The sign-in window was blocked. Allow popups for this site and try again."));
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel("focused-oauth");
    const timer = setTimeout(() => finish(new Error("Google sign-in timed out.")), 5 * 60_000);
    function finish(result: string | Error) {
      clearTimeout(timer);
      channel.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }
    channel.onmessage = (e: MessageEvent<{ state?: string; token?: string; expiresIn?: number; error?: string }>) => {
      if (e.data?.state !== state) return;
      if (e.data.error || !e.data.token) return finish(new Error(e.data.error === "access_denied" ? "Google sign-in was cancelled." : `Google sign-in failed (${e.data.error}).`));
      cached = { token: e.data.token, expires: Date.now() + (e.data.expiresIn ?? 3600) * 1000 };
      finish(e.data.token);
    };
  });
}

async function api(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (res.status === 401) {
    cached = null;
    throw new Error("Google Drive sign-in expired. Choose Google Drive again to reconnect.");
  }
  if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** The "Focused exports" folder in the user's Drive, created on first use. */
export async function exportFolder(token: string): Promise<{ id: string; name: string }> {
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = (await (await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`)).json()) as { files: { id: string; name: string }[] };
  if (found.files[0]) return found.files[0];
  const created = await api(token, "https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  return (await created.json()) as { id: string; name: string };
}

/** Resumable upload: works for large videos as well as photos. */
export async function uploadToDrive(token: string, folderId: string, name: string, blob: Blob) {
  const start = await api(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": blob.type || "application/octet-stream" },
    body: JSON.stringify({ name, parents: [folderId] }),
  });
  const session = start.headers.get("Location");
  if (!session) throw new Error("Google Drive didn't return an upload address.");
  await api(token, session, { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
}

export async function connectDrive() {
  const token = await signIn();
  const folder = await exportFolder(token);
  return { kind: "drive" as const, token, folderId: folder.id, folderName: folder.name };
}
