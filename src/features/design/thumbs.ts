import { useEffect, useState } from "react";
import { getDocument } from "@/core/catalog/db";

/**
 * Saved designs' thumbnails as object URLs, kept between visits to the Design home: each is
 * read from the database once per save (the key is the design and when it was saved), and
 * only for the tiles on screen. The oldest are let go past LIMIT.
 */
const LIMIT = 80;
const cache = new Map<string, { stamp: number; url: Promise<string | null> }>();

function thumbUrl(id: string, stamp: number): Promise<string | null> {
  const hit = cache.get(id);
  if (hit?.stamp === stamp) {
    // Most recently used last.
    cache.delete(id);
    cache.set(id, hit);
    return hit.url;
  }
  if (hit) void hit.url.then((u) => u && URL.revokeObjectURL(u));
  const url = getDocument(id)
    .then((r) => (r?.thumb ? URL.createObjectURL(r.thumb) : null))
    .catch(() => null);
  cache.delete(id);
  cache.set(id, { stamp, url });
  for (const [key, old] of cache) {
    if (cache.size <= LIMIT) break;
    cache.delete(key);
    void old.url.then((u) => u && URL.revokeObjectURL(u));
  }
  return url;
}

/** The thumbnail of design `id` as saved at `stamp`; null until read, or when it has none. */
export function useDesignThumb(id: string, stamp: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void thumbUrl(id, stamp).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [id, stamp]);
  return url;
}
