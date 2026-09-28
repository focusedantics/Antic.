import { effectById } from "@/core/effects/registry";
import type { CompositeDocument, DocAnimation, Layer } from "./model";

export const DEFAULT_ANIMATION: DocAnimation = { duration: 3, fps: 15 };
export const ANIMATION_LIMITS = { duration: [1, 10], fps: [6, 30] } as const;

export const docAnimation = (doc: CompositeDocument): DocAnimation => doc.animation ?? DEFAULT_ANIMATION;

/** True when a visible effect or text layer (at any depth) moves over time. */
export function hasAnimatedLayers(layers: readonly Layer[]): boolean {
  return layers.some(
    (l) =>
      l.visible &&
      ((l.kind === "effect" && !!effectById(l.effect.id)?.animated) || (l.kind === "text" && !!l.style.motion && l.style.motion.kind !== "none") || (l.kind === "group" && hasAnimatedLayers(l.children))),
  );
}

export const isAnimated = (doc: CompositeDocument): boolean => hasAnimatedLayers(doc.layers);

/** Frame timestamps (seconds) covering one seamless loop: the last frame is one step short of the first. */
export function loopFrames(animation: DocAnimation): number[] {
  const count = Math.max(1, Math.round(animation.duration * animation.fps));
  return Array.from({ length: count }, (_, i) => (i * animation.duration) / count);
}
