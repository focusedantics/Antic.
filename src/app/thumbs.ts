import { useEffect, useState } from "react";
import { getThumb } from "@/core/catalog/db";
import type { Asset } from "@/core/catalog/types";
import { device } from "@/lib/device";

/**
 * Object-URL cache for thumbnails and previews. URLs are keyed by asset,
 * variant and thumbnail revision, and revoked when evicted, so scrolling
 * through thousands of photos keeps a bounded amount of decoded images alive.
 * Each variant has its own LRU: a 2560 px preview (about 1 MB, 26 MB once the
 * browser decodes it) is kept for the few photos in the loupe, Compare and Survey,
 * while hundreds of small thumbnails stay for scrolling.
 */
type Variant = "thumb" | "preview";
const LIMITS: Record<Variant, number> = device.lite ? { thumb: 500, preview: 16 } : { thumb: 1000, preview: 48 };
const caches: Record<Variant, Map<string, Promise<string | null>>> = { thumb: new Map(), preview: new Map() };
const urls = new Map<string, string>();

const keyOf = (id: string, variant: Variant, revision: number) => `${id}:${variant}:${revision}`;

function evict(variant: Variant) {
  const cache = caches[variant];
  while (cache.size > LIMITS[variant]) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    const url = urls.get(oldest);
    if (url) URL.revokeObjectURL(url);
    urls.delete(oldest);
  }
}

export function loadImageUrl(id: string, variant: Variant, revision: number): Promise<string | null> {
  const key = keyOf(id, variant, revision);
  const cache = caches[variant];
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const promise = getThumb(id).then((record) => {
    const blob = variant === "preview" ? (record?.preview ?? record?.thumb) : (record?.thumb ?? record?.preview);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.set(key, url);
    return url;
  });
  cache.set(key, promise);
  evict(variant);
  return promise;
}

/** Drops cached URLs of an asset, e.g. after its thumbnail was re-rendered. */
export function invalidateImage(id: string) {
  for (const cache of Object.values(caches))
    for (const key of [...cache.keys()]) {
      if (!key.startsWith(`${id}:`)) continue;
      cache.delete(key);
      const url = urls.get(key);
      if (url) URL.revokeObjectURL(url);
      urls.delete(key);
    }
}

export function useImageUrl(asset: Asset | undefined, variant: Variant) {
  const ready = asset?.thumbState === "ready";
  const id = asset?.id;
  const revision = asset?.thumbRevision ?? -1;
  const [state, setState] = useState<{ key: string; url: string | null } | null>(null);
  const key = id ? keyOf(id, variant, revision) : "";
  useEffect(() => {
    if (!id || !ready) return;
    let live = true;
    void loadImageUrl(id, variant, revision).then((url) => {
      if (live) setState({ key, url });
    });
    return () => {
      live = false;
    };
  }, [id, ready, variant, revision, key]);
  return state?.key === key ? state.url : null;
}
