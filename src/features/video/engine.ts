import { createStore } from "zustand/vanilla";
import { type Channels, SAMPLE_RATE } from "@/core/video/dsp";
import { bitmapStore, FrameSource } from "@/core/video/frames";
import { type ClipMedia, loadClipMedia } from "@/core/video/media";
import type { VideoEdit } from "@/core/video/model";
import { VideoRenderer } from "@/core/video/renderer";
import { audioParts, decodeClipAudio, Soundtrack } from "@/core/video/soundtrack";
import { type ClipInfo, compile, frameAt, type Plan } from "@/core/video/timeline";

/**
 * The editor's playback engine. Pictures come from WebCodecs (frame-accurate,
 * forwards or backwards, any frame on demand); sound is the rendered
 * soundtrack played through Web Audio, whose clock drives the pictures. The
 * same timeline plan and soundtrack are used by export, so what you hear and
 * see here is what gets saved.
 *
 * Only numbers live in the store; frames stay in the frame sources and the
 * GPU (CLAUDE.md: pixels never go into stores).
 */
export type PlayerState = {
  readonly frame: number;
  readonly frames: number;
  readonly fps: number;
  readonly playing: boolean;
  readonly loop: boolean;
  /** Soundtrack: "rendering" while the worker works, "none" for silent timelines. */
  readonly audio: "loading" | "rendering" | "ready" | "none";
  /** Bumped when the soundtrack (waveform) changes. */
  readonly soundtrackVersion: number;
  readonly error: string | null;
};

export const player = createStore<PlayerState>(() => ({ frame: 0, frames: 0, fps: 30, playing: false, loop: true, audio: "loading", soundtrackVersion: 0, error: null }));

const PREVIEW_SIDE = 1280;
const THUMB_SIDE = 160;

class Engine {
  private ownId: string | null = null;
  private edit: VideoEdit | null = null;
  plan: Plan | null = null;
  private readonly clips = new Map<string, ClipMedia>();
  private readonly loading = new Map<string, Promise<ClipMedia | null>>();
  private readonly previews = new Map<string, FrameSource<ImageBitmap>>();
  private readonly thumbs = new Map<string, FrameSource<ImageBitmap>>();
  private soundtrack: Soundtrack | null = null;
  /** Each clip's audio, decoded once and handed to the worker: resolves to whether it has sound. */
  private readonly audioReady = new Map<string, Promise<boolean>>();
  private buffer: AudioBuffer | null = null;
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Playback clock: timeline seconds at `clockStart` (context or performance time). */
  private clockOffset = 0;
  private clockStart = 0;
  private raf = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderGeneration = 0;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: VideoRenderer | null = null;
  private drawGeneration = 0;
  private lastScrub = 0;
  /** Peaks of the soundtrack: min/max per 1/200 s, for the waveform. */
  peaks: { min: Float32Array; max: Float32Array; rate: number } | null = null;

  infoOf = (id: string): ClipInfo | undefined => this.clips.get(id)?.info;

  get fps() {
    return player.getState().fps;
  }

  /** Opens a clip's timeline. */
  async open(id: string, edit: VideoEdit) {
    this.close();
    this.ownId = id;
    this.soundtrack = new Soundtrack();
    player.setState({ frame: 0, frames: 0, playing: false, audio: "loading", error: null });
    const own = await this.ensureClip(id);
    if (this.ownId !== id) return;
    if (!own) {
      player.setState({ error: "This video can't be read. It may be damaged or in a format this browser can't decode." });
      return;
    }
    player.setState({ fps: own.info.fps });
    await this.setEdit(edit);
  }

  close() {
    this.pause();
    this.ownId = null;
    this.edit = null;
    this.plan = null;
    for (const s of this.previews.values()) s.dispose();
    for (const s of this.thumbs.values()) s.dispose();
    this.previews.clear();
    this.thumbs.clear();
    this.soundtrack?.dispose();
    this.soundtrack = null;
    this.audioReady.clear();
    this.buffer = null;
    this.peaks = null;
    this.clips.clear();
    this.loading.clear();
  }

  private ensureClip(id: string): Promise<ClipMedia | null> {
    const have = this.clips.get(id);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(id);
    if (!p) {
      p = loadClipMedia(id).then(async (m) => {
        if (!m) return null;
        if (typeof VideoDecoder !== "undefined" && !(await VideoDecoder.isConfigSupported(m.media.video.config).catch(() => ({ supported: false }))).supported) {
          player.setState({ error: `This browser can't decode ${m.media.video.config.codec} video. Try Chrome or Edge.` });
          return null;
        }
        this.clips.set(id, m);
        this.previews.set(id, new FrameSource(m.media.video, bitmapStore(PREVIEW_SIDE), 384 * 1024 * 1024));
        this.thumbs.set(id, new FrameSource(m.media.video, bitmapStore(THUMB_SIDE), 48 * 1024 * 1024));
        return m;
      });
      this.loading.set(id, p);
    }
    return p;
  }

  /** New timeline: recompiles, redraws and (debounced) re-renders the soundtrack. */
  async setEdit(edit: VideoEdit) {
    if (!this.ownId) return;
    this.edit = edit;
    const ids = new Set([this.ownId, ...edit.segments.flatMap((s) => (s.clip ? [s.clip] : []))]);
    await Promise.all([...ids].map((id) => this.ensureClip(id)));
    if (this.edit !== edit || !this.ownId) return;
    const plan = compile(edit, this.ownId, this.infoOf, this.fps);
    this.plan = plan;
    const frame = Math.min(player.getState().frame, Math.max(0, plan.frames - 1));
    player.setState({ frames: plan.frames, frame });
    this.draw();
    this.scheduleSoundtrack();
  }

  private scheduleSoundtrack() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.renderSoundtrack();
    }, 120);
  }

  private async renderSoundtrack() {
    const edit = this.edit;
    const plan = this.plan;
    const ownId = this.ownId;
    const soundtrack = this.soundtrack;
    if (!edit || !plan || !ownId || !soundtrack) return;
    const generation = ++this.renderGeneration;
    player.setState({ audio: this.buffer ? "rendering" : "loading" });
    // Decode the audio of clips the worker hasn't seen yet.
    let any = false;
    for (const id of new Set(plan.pieces.map((p) => p.clip))) {
      const m = this.clips.get(id);
      if (!m) continue;
      let ready = this.audioReady.get(id);
      if (!ready) {
        ready = (async () => {
          const audio = m.media.audio ? await decodeClipAudio(m.file) : null;
          if (this.soundtrack === soundtrack) soundtrack.setSource(id, audio);
          return !!audio;
        })();
        this.audioReady.set(id, ready);
      }
      any = (await ready) || any;
      if (this.soundtrack !== soundtrack) return;
    }
    if (!any) {
      this.buffer = null;
      this.peaks = null;
      player.setState((s) => ({ audio: "none", soundtrackVersion: s.soundtrackVersion + 1 }));
      return;
    }
    let channels: Channels;
    try {
      channels = await soundtrack.render(audioParts(edit, plan, ownId, this.infoOf), plan.frames / plan.fps);
    } catch (error) {
      if (generation === this.renderGeneration) player.setState({ audio: "none", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (generation !== this.renderGeneration || this.soundtrack !== soundtrack) return;
    this.peaks = computePeaks(channels);
    const ctx = this.audio();
    const buffer = ctx.createBuffer(2, Math.max(1, channels[0].length), SAMPLE_RATE);
    channels.forEach((c, k) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, k));
    this.buffer = buffer;
    player.setState((s) => ({ audio: "ready", soundtrackVersion: s.soundtrackVersion + 1 }));
    // Keep playing with the new sound from the same spot.
    if (player.getState().playing) this.startSound(this.now());
  }

  private audio(): AudioContext {
    this.context ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    return this.context;
  }

  // ─── Viewer ───────────────────────────────────────────────────────────────

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    try {
      this.renderer = new VideoRenderer(canvas);
    } catch (error) {
      player.setState({ error: error instanceof Error ? error.message : String(error) });
    }
    this.draw();
  }

  detach() {
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
  }

  /** Redraws the current frame (after a resize, an edit or a seek). */
  draw() {
    const plan = this.plan;
    const renderer = this.renderer;
    const canvas = this.canvas;
    if (!plan || !renderer || !canvas || !this.ownId) return;
    const k = player.getState().frame;
    const ref = frameAt(plan, k, this.infoOf);
    const own = this.clips.get(this.ownId)!;
    // Letterbox the output frame in the canvas; render at the smaller of the two sizes.
    const scale = Math.min(canvas.width / own.info.width, canvas.height / own.info.height);
    const fw = Math.max(1, Math.round(own.info.width * scale));
    const fh = Math.max(1, Math.round(own.info.height * scale));
    const viewport = [Math.floor((canvas.width - fw) / 2), Math.floor((canvas.height - fh) / 2), fw, fh] as const;
    const work = Math.min(1, PREVIEW_SIDE / Math.max(fw, fh));
    const width = Math.max(2, Math.round(fw * work));
    const height = Math.max(2, Math.round(fh * work));
    if (!ref) {
      renderer.draw(null, { sourceWidth: 1, sourceHeight: 1, rotation: 0, width, height, viewport });
      return;
    }
    const source = this.previews.get(ref.clip);
    const media = this.clips.get(ref.clip);
    if (!source || !media) return;
    const paint = (bitmap: ImageBitmap) => {
      const seg = this.edit!.segments[ref.segment];
      const effects = [
        ...(seg.effect && seg.effectMix > 0 ? [{ effect: seg.effect, mix: seg.effectMix }] : []),
        ...(this.edit!.effect && this.edit!.effectMix > 0 ? [{ effect: this.edit!.effect, mix: this.edit!.effectMix }] : []),
      ];
      try {
        renderer.draw(bitmap, { sourceWidth: bitmap.width, sourceHeight: bitmap.height, rotation: media.media.video.rotation, width, height, visual: seg.visual, local: ref.local, time: k / plan.fps, effects, viewport });
      } catch (error) {
        player.setState({ error: error instanceof Error ? error.message : String(error) });
      }
    };
    const cached = source.peek(ref.frame);
    if (cached) {
      paint(cached);
      return;
    }
    // Not decoded yet: keep the last picture until it arrives (never block playback).
    const generation = ++this.drawGeneration;
    source
      .get(ref.frame)
      .then((bitmap) => {
        if (generation === this.drawGeneration && this.renderer === renderer) paint(bitmap);
      })
      .catch((error) => player.setState({ error: error instanceof Error ? error.message : String(error) }));
  }

  /** Decodes the frames the next `count` timeline frames will show, in order. */
  private prefetch(from: number, count: number) {
    const plan = this.plan;
    if (!plan) return;
    const wanted = new Map<string, number[]>();
    for (let k = from; k < Math.min(plan.frames, from + count); k++) {
      const ref = frameAt(plan, k, this.infoOf);
      if (!ref) continue;
      const list = wanted.get(ref.clip) ?? [];
      if (list[list.length - 1] !== ref.frame) list.push(ref.frame);
      wanted.set(ref.clip, list);
    }
    for (const [clip, frames] of wanted) this.previews.get(clip)?.prefetch(frames);
  }

  /** A small timeline thumbnail of output frame `k` (null until decoded; `onReady` fires once it is). */
  thumbnail(k: number, onReady: () => void): ImageBitmap | null {
    const plan = this.plan;
    if (!plan) return null;
    const ref = frameAt(plan, k, this.infoOf);
    if (!ref) return null;
    const source = this.thumbs.get(ref.clip);
    if (!source) return null;
    const hit = source.peek(ref.frame);
    if (hit) return hit;
    source.get(ref.frame).then(onReady, () => {});
    return null;
  }

  rotationOf(clip: string) {
    return this.clips.get(clip)?.media.video.rotation ?? 0;
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  private now(): number {
    const state = player.getState();
    if (!state.playing) return state.frame / state.fps;
    const clock = this.source && this.context ? this.context.currentTime : performance.now() / 1000;
    return this.clockOffset + (clock - this.clockStart);
  }

  private startSound(at: number) {
    this.stopSound();
    const buffer = this.buffer;
    if (buffer && at < buffer.duration) {
      const ctx = this.audio();
      void ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.start(0, at);
      this.source = node;
      this.clockStart = ctx.currentTime;
    } else {
      this.clockStart = performance.now() / 1000;
    }
    this.clockOffset = at;
  }

  private stopSound() {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // Already stopped.
    }
    this.source.disconnect();
    this.source = null;
  }

  play() {
    const state = player.getState();
    if (!this.plan || !state.frames) return;
    const start = state.frame >= state.frames - 1 ? 0 : state.frame;
    player.setState({ playing: true, frame: start });
    this.startSound(start / state.fps);
    this.prefetch(start, 24);
    const tick = () => {
      const s = player.getState();
      if (!s.playing) return;
      let k = Math.floor(this.now() * s.fps + 1e-6);
      if (k >= s.frames) {
        if (s.loop) {
          k = 0;
          this.startSound(0);
        } else {
          this.pause();
          player.setState({ frame: s.frames - 1 });
          this.draw();
          return;
        }
      }
      if (k !== s.frame) {
        player.setState({ frame: k });
        this.draw();
        if (k % 6 === 0) this.prefetch(k + 1, 24);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.stopSound();
    if (player.getState().playing) player.setState({ playing: false });
  }

  toggle() {
    if (player.getState().playing) this.pause();
    else this.play();
  }

  /** Moves the playhead to output frame `k`. */
  seek(k: number) {
    const s = player.getState();
    const frame = Math.max(0, Math.min(Math.max(0, s.frames - 1), Math.round(k)));
    player.setState({ frame });
    if (s.playing) this.startSound(frame / s.fps);
    this.draw();
  }

  /** Seek while dragging the playhead, with a short burst of sound at the new spot. */
  scrub(k: number) {
    this.seek(k);
    const buffer = this.buffer;
    const now = performance.now();
    if (!buffer || player.getState().playing || now - this.lastScrub < 45) return;
    this.lastScrub = now;
    const ctx = this.audio();
    void ctx.resume();
    const node = ctx.createBufferSource();
    const gain = ctx.createGain();
    node.buffer = buffer;
    node.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.9, t + 0.005);
    gain.gain.setValueAtTime(0.9, t + 0.055);
    gain.gain.linearRampToValueAtTime(0, t + 0.07);
    node.start(t, Math.min(buffer.duration - 0.08, Math.max(0, player.getState().frame / player.getState().fps)), 0.08);
  }

  step(frames: number) {
    this.pause();
    this.seek(player.getState().frame + frames);
  }

  /** Output frame 0 as a new small bitmap (the export marble's preview), from the timeline thumbnails. */
  async firstFrame(): Promise<ImageBitmap | null> {
    const plan = this.plan;
    if (!plan?.frames) return null;
    const ref = frameAt(plan, 0, this.infoOf);
    if (!ref) return null;
    const bitmap = await (this.thumbs.get(ref.clip) ?? this.previews.get(ref.clip))?.get(ref.frame);
    return bitmap ? createImageBitmap(bitmap) : null;
  }

  /** The current preview frame as a bitmap (effect browser previews). */
  async grab(): Promise<ImageBitmap | null> {
    const plan = this.plan;
    if (!plan) return null;
    const ref = frameAt(plan, player.getState().frame, this.infoOf);
    if (!ref) return null;
    const bitmap = await this.previews.get(ref.clip)?.get(ref.frame);
    return bitmap ? createImageBitmap(bitmap) : null;
  }
}

/** Min/max of the mixed-down soundtrack per 1/200 s. */
function computePeaks(channels: Channels) {
  const rate = 200;
  const per = SAMPLE_RATE / rate;
  const n = Math.ceil(channels[0].length / per);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(channels[0].length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      let v = 0;
      for (const c of channels) v += c[i];
      v /= channels.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, rate };
}

export const engine = new Engine();
