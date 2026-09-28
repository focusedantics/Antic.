import type { DemuxedVideo } from "./demux";

const MICRO = 1e6;

/**
 * Frames for live playback, decoded with WebCodecs in step with a clock (the
 * <video> element's currentTime, which also plays the audio).
 *
 * Reading frames back from a playing <video> (drawImage / texImage2D) is not
 * reliable everywhere: some browsers and GPUs keep returning the frame from
 * when playback started. Decoding the samples ourselves always yields the
 * right frame, and it is the same path export uses.
 */
export class PreviewDecoder {
  private readonly decoder: VideoDecoder;
  /** Decoded frames not shown yet, in presentation order. */
  private queue: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  /** Next sample to decode. */
  private next = 0;
  /** Sample presentation times (µs, shifted so the first frame is 0). */
  private readonly times: number[];
  private failed = false;
  /** Where the last seek aimed (µs); decoding catches up to it from a keyframe. */
  private target = 0;

  private constructor(private readonly video: DemuxedVideo) {
    const ts = video.track.timescale;
    const raw = video.samples.map((s) => (s.cts / ts) * MICRO);
    const first = raw.reduce((m, t) => Math.min(m, t), Infinity);
    this.times = raw.map((t) => t - first);
    this.decoder = new VideoDecoder({
      output: (frame) => this.insert(frame),
      error: () => {
        this.failed = true;
      },
    });
  }

  static async create(video: DemuxedVideo): Promise<PreviewDecoder | null> {
    if (typeof VideoDecoder === "undefined" || !video.samples.length) return null;
    try {
      if (!(await VideoDecoder.isConfigSupported(video.config)).supported) return null;
      return new PreviewDecoder(video);
    } catch {
      return null;
    }
  }

  get rotation() {
    return this.video.rotation;
  }

  /** True once decoding failed; the caller falls back to drawing the <video>. */
  get broken() {
    return this.failed;
  }

  /** Restarts decoding from the keyframe at or before `seconds`. */
  seek(seconds: number) {
    const target = seconds * MICRO;
    this.target = target;
    this.dropFrames();
    try {
      // reset() discards pending output, so no stale frame arrives after this.
      if (this.decoder.state === "configured") this.decoder.reset();
      this.decoder.configure(this.video.config);
    } catch {
      this.failed = true;
      return;
    }
    let key = 0;
    for (let i = 0; i < this.video.samples.length && this.times[i] <= target + MICRO; i++) if (this.video.samples[i].is_sync && this.times[i] <= target) key = i;
    this.next = key;
  }

  private insert(frame: VideoFrame) {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].timestamp > frame.timestamp) i--;
    this.queue.splice(i, 0, frame);
    // Bound memory (hardware decoders have small frame pools): drop the oldest.
    while (this.queue.length > 10) this.queue.shift()!.close();
  }

  /**
   * The frame to show at `seconds` (null until one is decoded), keeping the
   * decoder fed about a second ahead. The frame stays valid until the next
   * call; do not close it.
   */
  frameAt(seconds: number): VideoFrame | null {
    if (this.failed || this.decoder.state !== "configured") return this.current;
    const t = seconds * MICRO;
    const fed = Math.max(this.target, this.next > 0 ? this.times[this.next - 1] : -Infinity);
    // A jump back (loop, seek) or far ahead: restart from a keyframe.
    if ((this.current && t < this.current.timestamp - MICRO / 10) || (this.next > 0 && t > fed + 2 * MICRO)) {
      this.seek(seconds);
      return null;
    }
    // Show the newest decoded frame whose time has come.
    while (this.queue.length && this.queue[0].timestamp <= t + 1000) {
      this.current?.close();
      this.current = this.queue.shift()!;
    }
    const horizon = t + MICRO;
    while (this.next < this.times.length && this.times[this.next] <= horizon && this.decoder.decodeQueueSize < 8 && this.queue.length < 8) {
      const i = this.next++;
      const s = this.video.samples[i];
      try {
        this.decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: this.times[i], duration: (s.duration / this.video.track.timescale) * MICRO, data: s.data! }));
      } catch {
        this.failed = true;
        break;
      }
    }
    return this.current;
  }

  private dropFrames() {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.current?.close();
    this.current = null;
  }

  dispose() {
    this.dropFrames();
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
