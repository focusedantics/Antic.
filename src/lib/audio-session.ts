import { appleTouch } from "./device";

/**
 * Lets the video's sound play on an iPhone with the ring/silent switch on silent.
 *
 * The edited soundtrack plays through Web Audio, which iOS treats as "ambient" sound
 * and silences with the switch, unlike a plain <video>. Safari 16.4+ exposes the
 * Audio Session API: the "playback" type makes the page behave like a music or video
 * app. Older iOS has no API, but an <audio> element playing (here, silence) moves the
 * page into the playback category too, so it runs while the video plays.
 *
 * Call it from the gesture that starts playback (play, scrub); `endPlayback` stops the
 * silent element.
 */
type AudioSession = { type: string };

let silent: HTMLAudioElement | null = null;

export function playThroughSilentSwitch() {
  const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession;
  if (session) {
    try {
      if (session.type !== "playback") session.type = "playback";
    } catch {
      // Not allowed here: nothing else to do.
    }
    return;
  }
  if (!appleTouch()) return;
  silent ??= silentLoop();
  void silent.play().catch(() => {});
}

export function endPlayback() {
  silent?.pause();
}

/** A looping, inaudible WAV (0.1 s of silence). */
function silentLoop(): HTMLAudioElement {
  const rate = 8000;
  const samples = rate / 10;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); // 8-bit: silence is 128
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const el = new Audio(`data:audio/wav;base64,${btoa(binary)}`);
  el.loop = true;
  el.setAttribute("playsinline", "");
  return el;
}
