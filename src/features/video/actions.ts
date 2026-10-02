import { createStore } from "zustand/vanilla";
import { toast } from "@/app/state";
import { openMenu } from "@/components/Menu";
import { defaultAudioFx, defaultVisualFx, newSegment, type Segment } from "@/core/video/model";
import { editVideo, video } from "@/core/video/session";
import { duplicateSegments, frameAt, insertSegments, moveSegments, removeSegments, segmentIndexAt, splitAt, updateSegments } from "@/core/video/timeline";
import { engine, player } from "./engine";

/** Editor UI state: selected segments and clips, timeline zoom and the segment clipboard. */
export const editor = createStore<{ selection: readonly string[]; clipSelection: readonly string[]; zoom: number | null; clipboard: readonly Segment[] }>(() => ({
  selection: [],
  clipSelection: [],
  zoom: null,
  clipboard: [],
}));

export const selectedIds = () => new Set(editor.getState().selection);
export const select = (ids: readonly string[]) => editor.setState({ selection: ids });

/** The segments an action applies to: the selection, else the one under the playhead. */
export function targetIds(): Set<string> {
  const sel = selectedIds();
  if (sel.size) return sel;
  const { edit } = video.getState();
  const plan = engine.plan;
  if (!edit || !plan) return new Set();
  const i = segmentIndexAt(plan, player.getState().frame);
  return i >= 0 ? new Set([edit.segments[i].id]) : new Set();
}

/** One undoable change to the target segments. */
export function changeSegments(label: string, change: (s: Segment) => Segment, ids = targetIds()) {
  if (!ids.size) return;
  editVideo(label, (e) => updateSegments(e, ids, change));
}

/** Cuts the segment under the playhead there ("S"). */
export function splitAtPlayhead() {
  const { edit } = video.getState();
  const plan = engine.plan;
  if (!edit || !plan) return;
  const result = splitAt(edit, plan, player.getState().frame, engine.infoOf);
  if (!result) {
    toast("Move the playhead inside a segment (not on its first frame) to cut it there.");
    return;
  }
  editVideo("Split", () => result.edit);
  select([result.id]);
}

export function deleteSelected() {
  const ids = targetIds();
  if (!ids.size) return;
  editVideo(ids.size > 1 ? `Delete ${ids.size} segments` : "Delete segment", (e) => removeSegments(e, ids));
  select([]);
}

export function duplicateSelected() {
  const ids = targetIds();
  let made: string[] = [];
  editVideo("Duplicate", (e) => {
    const r = duplicateSegments(e, ids);
    made = r.ids;
    return r.edit;
  });
  if (made.length) select(made);
}

export function copySelected() {
  const { edit } = video.getState();
  const ids = targetIds();
  if (!edit || !ids.size) return;
  editor.setState({ clipboard: edit.segments.filter((s) => ids.has(s.id)) });
  toast(`Copied ${ids.size} segment${ids.size === 1 ? "" : "s"}.`);
}

export function cutSelected() {
  copySelected();
  deleteSelected();
}

/** Index where an insertion at the playhead goes: splitting the segment under it first when needed. */
function insertionIndex(): number {
  const { edit } = video.getState();
  const plan = engine.plan;
  if (!edit || !plan || !plan.frames) return edit?.segments.length ?? 0;
  const k = player.getState().frame;
  const i = segmentIndexAt(plan, k);
  if (i < 0) return edit.segments.length;
  const span = plan.spans[i];
  if (k <= span.firstFrame) return i;
  const split = splitAt(edit, plan, k, engine.infoOf);
  if (!split) return i + 1;
  editVideo("Split", () => split.edit);
  return i + 1;
}

export function pasteAtPlayhead() {
  const { clipboard } = editor.getState();
  if (!clipboard.length) return;
  const at = insertionIndex();
  let ids: string[] = [];
  editVideo("Paste", (e) => {
    const r = insertSegments(e, at, clipboard);
    ids = r.ids;
    return r.edit;
  });
  select(ids);
}

/** Inserts a whole clip (from the Videos list) at the playhead. */
export function insertClip(clipId: string, duration: number) {
  insertClips([{ id: clipId, duration }]);
}

/** Inserts whole clips at the playhead, in order, as one undo step. */
export function insertClips(clips: readonly { id: string; duration: number }[]) {
  const { openId } = video.getState();
  if (!openId || !clips.length) return;
  const at = insertionIndex();
  const segs = clips.map((c) => newSegment(c.id === openId ? null : c.id, 0, c.duration));
  let ids: string[] = [];
  editVideo(clips.length > 1 ? `Insert ${clips.length} clips` : "Insert clip", (e) => {
    const r = insertSegments(e, at, segs);
    ids = r.ids;
    return r.edit;
  });
  select(ids);
}

/** The segment menu (right-click, or after a right-click sweep): batch actions on the selection. */
export function segmentMenu(x: number, y: number) {
  const n = editor.getState().selection.length;
  if (!n) return;
  const many = n > 1 ? ` ${n} segments` : "";
  openMenu(x, y, [
    { label: `Duplicate${many}`, shortcut: "Ctrl+D", onSelect: duplicateSelected },
    { label: `Copy${many}`, shortcut: "Ctrl+C", onSelect: copySelected },
    { label: `Cut${many}`, shortcut: "Ctrl+X", onSelect: cutSelected },
    "separator",
    { label: `Delete${many}`, shortcut: "Del", danger: true, onSelect: deleteSelected },
  ]);
}

export function moveSelection(ids: ReadonlySet<string>, to: number) {
  editVideo("Move", (e) => moveSegments(e, ids, to));
}

// ─── YTP presets ────────────────────────────────────────────────────────────

export type Poopism = { readonly id: string; readonly label: string; readonly hint: string; readonly active: (s: Segment) => boolean; readonly apply: (s: Segment, on: boolean) => Segment };

const audio = (s: Segment, patch: Partial<Segment["audio"]>): Segment => ({ ...s, audio: { ...s.audio, ...patch } });
const visual = (s: Segment, patch: Partial<Segment["visual"]>): Segment => ({ ...s, visual: { ...s.visual, ...patch } });

/** One-click YTP treatments ("poopisms"); each toggles on the selected segments. */
export const POOPISMS: readonly Poopism[] = [
  { id: "stutter", label: "Stutter", hint: "The first syllable repeats: w-w-w-what", active: (s) => s.stutter > 1, apply: (s, on) => ({ ...s, stutter: on ? 4 : 1, stutterLength: on ? 0.12 : s.stutterLength }) },
  { id: "reverse", label: "Reverse", hint: "Play backwards, sound and picture", active: (s) => s.reverse, apply: (s, on) => ({ ...s, reverse: on }) },
  { id: "stare", label: "Stare down", hint: "Freeze and zoom on the last frame for a second and a half", active: (s) => s.hold > 0, apply: (s, on) => visual({ ...s, hold: on ? 1.5 : 0 }, { zoom: on ? 1.6 : 1 }) },
  { id: "dance", label: "Dance", hint: "Back and forth (ping-pong) three times", active: (s) => s.pingPong > 0, apply: (s, on) => ({ ...s, pingPong: on ? 3 : 0 }) },
  { id: "earrape", label: "Ear rape", hint: "Loud and clipped, deep fried and shaking", active: (s) => s.audio.earrape > 0, apply: (s, on) => visual(audio(s, { earrape: on ? 1 : 0 }), { contrast: on ? 0.8 : 0, shake: on ? 0.5 : 0 }) },
  { id: "chipmunk", label: "Chipmunk", hint: "Faster and higher, like a sped-up tape", active: (s) => s.speed > 1 && !s.keepPitch, apply: (s, on) => ({ ...s, speed: on ? 1.6 : 1, keepPitch: false }) },
  { id: "slowmo", label: "Slow-mo", hint: "Slower and deeper", active: (s) => s.speed < 1 && !s.keepPitch, apply: (s, on) => ({ ...s, speed: on ? 0.6 : 1, keepPitch: false }) },
  { id: "pitchup", label: "Pitch up", hint: "A fifth higher, same timing", active: (s) => s.pitch > 0, apply: (s, on) => ({ ...s, pitch: on ? 7 : 0 }) },
  { id: "pitchdown", label: "Pitch down", hint: "A fifth lower, same timing", active: (s) => s.pitch < 0, apply: (s, on) => ({ ...s, pitch: on ? -7 : 0 }) },
  { id: "sus", label: "Sus", hint: "Harmonizer: a suspended chord stacked on the voice", active: (s) => s.audio.sus > 0, apply: (s, on) => audio(s, { sus: on ? 1 : 0 }) },
  { id: "echo", label: "Echo", hint: "Delay with repeats", active: (s) => s.audio.echo > 0, apply: (s, on) => audio(s, { echo: on ? 0.6 : 0, echoTime: 0.25 }) },
  { id: "reverb", label: "Reverb", hint: "Big room", active: (s) => s.audio.reverb > 0, apply: (s, on) => audio(s, { reverb: on ? 0.7 : 0 }) },
  { id: "vibrato", label: "Vibrato", hint: "Wobbling pitch", active: (s) => s.audio.vibrato > 0, apply: (s, on) => audio(s, { vibrato: on ? 0.8 : 0 }) },
  { id: "chorus", label: "Chorus", hint: "Thick, wobbly doubled voice", active: (s) => s.audio.chorus > 0, apply: (s, on) => audio(s, { chorus: on ? 0.8 : 0 }) },
  { id: "robot", label: "Bitcrush", hint: "Crunchy low-bit audio", active: (s) => s.audio.bitcrush > 0, apply: (s, on) => audio(s, { bitcrush: on ? 0.7 : 0 }) },
  { id: "mute", label: "Mute", hint: "Silence this segment", active: (s) => s.mute, apply: (s, on) => ({ ...s, mute: on }) },
  { id: "mirror", label: "Mirror", hint: "Flip left to right", active: (s) => s.visual.mirror, apply: (s, on) => visual(s, { mirror: on }) },
  { id: "invert", label: "Invert", hint: "Negative colours", active: (s) => s.visual.invert, apply: (s, on) => visual(s, { invert: on }) },
  { id: "rainbow", label: "Rainbow", hint: "Cycling hue", active: (s) => s.visual.rainbow, apply: (s, on) => visual(s, { rainbow: on }) },
  { id: "deepfry", label: "Deep fry", hint: "Crushed contrast and saturation", active: (s) => s.visual.contrast > 0, apply: (s, on) => visual(s, { contrast: on ? 0.9 : 0 }) },
];

/** Toggles a poopism on the target segments (on if any of them doesn't have it yet). */
export function togglePoopism(p: Poopism) {
  const { edit } = video.getState();
  const ids = targetIds();
  if (!edit || !ids.size) return;
  const on = edit.segments.some((s) => ids.has(s.id) && !p.active(s));
  changeSegments(`${p.label} ${on ? "on" : "off"}`, (s) => p.apply(s, on), ids);
}

/** Clears every treatment from the target segments (keeps their cut points). */
export function clearTreatments() {
  changeSegments("Clear treatments", (s) => ({ ...newSegment(s.clip, s.in, s.out), id: s.id }));
}

// ─── Generators ─────────────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gives each target segment one to three random poopisms (YTP+ style). */
export function randomPoop(seed = Date.now()) {
  const r = rng(seed);
  const pool = POOPISMS.filter((p) => p.id !== "mute");
  changeSegments("Random poop", (s) => {
    let out: Segment = { ...newSegment(s.clip, s.in, s.out), id: s.id, effect: s.effect, effectMix: s.effectMix };
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) out = pool[Math.floor(r() * pool.length)].apply(out, true);
    return out;
  });
}

/**
 * Sentence-mixing generator: chops the target segments into short random
 * pieces (0.15–0.6 s), shuffles them and treats some of them.
 */
export function chopAndShuffle(seed = Date.now()) {
  const { edit } = video.getState();
  const ids = targetIds();
  if (!edit || !ids.size) return;
  const r = rng(seed);
  const targets = edit.segments.filter((s) => ids.has(s.id));
  const pieces: Segment[] = [];
  for (const s of targets) {
    let t = s.in;
    while (t < s.out - 0.05) {
      const len = Math.min(s.out - t, 0.15 + r() * 0.45);
      let piece: Segment = { ...newSegment(s.clip, t, t + len), effect: s.effect, effectMix: s.effectMix };
      if (r() < 0.35) piece = POOPISMS[Math.floor(r() * POOPISMS.length)].apply(piece, true);
      pieces.push(piece);
      t += len;
    }
  }
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }
  const first = edit.segments.findIndex((s) => ids.has(s.id));
  const rest = edit.segments.filter((s) => !ids.has(s.id));
  editVideo("Chop & shuffle", (e) => ({ ...e, segments: [...rest.slice(0, first), ...pieces, ...rest.slice(first)] }));
  select(pieces.map((p) => p.id));
}

/** Source time (seconds of its clip) shown at the playhead, for the inspector. */
export function playheadSource(): { clip: string | null; time: number } | null {
  const plan = engine.plan;
  if (!plan) return null;
  const ref = frameAt(plan, player.getState().frame, engine.infoOf);
  const info = ref && engine.infoOf(ref.clip);
  return ref && info ? { clip: ref.clip, time: ref.frame / info.fps } : null;
}

export const resetAudio = () => changeSegments("Reset sound", (s) => ({ ...s, audio: defaultAudioFx, pitch: 0, volume: 0, mute: false }));
export const resetPicture = () => changeSegments("Reset picture", (s) => ({ ...s, visual: defaultVisualFx }));
