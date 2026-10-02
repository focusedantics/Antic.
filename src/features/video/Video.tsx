import { chooseFiles, pickerAccept } from "@/lib/files";
import { CompactActions, type DockItem, type ShellProps, TopAction } from "@/app/Shell";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { registerShortcuts } from "@/app/shortcuts";
import type { SelectScope } from "@/app/select-mode";
import { SelectButton } from "@/app/SelectBar";
import { toast } from "@/app/state";
import { Dialog, openMenu } from "@/components/Menu";
import { domHits, useSweepSelect } from "@/components/sweep";
import { Panel } from "@/components/Panel";
import { getVideo } from "@/core/catalog/db";
import { type Destination, describeDestination, ExportSink } from "@/core/export/destination";
import { type ExportFrame, rememberedFrame } from "@/core/export/frame";
import { rememberedWatermark, rememberWatermark, type Watermark } from "@/core/export/watermark";
import { exportEdit, losslessEncoder } from "@/core/video/export";
import { type ClipMedia, loadClipMedia } from "@/core/video/media";
import { type ExportFormat, FORMATS, outputSize, type Resolution, RESOLUTIONS, sanitizeEdit, type VideoEdit } from "@/core/video/model";
import { editVideo, flushVideo, importVideos, openClip, refreshClips, removeClip, video, videoHistory } from "@/core/video/session";
import { DestinationPicker, ExportHero, type ExportPreview, initialDestination, WatermarkEditor } from "@/features/export/ExportParts";
import { EffectsBrowserHost } from "@/features/effects/EffectsBrowser";
import { formatBytes } from "@/features/library/format";
import { openLooks } from "@/features/looks/LooksDialog";
import { holdMotion } from "@/lib/motion";
import { holdAtLeast, nextPaint, PACE, sleep } from "@/lib/pacing";
import type { MarbleMood } from "@/features/export/marble";
import "@/styles/video.css";
import {
  copySelected,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  editor,
  insertClip,
  insertClips,
  pasteAtPlayhead,
  POOPISMS,
  select,
  splitAtPlayhead,
  togglePoopism,
} from "./actions";
import { engine, player } from "./engine";
import { formatClock } from "./format";
import { PoopPanel, SegmentPanel, VideoEffectPanel } from "./Inspector";
import { Timeline, zoomTimeline } from "./Timeline";
import { Viewer } from "./Viewer";


const canCodec = typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";

export async function pickVideos() {
  // On iPhone, video/* hands over the originals (HEVC included) rather than a re-compressed copy.
  const files = await chooseFiles({ multiple: true, accept: pickerAccept("video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v", { videos: true }) });
  if (!files.length) return;
  try {
    await importVideos(files);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

/** Menu for the picked clips (right-click, or after a right-click sweep): open, insert, remove. */
function clipMenu(x: number, y: number) {
  const { clips, openId } = video.getState();
  const picked = new Set(editor.getState().clipSelection);
  const chosen = clips.filter((c) => picked.has(c.id));
  if (!chosen.length) return;
  const what = chosen.length > 1 ? `${chosen.length} clips` : `“${chosen[0].name}”`;
  openMenu(x, y, [
    ...(chosen.length === 1 ? [{ label: "Open", onSelect: () => void openClip(chosen[0].id) }] : []),
    { label: `Insert ${what} at the playhead`, disabled: !openId, onSelect: () => insertClips(chosen.map((c) => ({ id: c.id, duration: c.duration }))) },
    "separator",
    {
      label: `Remove ${what}…`,
      danger: true,
      onSelect: async () => {
        if (!confirm(`Remove ${what} from Focused? Files you already exported are not affected.`)) return;
        for (const c of chosen) await removeClip(c.id);
        editor.setState({ clipSelection: [] });
      },
    },
  ]);
}

/** Clips in select mode (phones). */
const clipScope: SelectScope = {
  id: "clips",
  noun: ["clip", "clips"],
  all: () => video.getState().clips.map((c) => c.id),
  get: () => editor.getState().clipSelection,
  set: (ids) => editor.setState({ clipSelection: ids }),
  subscribe: (listener) => editor.subscribe((s, prev) => s.clipSelection !== prev.clipSelection && listener()),
  actions: clipMenu,
};

function ClipsPanel() {
  const clips = useStore(video, (s) => s.clips);
  const openId = useStore(video, (s) => s.openId);
  const picked = useStore(editor, (s) => s.clipSelection);
  const listRef = useRef<HTMLDivElement>(null);
  // Right-click and hold, then drag down the list: pick several clips to insert or remove.
  useSweepSelect(listRef, {
    initial: () => editor.getState().clipSelection,
    onSelect: (ids) => editor.setState({ clipSelection: ids }),
    onDone: (ids, x, y) => {
      if (ids.length) clipMenu(x, y);
    },
    hits: (box) => domHits(listRef.current, box),
    scroller: () => listRef.current?.closest<HTMLElement>(".side") ?? null,
    scope: clipScope,
  });
  return (
    <Panel
      id="vid-clips"
      title="Videos"
      actions={
        <>
          <SelectButton scope={clipScope} />
          <button type="button" className="btn small" onClick={pickVideos}>
            + Import
          </button>
        </>
      }
    >
      {!clips.length && <p className="faint">Import MP4 or MOV clips to cut, mix and poop them. Your originals are never changed.</p>}
      <div ref={listRef} className="vid-clips">
      {clips.map((c) => (
        <div
          key={c.id}
          className="row vid-clip"
          data-sweep-id={c.id}
          data-selected={picked.includes(c.id) || undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!picked.includes(c.id)) editor.setState({ clipSelection: [c.id] });
            clipMenu(e.clientX, e.clientY);
          }}
        >
          <button
            type="button"
            className="doc-card"
            aria-current={c.id === openId}
            aria-pressed={picked.includes(c.id)}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey) {
                editor.setState({ clipSelection: picked.includes(c.id) ? picked.filter((id) => id !== c.id) : [...picked, c.id] });
                return;
              }
              editor.setState({ clipSelection: [] });
              void openClip(c.id);
            }}
            title="Open this clip's timeline (Ctrl+click to pick several)"
          >
            {c.poster ? <img src={c.poster} alt="" /> : <span className="ph" />}
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              <span className="faint num" style={{ fontSize: 10 }}>
                {formatClock(c.duration)} · {c.width}×{c.height} · {formatBytes(c.byteSize)}
              </span>
            </span>
          </button>
          {openId && (
            <button type="button" className="btn ghost small" title="Insert this whole clip at the playhead (sentence mixing across sources)" aria-label={`Insert ${c.name} at the playhead`} onClick={() => insertClip(c.id, c.duration)}>
              ＋
            </button>
          )}
          <button
            type="button"
            className="btn ghost small"
            aria-label={`Remove ${c.name}`}
            onClick={() => {
              if (confirm(`Remove “${c.name}” from Focused? Files you already exported are not affected.`)) void removeClip(c.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      </div>
    </Panel>
  );
}

/**
 * The clips for the marble, the open one first: its timeline's frame 0; other
 * clips their first frame once their export has started, their poster before.
 */
function videoPreviews(chosen: readonly { id: string; poster: string | null }[], openId: string | null, firstFrames: Record<string, ExportPreview>): ExportPreview[] {
  const order = [...chosen].reverse();
  const open = order.findIndex((c) => c.id === openId);
  if (open > 0) order.unshift(...order.splice(open, 1));
  return order.slice(0, 5).flatMap((c): ExportPreview[] => {
    if (c.id === openId) return [{ key: `${c.id}:open`, load: () => engine.firstFrame() }];
    const first = firstFrames[c.id];
    if (first) return [first];
    const poster = c.poster;
    return poster ? [{ key: poster, load: async () => poster }] : [];
  });
}

/** The first frame of an edit that is not open in the player, decoded by the browser at a small size. */
async function firstFrameOf(edit: VideoEdit, own: ClipMedia): Promise<ImageBitmap | null> {
  const first = edit.segments[0];
  if (!first) return null;
  const media = first.clip ? await loadClipMedia(first.clip) : own;
  if (!media) return null;
  const time = first.reverse ? Math.max(0, first.out - 1 / media.info.fps) : first.in;
  const url = URL.createObjectURL(media.file);
  const el = document.createElement("video");
  el.muted = true;
  el.preload = "auto";
  const wait = (event: "loadeddata" | "seeked") =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 4000);
      el.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
      el.addEventListener("error", () => (clearTimeout(timer), reject(new Error("decode"))), { once: true });
    });
  try {
    el.src = url;
    await wait("loadeddata");
    el.currentTime = time + 0.001;
    await wait("seeked");
    const scale = Math.min(1, 192 / Math.max(el.videoWidth, el.videoHeight, 1));
    return await createImageBitmap(el, { resizeWidth: Math.max(1, Math.round(el.videoWidth * scale)), resizeHeight: Math.max(1, Math.round(el.videoHeight * scale)) });
  } catch {
    return null;
  } finally {
    el.removeAttribute("src");
    el.load();
    URL.revokeObjectURL(url);
  }
}

/** Whether this browser can encode lossless VP9 (checked once). */
let losslessSupport: Promise<boolean> | null = null;
function useLosslessSupport() {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    losslessSupport ??= losslessEncoder(1280, 720, 30).then((e) => !!e);
    void losslessSupport.then(setOk);
  }, []);
  return ok;
}

function OutputPanel({ onExport }: { onExport: () => void }) {
  const edit = useStore(video, (s) => s.edit)!;
  const clip = useStore(video, (s) => s.clips.find((c) => c.id === s.openId));
  const frames = useStore(player, (s) => s.frames);
  const fps = useStore(player, (s) => s.fps);
  const lossless = useLosslessSupport();
  if (!clip) return null;
  const o = edit.output;
  const format = FORMATS.find((f) => f.id === o.format)!;
  const size = outputSize(clip.width, clip.height, o.resolution);
  const set = (label: string, patch: Partial<typeof o>) => editVideo(label, (e) => ({ ...e, output: { ...e.output, ...patch } }));
  // Lossless VP9 of typical footage: roughly 0.6 bytes per pixel per frame.
  const estimate = format.id === "mp4-h264" ? size.width * size.height * frames * 0.06 : size.width * size.height * frames * 0.6;
  const unsupported = format.id !== "mp4-h264" && lossless === false;
  return (
    <Panel id="vid-output" title="Output">
      <label className="field" style={{ marginBottom: 6 }}>
        <span>Format</span>
        <select className="input" value={o.format} onChange={(e) => set("Format", { format: e.target.value as ExportFormat })}>
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id} disabled={f.id !== "mp4-h264" && lossless === false}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <p className="faint" style={{ fontSize: 11, marginTop: 0 }}>
        {format.detail}
      </p>
      <label className="field" style={{ marginBottom: 6 }}>
        <span>Resolution</span>
        <select className="input" value={o.resolution} onChange={(e) => set("Resolution", { resolution: e.target.value as Resolution })}>
          {RESOLUTIONS.map((r) => {
            const s = outputSize(clip.width, clip.height, r.id);
            const bigger = r.lines && r.lines >= Math.min(clip.width, clip.height);
            return (
              <option key={r.id} value={r.id} disabled={!!bigger}>
                {r.label} · {s.width}×{s.height}
              </option>
            );
          })}
        </select>
      </label>
      <label className="check" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={o.audio} onChange={(e) => set(e.target.checked ? "Keep audio" : "Remove audio", { audio: e.target.checked })} /> Audio
      </label>
      <p className="dim num" style={{ margin: "6px 0" }}>
        {size.width}×{size.height} · {Math.round(fps * 100) / 100} fps · {frames} frames · {formatClock(frames / fps)} · ≈ {formatBytes(estimate)}
      </p>
      {format.id !== "mp4-h264" && o.resolution === "original" && (
        <p className="faint" style={{ fontSize: 11 }}>
          Lossless: every frame you didn't treat comes out bit-identical to the original, and none are dropped.
        </p>
      )}
      {unsupported && <p style={{ color: "var(--danger)", fontSize: 11 }}>This browser can't encode lossless VP9. Use Chrome, Edge or Firefox, or the Compatible format.</p>}
      {!canCodec && <p className="faint">This browser can't encode video (WebCodecs). Use a recent Chrome, Edge or Firefox.</p>}
      <button type="button" className="btn primary" style={{ width: "100%" }} disabled={!canCodec || unsupported || !frames} onClick={onExport}>
        Export {format.extension.toUpperCase()}…
      </button>
    </Panel>
  );
}

function ExportVideoDialog({ onClose }: { onClose: () => void }) {
  const clips = useStore(video, (s) => s.clips);
  const openId = useStore(video, (s) => s.openId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(openId ? [openId] : []));
  const [destination, setDestination] = useState<Destination>(initialDestination);
  const [watermark, setWatermark] = useState<Watermark>(rememberedWatermark);
  // Video frames are solid and over the picture's edges (stamped on every frame like the watermark).
  const [frame, setFrame] = useState<ExportFrame>(() => ({ ...rememberedFrame(), style: "solid", placement: "inside" }));
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  // Real first frames of edits, filled in as each clip's export starts.
  const [firstFrames, setFirstFrames] = useState<Record<string, ExportPreview>>({});
  const [item, setItem] = useState(0);
  const [mood, setMood] = useState<MarbleMood>("idle");
  const [result, setResult] = useState<{ count: number; bytes: number; frames: number; lossless: boolean; copied: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const chosen = clips.filter((c) => selected.has(c.id));
  const busy = !!progress;

  const run = async () => {
    rememberWatermark(watermark);
    flushVideo();
    engine.pause();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sink = new ExportSink(destination, `Focused videos (${chosen.length}).zip`);
    let count = 0;
    let bytes = 0;
    let frames = 0;
    let lossless = true;
    let copied = true;
    setError(null);
    const started = performance.now();
    setMood("working");
    setProgress({ done: 0, total: 1, label: "Starting…" });
    await nextPaint();
    try {
      const durations = new Map(clips.map((c) => [c.id, c.duration]));
      for (const [i, clip] of chosen.entries()) {
        const prefix = chosen.length > 1 ? `${i + 1}/${chosen.length} · ${clip.name} · ` : "";
        setProgress({ done: 0, total: 1, label: `${prefix}Reading video…` });
        const own = await loadClipMedia(clip.id);
        if (!own) throw new Error(`${clip.name}: the video file is missing or can't be read.`);
        const state = video.getState();
        const edit = clip.id === state.openId && state.edit ? state.edit : sanitizeEdit((await getVideo(clip.id))?.edit, clip.duration, (id) => durations.get(id) ?? Infinity);
        // The marble shows the first frame of each edit (the poster stands in until then).
        setItem(i + 1);
        if (clip.id !== state.openId) setFirstFrames((f) => ({ ...f, [clip.id]: { key: `${clip.id}:first`, load: () => firstFrameOf(edit, own) } }));
        const out = await exportEdit(own, edit, loadClipMedia, (p) => setProgress({ done: p.done, total: p.total, label: `${prefix}${p.stage}${p.total > 1 ? ` ${Math.min(p.done, p.total)} / ${p.total} frames` : ""}` }), controller.signal, watermark, frame);
        setProgress({ done: 1, total: 1, label: `${prefix}Saving…` });
        await sink.add(`${clip.name}-edit.${out.extension}`, out.blob);
        count++;
        bytes += out.blob.size;
        frames += out.frames;
        lossless &&= out.lossless;
        copied &&= out.copied;
      }
      setProgress({ done: 1, total: 1, label: destination.kind === "zip" ? "Packing the ZIP…" : "Finishing…" });
      await sink.finish();
      // Quick exports (a stream copy can take a blink) still show the marble working, then a beat of "done".
      await holdAtLeast(started);
      setMood("done");
      setProgress({ done: 1, total: 1, label: `Saved ${count} video${count === 1 ? "" : "s"} ✓` });
      await sleep(PACE.doneBeat);
      setResult({ count, bytes, frames, lossless, copied });
      toast(`Exported ${count} video${count === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${describeDestination(destination)}.`);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
      setMood((m) => (m === "done" ? m : "idle"));
    }
  };

  return (
    <Dialog
      wide
      title={chosen.length === 1 ? `Export “${chosen[0].name}”` : `Export ${chosen.length} videos`}
      onClose={() => {
        controllerRef.current?.abort();
        onClose();
      }}
      footer={
        result ? (
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                controllerRef.current?.abort();
                if (!busy) onClose();
              }}
            >
              {busy ? "Stop" : "Cancel"}
            </button>
            <button type="button" className="btn primary" disabled={busy || !chosen.length || !canCodec} onClick={() => void run()}>
              Export{chosen.length > 1 ? ` × ${chosen.length}` : ""}
            </button>
          </>
        )
      }
    >
      <ExportHero
        previews={videoPreviews(chosen, openId, firstFrames)}
        count={chosen.length}
        mood={mood}
        progress={progress}
        current={item}
        title={chosen.length === 1 ? chosen[0].name : `${chosen.length} videos`}
        details={chosen.length === 1 ? formatClock(chosen[0].duration) : undefined}
      />
      {progress && (
        <p className="faint" style={{ fontSize: 10, margin: 0 }}>
          Rendering happens on this device, every frame in order. Keep this tab open until it finishes.
        </p>
      )}
      {error && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      {result ? (
        <p data-testid="export-result">
          Saved {result.count} video{result.count === 1 ? "" : "s"} · {result.frames} frames, none dropped · {formatBytes(result.bytes)} · {describeDestination(destination)}
          {result.copied ? " · original frames copied bit for bit" : result.lossless ? " · lossless" : ""}
        </p>
      ) : (
        !busy && (
          <>
            {clips.length > 1 && (
              <div className="field">
                <span>Videos · {chosen.length} of {clips.length} (each with its own timeline and output settings)</span>
                <div className="export-list">
                  {clips.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                      />
                      {c.poster ? <img src={c.poster} alt="" /> : <span className="ph" />}
                      <span className="name">
                        {c.name}
                        {c.id === openId ? " (open)" : ""}
                      </span>
                      <span className="faint num">{formatClock(c.duration)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <DestinationPicker count={chosen.length} value={destination} onChange={setDestination} />
            <WatermarkEditor
              value={watermark}
              onChange={setWatermark}
              previewUrl={chosen[0]?.poster ?? null}
              frame={frame}
              onFrame={setFrame}
              frameOptions={{ styles: ["solid"], placements: ["inside"], note: "Video frames are solid and sit over the picture's edges. Glass and Polaroid frames are for photos and compositions." }}
            />
            {watermark.enabled && <p className="faint" style={{ fontSize: 11 }}>A watermark is drawn on every frame, so frames are no longer bit-identical to the original.</p>}
          </>
        )
      )}
    </Dialog>
  );
}

function Toolbar({ onExport }: { onExport: () => void }) {
  const edit = useStore(video, (s) => s.edit);
  const [, force] = useState(0);
  const history = videoHistory();
  useEffect(() => {
    if (!history) return;
    const unsubscribe = history.subscribe(() => force((n) => n + 1));
    return () => {
      unsubscribe();
    };
  }, [history]);
  return (
    <div className="toolbar wide-only" role="toolbar" aria-label="Video tools">
      <button type="button" className="btn small" disabled={!edit} onClick={splitAtPlayhead} title="Cut the segment at the playhead (S)">
        ✂ Split
      </button>
      <button type="button" className="btn small" disabled={!edit} onClick={duplicateSelected} title="Duplicate (Ctrl+D)">
        Duplicate
      </button>
      <button type="button" className="btn small" disabled={!edit} onClick={deleteSelected} title="Delete (Delete)">
        Delete
      </button>
      <span className="spacer" />
      <button type="button" className="btn small wide-only" disabled={!history?.status().canUndo} onClick={() => history?.undo()} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" className="btn small wide-only" disabled={!history?.status().canRedo} onClick={() => history?.redo()} title="Redo (Ctrl+Shift+Z)">
        Redo
      </button>
      <button type="button" className="btn small" disabled={!edit} onClick={() => openLooks({ kind: "video" })}>
        Looks…
      </button>
      <button type="button" className="btn small primary wide-only" disabled={!edit || !canCodec} onClick={onExport} title="Export (Ctrl+Shift+E)">
        Export…
      </button>
      <CompactActions>
        <TopAction icon="undo" label="Undo" disabled={!history?.status().canUndo} onClick={() => history?.undo()} />
        <TopAction icon="redo" label="Redo" disabled={!history?.status().canRedo} onClick={() => history?.redo()} />
        <TopAction icon="export" label="Export" primary disabled={!edit || !canCodec} onClick={onExport} />
      </CompactActions>
    </div>
  );
}

function videoShortcuts(e: KeyboardEvent, openExport: () => void): boolean {
  const { edit } = video.getState();
  if (!edit) return false;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const history = videoHistory();
  if (mod && key === "z") {
    if (e.shiftKey) history?.redo();
    else history?.undo();
    return true;
  }
  if (mod && e.shiftKey && key === "e") {
    openExport();
    return true;
  }
  if (mod && key === "d") return duplicateSelected(), true;
  if (mod && key === "c") return copySelected(), true;
  if (mod && key === "x") return cutSelected(), true;
  if (mod && key === "v") return pasteAtPlayhead(), true;
  if (mod && key === "a") return select(edit.segments.map((s) => s.id)), true;
  if (mod) return false;
  const fps = player.getState().fps;
  switch (key) {
    case " ":
    case "k":
      if (key === "k") engine.pause();
      else engine.toggle();
      return true;
    case "l":
      engine.play();
      return true;
    case "arrowleft":
    case "j":
      engine.step(e.shiftKey || key === "j" ? -Math.round(fps) : -1);
      return true;
    case "arrowright":
      engine.step(e.shiftKey ? Math.round(fps) : 1);
      return true;
    case "home":
      engine.seek(0);
      return true;
    case "end":
      engine.seek(player.getState().frames - 1);
      return true;
    case "s":
      splitAtPlayhead();
      return true;
    case "delete":
    case "backspace":
      deleteSelected();
      return true;
    case "escape":
      select([]);
      return true;
    case "r":
      togglePoopism(POOPISMS.find((p) => p.id === "reverse")!);
      return true;
    case "t":
      togglePoopism(POOPISMS.find((p) => p.id === "stutter")!);
      return true;
    case "=":
    case "+":
      zoomTimeline(1.5);
      return true;
    case "-":
      zoomTimeline(1 / 1.5);
      return true;
    case "0":
      zoomTimeline("fit");
      return true;
  }
  return false;
}

const VIDEO_DOCK: DockItem[] = [
  { id: "clips", label: "Clips", icon: "clips", side: "left" },
  { id: "edit", label: "Edit", icon: "edit", side: "right" },
];

export default function VideoWorkspace({ Shell }: { Shell: ComponentType<ShellProps> }) {
  const openId = useStore(video, (s) => s.openId);
  const edit = useStore(video, (s) => s.edit);
  const clips = useStore(video, (s) => s.clips);
  const [exporting, setExporting] = useState(false);
  const openedRef = useRef<string | null>(null);
  const playing = useStore(player, (s) => s.playing);
  // The glow backdrop holds still while the video plays or exports.
  useEffect(() => (playing || exporting ? holdMotion() : undefined), [playing, exporting]);

  useEffect(() => {
    void refreshClips().then(() => {
      const { clips: list, openId: current } = video.getState();
      if (!current && list[0]) void openClip(list[0].id);
    });
    return () => {
      flushVideo();
      engine.close();
      openedRef.current = null;
    };
  }, []);
  // Keep the engine on the open clip's timeline.
  useEffect(() => {
    if (!openId || !edit) return;
    if (openedRef.current !== openId) {
      openedRef.current = openId;
      select([]);
      void engine.open(openId, edit);
    } else void engine.setEdit(edit);
  }, [openId, edit]);
  useEffect(() => registerShortcuts("video", (e) => videoShortcuts(e, () => setExporting(true))), []);

  return (
    <>
      <Shell
        left={<ClipsPanel />}
        center={
          <>
            <Toolbar onExport={() => setExporting(true)} />
            {openId && edit ? (
              <div className="vid-editor">
                <Viewer />
                <Timeline />
              </div>
            ) : (
              <div className="empty-state">
                <h2>Video</h2>
                <p>Cut, rearrange and poop your clips: stutter, reverse, stare-downs, pitch, ear rape, sus and more, with lossless export. Everything runs on this device.</p>
                <div className="row" style={{ justifyContent: "center" }}>
                  <button type="button" className="btn primary" onClick={pickVideos}>
                    Import Video…
                  </button>
                </div>
                <p className="faint" style={{ marginTop: 14 }}>
                  {clips.length ? "Or open one from the list on the left." : "MP4 and MOV files. You can also drop them anywhere on the window."}
                </p>
              </div>
            )}
          </>
        }
        right={
          edit ? (
            <>
              <PoopPanel />
              <SegmentPanel />
              <VideoEffectPanel />
              <OutputPanel onExport={() => setExporting(true)} />
            </>
          ) : null
        }
        dock={VIDEO_DOCK}
      />
      <EffectsBrowserHost />
      {exporting && <ExportVideoDialog onClose={() => setExporting(false)} />}
    </>
  );
}
