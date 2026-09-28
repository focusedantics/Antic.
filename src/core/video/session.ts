import { createStore } from "zustand/vanilla";
import { deleteVideo, getVideo, getVideoFile, listVideos, putVideo, type VideoRecord } from "@/core/catalog/db";
import { createHistory, type History } from "@/core/history/history";
import { track } from "@/lib/activity";
import { createId } from "@/lib/id";
import { defaultEdit, sanitizeEdit, type VideoEdit } from "./model";

export type Clip = {
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly createdAt: number;
  /** Object URL of the poster frame, if one was captured. */
  readonly poster: string | null;
};

export type VideoState = {
  readonly clips: readonly Clip[];
  readonly openId: string | null;
  /** Object URL of the open clip's file, for the <video> element. */
  readonly url: string | null;
  readonly edit: VideoEdit | null;
  readonly loading: boolean;
};

export const video = createStore<VideoState>(() => ({ clips: [], openId: null, url: null, edit: null, loading: false }));

let history: History<VideoEdit> | null = null;
let unsubscribe: (() => void) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const posterUrls = new Map<string, string>();
export const videoHistory = () => history;

function toClip(r: VideoRecord): Clip {
  let poster = posterUrls.get(r.id) ?? null;
  if (!poster && r.poster) {
    poster = URL.createObjectURL(r.poster);
    posterUrls.set(r.id, poster);
  }
  return { id: r.id, name: r.name, duration: r.duration, width: r.width, height: r.height, byteSize: r.byteSize, createdAt: r.createdAt, poster };
}

export async function refreshClips() {
  const records = await listVideos();
  video.setState({ clips: records.sort((a, b) => b.createdAt - a.createdAt).map(toClip) });
}

/** Reads duration, display size and a poster frame through a <video> element. */
function probe(file: Blob): Promise<{ duration: number; width: number; height: number; poster?: Blob }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    const done = (result: { duration: number; width: number; height: number; poster?: Blob } | Error) => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      el.load();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    el.onerror = () => done(new Error("This browser can't play this video format."));
    el.onloadedmetadata = () => {
      el.currentTime = Math.min(1, (el.duration || 0) * 0.1);
    };
    el.onseeked = async () => {
      const width = el.videoWidth;
      const height = el.videoHeight;
      let poster: Blob | undefined;
      try {
        const scale = Math.min(1, 480 / Math.max(width, height));
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
        canvas.getContext("2d")!.drawImage(el, 0, 0, canvas.width, canvas.height);
        poster = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
      } catch {
        // A poster is optional.
      }
      done({ duration: Number.isFinite(el.duration) ? el.duration : 0, width, height, poster });
    };
    el.src = url;
  });
}

/** Copies video files into local storage (the originals are never changed) and opens the first. */
export async function importVideos(files: readonly File[]): Promise<string[]> {
  const ids: string[] = [];
  const failures: string[] = [];
  await track(
    (async () => {
      for (const file of files) {
        try {
          const meta = await probe(file);
          const id = createId("vid");
          const now = Date.now();
          await putVideo(
            {
              id,
              name: file.name.replace(/\.[^.]+$/, ""),
              type: file.type || "video/mp4",
              byteSize: file.size,
              duration: meta.duration,
              width: meta.width,
              height: meta.height,
              createdAt: now,
              updatedAt: now,
              poster: meta.poster,
              edit: defaultEdit(meta.duration),
            },
            file,
          );
          ids.push(id);
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : error}`);
        }
      }
    })(),
  );
  await refreshClips();
  if (ids[0]) await openClip(ids[0]);
  if (failures.length) throw new Error(failures.join("\n"));
  return ids;
}

export async function openClip(id: string) {
  flushVideo();
  const record = await getVideo(id);
  const file = await getVideoFile(id);
  if (!record || !file) return;
  const previous = video.getState().url;
  if (previous) URL.revokeObjectURL(previous);
  unsubscribe?.();
  const edit = sanitizeEdit(record.edit, record.duration);
  history = createHistory(edit, { label: "Open" });
  const h = history;
  unsubscribe = h.subscribe(() => {
    video.setState({ edit: h.get() });
    scheduleSave();
  });
  video.setState({ openId: id, url: URL.createObjectURL(file), edit });
}

export async function openClipFile(id: string) {
  return getVideoFile(id);
}

export function closeClip() {
  flushVideo();
  const { url } = video.getState();
  if (url) URL.revokeObjectURL(url);
  unsubscribe?.();
  history = null;
  video.setState({ openId: null, url: null, edit: null });
}

export async function removeClip(id: string) {
  if (video.getState().openId === id) closeClip();
  await deleteVideo(id);
  const poster = posterUrls.get(id);
  if (poster) URL.revokeObjectURL(poster);
  posterUrls.delete(id);
  await refreshClips();
}

/** One undoable change to the open clip's edit. */
export function editVideo(label: string, change: (edit: VideoEdit) => VideoEdit) {
  if (!history) return;
  history.set(change(history.get()), label);
}
export const beginVideoGesture = (label: string) => history?.begin(label);
export const endVideoGesture = () => history?.commit();

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, 500);
}

async function save() {
  const { openId, edit } = video.getState();
  if (!openId || !edit) return;
  const record = await getVideo(openId);
  if (record) await putVideo({ ...record, edit, updatedAt: Date.now() });
}

export function flushVideo() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  void save();
}
