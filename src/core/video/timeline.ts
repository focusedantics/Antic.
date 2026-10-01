import { createId } from "@/lib/id";
import { isPlainSegment, type Segment, type VideoEdit } from "./model";

/**
 * The timeline compiler: turns an edit's segments into "pieces" (contiguous
 * plays of a source range at a rate, forwards or backwards, or a held frame)
 * and maps every output frame to exactly one source frame.
 *
 * Output frames are counted with cumulative rounding, so pieces never overlap
 * or leave gaps; at speed 1 and the clip's own frame rate a segment emits each
 * of its source frames exactly once — nothing dropped, nothing doubled. Audio
 * uses the same pieces (see dsp.ts), so sound and picture cannot drift.
 */

/** What the engine knows about a source clip (from its file). */
export type ClipInfo = {
  readonly fps: number;
  /** Number of frames (video samples). */
  readonly frames: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
};

export type Piece = {
  /** Index into the edit's segments. */
  readonly segment: number;
  /** Resolved source clip id. */
  readonly clip: string;
  /**
   * Source frames: playback starts at `from` and moves towards `to`
   * (exclusive bound for forward pieces, inclusive for reverse ones);
   * `from === to` for a hold.
   */
  readonly from: number;
  readonly to: number;
  /** Source seconds per timeline second (the segment speed); 0 for holds. */
  readonly rate: number;
  /** For holds: the frame on screen. */
  readonly holdFrame: number;
  /** Timeline position, seconds and frames. */
  readonly start: number;
  readonly duration: number;
  readonly firstFrame: number;
  readonly frames: number;
};

export type SegmentSpan = { readonly start: number; readonly end: number; readonly firstFrame: number; readonly frames: number };

export type Plan = {
  readonly fps: number;
  readonly frames: number;
  readonly duration: number;
  readonly pieces: readonly Piece[];
  /** Timeline span of each segment (same order as the edit). */
  readonly spans: readonly SegmentSpan[];
};

/** Source frame range of a segment, snapped to whole frames of its clip. */
export function segmentFrames(s: Segment, info: ClipInfo): { first: number; end: number } {
  const last = Math.max(1, info.frames);
  const first = Math.min(last - 1, Math.max(0, Math.round(s.in * info.fps)));
  const end = Math.max(first + 1, Math.min(last, Math.round(s.out * info.fps)));
  return { first, end };
}

type Pass = { from: number; to: number; hold?: number; holdSeconds?: number };

/** A segment's playback program, in source frames. */
function passes(s: Segment, info: ClipInfo): Pass[] {
  const { first, end } = segmentFrames(s, info);
  // Forward passes run [a, b); reverse passes start at b and end at a.
  const fwd = (a: number, b: number): Pass => ({ from: a, to: b });
  const rev = (a: number, b: number): Pass => ({ from: b, to: a });
  const main = s.reverse ? rev(first, end) : fwd(first, end);
  const out: Pass[] = [];
  const length = Math.max(1, Math.min(end - first, Math.round(s.stutterLength * info.fps)));
  for (let i = 1; i < s.stutter; i++) out.push(s.reverse ? rev(end - length, end) : fwd(first, first + length));
  out.push(main);
  let forward = !s.reverse;
  for (let i = 0; i < s.pingPong; i++) {
    forward = !forward;
    out.push(forward ? fwd(first, end) : rev(first, end));
  }
  if (s.hold > 0) {
    const last = out[out.length - 1];
    const shown = last.to > last.from ? last.to - 1 : last.to;
    out.push({ from: shown, to: shown, hold: shown, holdSeconds: s.hold });
  }
  return out;
}

/** Compiles an edit. `ownClip` resolves `clip: null`; `fps` is the output frame rate. */
export function compile(edit: VideoEdit, ownClip: string, infoOf: (clip: string) => ClipInfo | undefined, fps: number): Plan {
  const pieces: Piece[] = [];
  const spans: SegmentSpan[] = [];
  let time = 0;
  const frameAt = (t: number) => Math.round(t * fps + 1e-9);
  edit.segments.forEach((s, index) => {
    const clip = s.clip ?? ownClip;
    const info = infoOf(clip);
    const segStart = time;
    if (info && info.frames > 0 && info.fps > 0) {
      for (const p of passes(s, info)) {
        const duration = p.hold !== undefined ? p.holdSeconds! : Math.abs(p.to - p.from) / info.fps / s.speed;
        if (duration <= 0) continue;
        const firstFrame = frameAt(time);
        const frames = frameAt(time + duration) - firstFrame;
        pieces.push({ segment: index, clip, from: p.from, to: p.to, rate: p.hold !== undefined ? 0 : s.speed, holdFrame: p.hold ?? -1, start: time, duration, firstFrame, frames });
        time += duration;
      }
    }
    const firstFrame = frameAt(segStart);
    spans.push({ start: segStart, end: time, firstFrame, frames: frameAt(time) - firstFrame });
  });
  return { fps, frames: frameAt(time), duration: time, pieces, spans };
}

export type FrameRef = {
  readonly piece: Piece;
  readonly clip: string;
  /** Source frame index. */
  readonly frame: number;
  readonly segment: number;
  /** Seconds since the segment started on the timeline (drives animated treatments). */
  readonly local: number;
};

/** Index of the piece containing output frame `k` (binary search). */
export function pieceIndexAt(plan: Plan, k: number): number {
  let lo = 0;
  let hi = plan.pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (plan.pieces[mid].firstFrame <= k) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The source frame shown at output frame `k`, or null outside the timeline. */
export function frameAt(plan: Plan, k: number, infoOf: (clip: string) => ClipInfo | undefined): FrameRef | null {
  if (k < 0 || k >= plan.frames || !plan.pieces.length) return null;
  let i = pieceIndexAt(plan, k);
  // Skip pieces that round to zero frames.
  while (i < plan.pieces.length - 1 && plan.pieces[i].frames === 0) i++;
  const p = plan.pieces[i];
  const info = infoOf(p.clip);
  const local = k / plan.fps - plan.spans[p.segment].start;
  if (!info) return null;
  if (p.rate === 0) return { piece: p, clip: p.clip, frame: p.holdFrame, segment: p.segment, local };
  // Source frames advanced since the piece started.
  const advanced = ((k - p.firstFrame) * p.rate * info.fps) / plan.fps;
  const lo = Math.min(p.from, p.to);
  const hi = Math.max(p.from, p.to);
  const frame = p.to > p.from ? Math.floor(p.from + advanced + 1e-6) : Math.ceil(p.from - advanced - 1e-6) - 1;
  return { piece: p, clip: p.clip, frame: Math.min(hi - 1, Math.max(lo, frame)), segment: p.segment, local };
}

/** Index of the segment on screen at output frame `k` (the last one at the very end). */
export function segmentIndexAt(plan: Plan, k: number): number {
  if (!plan.spans.length) return -1;
  for (let i = 0; i < plan.spans.length; i++) if (k < plan.spans[i].firstFrame + plan.spans[i].frames) return i;
  return plan.spans.length - 1;
}

// ─── Edits (pure: each returns a new edit) ──────────────────────────────────

const withSegments = (edit: VideoEdit, segments: readonly Segment[]): VideoEdit => ({ ...edit, segments });

/**
 * Cuts the segment under output frame `k` in two at that point (a split in a
 * stutter, ping-pong or hold of a segment cuts its main pass instead).
 * Returns the new edit and the id of the right-hand part, or null when there
 * is nothing to cut there.
 */
export function splitAt(edit: VideoEdit, plan: Plan, k: number, infoOf: (clip: string) => ClipInfo | undefined): { edit: VideoEdit; id: string } | null {
  const ref = frameAt(plan, k, infoOf);
  if (!ref) return null;
  const s = edit.segments[ref.segment];
  const info = infoOf(ref.clip);
  if (!info) return null;
  const { first, end } = segmentFrames(s, info);
  // The source frame where the right part starts (in playback direction).
  const cut = s.reverse ? ref.frame + 1 : ref.frame;
  if (cut <= first || cut >= end) return null;
  const t = cut / info.fps;
  const a: Segment = s.reverse ? { ...s, in: t, pingPong: 0, hold: 0 } : { ...s, out: t, pingPong: 0, hold: 0 };
  const b: Segment = s.reverse ? { ...s, id: createId("seg"), out: t, stutter: 1 } : { ...s, id: createId("seg"), in: t, stutter: 1 };
  const segments = [...edit.segments];
  segments.splice(ref.segment, 1, a, b);
  return { edit: withSegments(edit, segments), id: b.id };
}

export function removeSegments(edit: VideoEdit, ids: ReadonlySet<string>): VideoEdit {
  return withSegments(
    edit,
    edit.segments.filter((s) => !ids.has(s.id)),
  );
}

/** Copies of the given segments, each placed right after the last of them. Returns the new ids. */
export function duplicateSegments(edit: VideoEdit, ids: ReadonlySet<string>): { edit: VideoEdit; ids: string[] } {
  const picked = edit.segments.filter((s) => ids.has(s.id));
  if (!picked.length) return { edit, ids: [] };
  const copies = picked.map((s) => ({ ...s, id: createId("seg") }));
  const last = Math.max(...picked.map((s) => edit.segments.indexOf(s)));
  const segments = [...edit.segments];
  segments.splice(last + 1, 0, ...copies);
  return { edit: withSegments(edit, segments), ids: copies.map((c) => c.id) };
}

/** Inserts copies of `segments` (fresh ids) before index `at`. */
export function insertSegments(edit: VideoEdit, at: number, segments: readonly Segment[]): { edit: VideoEdit; ids: string[] } {
  const copies = segments.map((s) => ({ ...s, id: createId("seg") }));
  const list = [...edit.segments];
  list.splice(Math.max(0, Math.min(list.length, at)), 0, ...copies);
  return { edit: withSegments(edit, list), ids: copies.map((c) => c.id) };
}

/** Moves the given segments (keeping their order) so they start at index `to` of the remaining list. */
export function moveSegments(edit: VideoEdit, ids: ReadonlySet<string>, to: number): VideoEdit {
  const moving = edit.segments.filter((s) => ids.has(s.id));
  if (!moving.length) return edit;
  const rest = edit.segments.filter((s) => !ids.has(s.id));
  const at = Math.max(0, Math.min(rest.length, to));
  return withSegments(edit, [...rest.slice(0, at), ...moving, ...rest.slice(at)]);
}

export function updateSegments(edit: VideoEdit, ids: ReadonlySet<string>, change: (s: Segment) => Segment): VideoEdit {
  return withSegments(
    edit,
    edit.segments.map((s) => (ids.has(s.id) ? change(s) : s)),
  );
}

/** True when the edit is exactly one untouched segment covering its whole own clip. */
export function isUntouched(edit: VideoEdit, info: ClipInfo): boolean {
  if (edit.segments.length !== 1 || (edit.effect && edit.effectMix > 0)) return false;
  const s = edit.segments[0];
  if (s.clip !== null) return false;
  const { first, end } = segmentFrames(s, info);
  return first === 0 && end >= info.frames && isPlainSegment(s);
}
