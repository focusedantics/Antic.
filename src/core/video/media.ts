import { getVideoFile } from "@/core/catalog/db";
import { type Demuxed, demux } from "./demux";
import type { ClipInfo } from "./timeline";

/** A source clip ready for the engine: its file, demuxed tracks and facts. */
export type ClipMedia = {
  readonly id: string;
  readonly file: Blob;
  readonly media: Demuxed;
  readonly info: ClipInfo;
};

const cache = new Map<string, Promise<ClipMedia | null>>();
const MAX = 6;

function infoOf(media: Demuxed): ClipInfo {
  const v = media.video;
  const rotated = v.rotation === 90 || v.rotation === 270;
  const w = v.config.codedWidth ?? 0;
  const h = v.config.codedHeight ?? 0;
  return { fps: v.fps, frames: v.samples.length, duration: v.samples.length / v.fps, width: rotated ? h : w, height: rotated ? w : h };
}

/** Loads (once) and demuxes a stored clip. Null when the file is missing or unreadable. */
export function loadClipMedia(id: string): Promise<ClipMedia | null> {
  let entry = cache.get(id);
  if (!entry) {
    entry = (async () => {
      const file = await getVideoFile(id);
      if (!file) return null;
      const media = await demux(file);
      return { id, file, media, info: infoOf(media) };
    })().catch(() => null);
    cache.set(id, entry);
    if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  } else {
    cache.delete(id);
    cache.set(id, entry);
  }
  return entry;
}

/** Forgets a clip (after it is removed). */
export function forgetClipMedia(id: string) {
  cache.delete(id);
}

/** Demuxes a file that isn't stored (tests, one-off exports). */
export async function mediaFromFile(id: string, file: Blob): Promise<ClipMedia> {
  const media = await demux(file);
  return { id, file, media, info: infoOf(media) };
}
