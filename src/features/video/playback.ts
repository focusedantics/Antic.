import { createStore } from "zustand/vanilla";

/**
 * Playback state of the open clip, shared by the player, the trim controls and
 * keyboard shortcuts. The <video> element itself is registered here by the player.
 */
export const playback = createStore<{ time: number; playing: boolean }>(() => ({ time: 0, playing: false }));

let element: HTMLVideoElement | null = null;
export const setPlaybackElement = (el: HTMLVideoElement | null) => {
  element = el;
};
export const playbackElement = () => element;

export function seek(time: number) {
  if (!element) return;
  element.currentTime = Math.max(0, Math.min(time, element.duration || time));
  playback.setState({ time: element.currentTime });
}

export function togglePlay() {
  if (!element) return;
  if (element.paused) void element.play().catch(() => undefined);
  else element.pause();
}

export function stepFrames(frames: number, fps = 30) {
  if (!element) return;
  element.pause();
  seek(element.currentTime + frames / fps);
}

/** The frame on screen as a bitmap (for effect previews). */
export async function grabFrame(): Promise<ImageBitmap | null> {
  if (!element || element.readyState < 2) return null;
  try {
    return await createImageBitmap(element);
  } catch {
    return null;
  }
}

export function formatTime(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}
