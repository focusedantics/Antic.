import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { registerShortcuts } from "@/app/shortcuts";
import { toast } from "@/app/state";
import { Dialog } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { effectById, newEffect } from "@/core/effects/registry";
import { demux } from "@/core/video/demux";
import { exportVideo } from "@/core/video/export";
import {
  estimateBytes,
  FRAME_RATES,
  type FrameRate,
  outputFrameRate,
  outputSize,
  QUALITIES,
  type Quality,
  sanitizeEdit,
  type Resolution,
  RESOLUTIONS,
  type VideoOutput,
  videoBitrate,
} from "@/core/video/model";
import {
  beginVideoGesture,
  editVideo,
  endVideoGesture,
  flushVideo,
  importVideos,
  openClip,
  openClipFile,
  refreshClips,
  removeClip,
  video,
  videoHistory,
} from "@/core/video/session";
import { track } from "@/lib/activity";
import { getVideo } from "@/core/catalog/db";
import { type Destination, describeDestination, ExportSink } from "@/core/export/destination";
import { rememberedWatermark, rememberWatermark, type Watermark } from "@/core/export/watermark";
import { DestinationPicker, initialDestination, ProgressBar, WatermarkEditor } from "@/features/export/ExportParts";
import { EffectParams } from "@/features/effects/EffectParams";
import { openLooks } from "@/features/looks/LooksDialog";
import { EffectsBrowserHost, openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { formatBytes } from "@/features/library/format";
import { formatTime, grabFrame, playback, seek, stepFrames, togglePlay } from "./playback";
import { Player } from "./Player";

type ShellProps = { left: ReactNode; center: ReactNode; right: ReactNode };

/** Facts about the open clip that only the file itself knows (read once when it opens). */
type ClipInfo = { fps: number; codec: string; hasAudio: boolean; audioNote: string | null; decodable: boolean | null };
/** The open clip's info, for keyboard frame stepping. */
const info = { current: null as ClipInfo | null };

const canEncode = typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";

export function pickVideos() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v";
  input.onchange = async () => {
    if (!input.files?.length) return;
    try {
      await importVideos([...input.files]);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  input.click();
}

function useClipInfo(openId: string | null) {
  const [value, setValue] = useState<ClipInfo | null>(null);
  useEffect(() => {
    setValue(null);
    if (!openId) return;
    let live = true;
    void track(
      (async () => {
        try {
          const file = await openClipFile(openId);
          if (!file) return;
          const d = await demux(file);
          const decodable = typeof VideoDecoder === "undefined" ? false : ((await VideoDecoder.isConfigSupported(d.video.config)).supported ?? false);
          if (live) setValue({ fps: d.video.fps, codec: d.video.config.codec, hasAudio: !!d.audio, audioNote: d.audioNote, decodable });
        } catch (error) {
          if (live) setValue({ fps: 30, codec: "unknown", hasAudio: false, audioNote: error instanceof Error ? error.message : String(error), decodable: false });
        }
      })(),
    );
    return () => {
      live = false;
    };
  }, [openId]);
  useEffect(() => {
    info.current = value;
  }, [value]);
  return value;
}

function ClipsPanel() {
  const clips = useStore(video, (s) => s.clips);
  const openId = useStore(video, (s) => s.openId);
  return (
    <Panel
      id="vid-clips"
      title="Videos"
      actions={
        <button type="button" className="btn small" onClick={pickVideos}>
          + Import
        </button>
      }
    >
      {!clips.length && <p className="faint">Import MP4 or MOV clips to trim them, make them smaller and add effects. Your originals are never changed.</p>}
      {clips.map((c) => (
        <div key={c.id} className="row">
          <button type="button" className="doc-card" aria-current={c.id === openId} onClick={() => void openClip(c.id)}>
            {c.poster ? <img src={c.poster} alt="" /> : <span className="ph" />}
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              <span className="faint num" style={{ fontSize: 10 }}>
                {formatTime(c.duration)} · {c.width}×{c.height} · {formatBytes(c.byteSize)}
              </span>
            </span>
          </button>
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
    </Panel>
  );
}

function TrimPanel() {
  const edit = useStore(video, (s) => s.edit)!;
  const clip = useStore(video, (s) => s.clips.find((c) => c.id === s.openId));
  const time = useStore(playback, (s) => s.time);
  const duration = clip?.duration ?? edit.trimEnd;
  const set = (which: "start" | "end", t: number) =>
    editVideo(which === "start" ? "Trim start" : "Trim end", (e) =>
      which === "start" ? { ...e, trimStart: Math.max(0, Math.min(t, e.trimEnd - 0.1)) } : { ...e, trimEnd: Math.min(duration, Math.max(t, e.trimStart + 0.1)) },
    );
  return (
    <Panel id="vid-trim" title="Trim">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {(["start", "end"] as const).map((w) => (
          <label key={w} className="field">
            <span>{w === "start" ? "Start (s)" : "End (s)"}</span>
            <input
              className="input num"
              type="number"
              step={0.1}
              min={0}
              max={duration}
              value={Number((w === "start" ? edit.trimStart : edit.trimEnd).toFixed(2))}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => Number.isFinite(Number(e.target.value)) && set(w, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <button type="button" className="btn small" title="Set the start to the playhead (I)" onClick={() => set("start", time)}>
          Start at playhead
        </button>
        <button type="button" className="btn small" title="Set the end to the playhead (O)" onClick={() => set("end", time)}>
          End at playhead
        </button>
        <button type="button" className="btn small ghost" onClick={() => editVideo("Reset trim", (e) => ({ ...e, trimStart: 0, trimEnd: duration }))}>
          Reset
        </button>
      </div>
      <p className="faint" style={{ fontSize: 10 }}>
        Keeps {(edit.trimEnd - edit.trimStart).toFixed(1)} s of {duration.toFixed(1)} s. Drag the yellow handles on the timeline, or use I and O.
      </p>
    </Panel>
  );
}

function chooseEffect(current: string | null) {
  openEffectsBrowser({
    mode: "custom",
    current,
    image: grabFrame,
    onPick: (id) => editVideo(`Effect: ${effectById(id)?.name ?? id}`, (e) => ({ ...e, effect: newEffect(id), effectMix: e.effectMix || 1 })),
  });
}

function EffectPanel() {
  const edit = useStore(video, (s) => s.edit)!;
  return (
    <Panel id="vid-effect" title="Effect">
      {!edit.effect ? (
        <>
          <p className="faint" style={{ marginTop: 0 }}>
            Stylize every frame: ASCII, halftone, VHS, glitch, neon edges and 30+ more.
          </p>
          <button type="button" className="btn small" onClick={() => chooseEffect(null)}>
            ✦ Add effect…
          </button>
        </>
      ) : (
        <>
          <Slider
            label="Strength"
            value={Math.round(edit.effectMix * 100)}
            min={0}
            max={100}
            defaultValue={100}
            origin={0}
            format={(v) => `${v}%`}
            onGestureStart={() => beginVideoGesture("Effect strength")}
            onGestureEnd={endVideoGesture}
            onChange={(v) => editVideo("Effect strength", (e) => ({ ...e, effectMix: v / 100 }))}
          />
          <EffectParams
            effect={edit.effect}
            onParam={(key, label, value) => editVideo(label, (e) => (e.effect ? { ...e, effect: { ...e.effect, params: { ...e.effect.params, [key]: value } } } : e))}
            onGestureStart={beginVideoGesture}
            onGestureEnd={endVideoGesture}
            onReset={(fresh) => editVideo("Reset effect", (e) => ({ ...e, effect: fresh }))}
            onChangeEffect={() => chooseEffect(edit.effect?.id ?? null)}
          />
          <button type="button" className="btn small ghost danger" style={{ marginTop: 4 }} onClick={() => editVideo("Remove effect", (e) => ({ ...e, effect: null }))}>
            Remove effect
          </button>
        </>
      )}
    </Panel>
  );
}

function OutputPanel({ clipInfo, onExport }: { clipInfo: ClipInfo | null; onExport: () => void }) {
  const edit = useStore(video, (s) => s.edit)!;
  const clip = useStore(video, (s) => s.clips.find((c) => c.id === s.openId));
  if (!clip) return null;
  const o = edit.output;
  const set = (label: string, patch: Partial<VideoOutput>) => editVideo(label, (e) => ({ ...e, output: { ...e.output, ...patch } }));
  const fps = clipInfo?.fps ?? 30;
  const size = outputSize(clip.width, clip.height, o.resolution);
  const outFps = outputFrameRate(o, fps);
  const bytes = estimateBytes(edit, clip.width, clip.height, fps, clipInfo?.hasAudio ?? true);
  return (
    <Panel id="vid-output" title="Output">
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
      <label className="field" style={{ marginBottom: 6 }}>
        <span>Quality</span>
        <select className="input" value={o.quality} onChange={(e) => set("Quality", { quality: e.target.value as Quality, bitrate: Math.round((videoBitrate(o, size.width, size.height, outFps) / 1e6) * 10) / 10 })}>
          {QUALITIES.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
      </label>
      {o.quality === "custom" && (
        <Slider
          label="Bitrate"
          value={o.bitrate}
          min={0.2}
          max={50}
          step={0.1}
          defaultValue={8}
          origin={0.2}
          format={(v) => `${v.toFixed(1)} Mb/s`}
          onGestureStart={() => beginVideoGesture("Bitrate")}
          onGestureEnd={endVideoGesture}
          onChange={(v) => set("Bitrate", { bitrate: v })}
        />
      )}
      <label className="field" style={{ marginBottom: 6 }}>
        <span>Frame rate</span>
        <select className="input" value={o.frameRate} onChange={(e) => set("Frame rate", { frameRate: e.target.value as FrameRate })}>
          {FRAME_RATES.map((f) => (
            <option key={f.id} value={f.id} disabled={f.id !== "original" && Number(f.id) > Math.round(fps)}>
              {f.id === "original" ? `Original (${Math.round(fps * 100) / 100} fps)` : f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="check" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={o.audio} disabled={clipInfo ? !clipInfo.hasAudio : false} onChange={(e) => set(e.target.checked ? "Keep audio" : "Remove audio", { audio: e.target.checked })} /> Keep audio
      </label>
      {clipInfo?.audioNote && <p className="faint" style={{ fontSize: 10 }}>{clipInfo.audioNote}</p>}
      <p className="dim num" style={{ margin: "6px 0" }}>
        {size.width}×{size.height} · {Math.round(outFps * 100) / 100} fps · ≈ {formatBytes(bytes)}
        <span className="faint"> (was {formatBytes(clip.byteSize)})</span>
      </p>
      {!canEncode && <p className="faint">This browser can't encode video (WebCodecs). Use a recent Chrome, Edge or Safari to export.</p>}
      {clipInfo?.decodable === false && canEncode && <p className="faint">This browser can't decode {clipInfo.codec} video, so it can't be exported here.</p>}
      <button type="button" className="btn primary" style={{ width: "100%" }} disabled={!canEncode} onClick={onExport}>
        Export MP4…
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
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [result, setResult] = useState<{ count: number; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const chosen = clips.filter((c) => selected.has(c.id));
  const busy = !!progress;

  const run = async () => {
    rememberWatermark(watermark);
    flushVideo();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sink = new ExportSink(destination, `Focused videos (${chosen.length}).zip`);
    let count = 0;
    let bytes = 0;
    setError(null);
    try {
      for (const [i, clip] of chosen.entries()) {
        const prefix = chosen.length > 1 ? `${i + 1}/${chosen.length} · ${clip.name} · ` : "";
        setProgress({ done: 0, total: 1, label: `${prefix}Reading video…` });
        const file = await openClipFile(clip.id);
        if (!file) throw new Error(`${clip.name}: the video file is missing.`);
        const state = video.getState();
        const edit = clip.id === state.openId && state.edit ? state.edit : sanitizeEdit((await getVideo(clip.id))?.edit, clip.duration);
        const blob = await exportVideo(file, edit, (p) => setProgress({ done: p.done, total: p.total, label: `${prefix}${p.stage}${p.total > 1 ? ` ${Math.min(p.done, p.total)} / ${p.total} frames` : ""}` }), controller.signal, watermark);
        setProgress({ done: 1, total: 1, label: `${prefix}Saving…` });
        await sink.add(`${clip.name}-edit.mp4`, blob);
        count++;
        bytes += blob.size;
      }
      setProgress({ done: 1, total: 1, label: destination.kind === "zip" ? "Packing the ZIP…" : "Finishing…" });
      await sink.finish();
      setResult({ count, bytes });
      toast(`Exported ${count} video${count === 1 ? "" : "s"} (${formatBytes(bytes)}) to ${describeDestination(destination)}.`);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
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
            <button type="button" className="btn primary" disabled={busy || !chosen.length || !canEncode} onClick={() => void run()}>
              Export MP4{chosen.length > 1 ? ` × ${chosen.length}` : ""}
            </button>
          </>
        )
      }
    >
      {progress && (
        <>
          <ProgressBar {...progress} />
          <p className="faint" style={{ fontSize: 10, margin: 0 }}>
            Rendering happens on this device. Keep this tab open until it finishes.
          </p>
        </>
      )}
      {error && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      {result ? (
        <p>
          Saved {result.count} video{result.count === 1 ? "" : "s"} · {formatBytes(result.bytes)} · {describeDestination(destination)}
        </p>
      ) : (
        !busy && (
          <>
            {clips.length > 1 && (
              <div className="field">
                <span>Videos · {chosen.length} of {clips.length} (each with its own trim, effect and output settings)</span>
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
                      <span className="faint num">{formatTime(c.duration)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <DestinationPicker count={chosen.length} value={destination} onChange={setDestination} />
            <WatermarkEditor value={watermark} onChange={setWatermark} previewUrl={chosen[0]?.poster ?? null} />
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
    <div className="toolbar" role="toolbar" aria-label="Video tools">
      <button type="button" className="btn small" disabled={!edit} onClick={togglePlay} title="Play / pause (Space)">
        Play / Pause
      </button>
      <span className="spacer" />
      <button type="button" className="btn small" disabled={!history?.status().canUndo} onClick={() => history?.undo()} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" className="btn small" disabled={!history?.status().canRedo} onClick={() => history?.redo()} title="Redo (Ctrl+Shift+Z)">
        Redo
      </button>
      <button type="button" className="btn small" disabled={!edit} onClick={() => chooseEffect(edit?.effect?.id ?? null)}>
        ✦ Effects
      </button>
      <button type="button" className="btn small" disabled={!edit} onClick={() => openLooks({ kind: "video" })}>
        Looks…
      </button>
      <button type="button" className="btn small primary" disabled={!edit || !canEncode} onClick={onExport} title="Export MP4 (Ctrl+Shift+E)">
        Export MP4…
      </button>
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
  if (mod) return false;
  const t = playback.getState().time;
  if (key === " ") {
    togglePlay();
    return true;
  }
  if (key === "i") {
    editVideo("Trim start", (ed) => ({ ...ed, trimStart: Math.min(t, ed.trimEnd - 0.1) }));
    return true;
  }
  if (key === "o") {
    editVideo("Trim end", (ed) => ({ ...ed, trimEnd: Math.max(t, ed.trimStart + 0.1) }));
    return true;
  }
  if (key === "arrowleft" || key === "arrowright") {
    stepFrames((key === "arrowleft" ? -1 : 1) * (e.shiftKey ? 10 : 1), info.current?.fps ?? 30);
    return true;
  }
  if (key === "home") {
    seek(edit.trimStart);
    return true;
  }
  if (key === "end") {
    seek(edit.trimEnd);
    return true;
  }
  return false;
}

export default function VideoWorkspace({ Shell }: { Shell: ComponentType<ShellProps> }) {
  const openId = useStore(video, (s) => s.openId);
  const url = useStore(video, (s) => s.url);
  const edit = useStore(video, (s) => s.edit);
  const clip = useStore(video, (s) => s.clips.find((c) => c.id === s.openId));
  const clips = useStore(video, (s) => s.clips);
  const [exporting, setExporting] = useState(false);
  const clipInfo = useClipInfo(openId);
  useEffect(() => {
    void refreshClips().then(() => {
      const { clips: list, openId: current } = video.getState();
      if (!current && list[0]) void openClip(list[0].id);
    });
    return () => flushVideo();
  }, []);
  useEffect(() => registerShortcuts("video", (e) => videoShortcuts(e, () => setExporting(true))), []);
  return (
    <>
      <Shell
        left={<ClipsPanel />}
        center={
          <>
            <Toolbar onExport={() => setExporting(true)} />
            {url && edit && clip ? (
              <Player key={url} url={url} edit={edit} duration={clip.duration} />
            ) : (
              <div className="empty-state">
                <h2>Video</h2>
                <p>Trim clips, lower their resolution and file size, and add any of the effects. Everything runs on this device.</p>
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
          edit && clip ? (
            <>
              <TrimPanel />
              <EffectPanel />
              <OutputPanel clipInfo={clipInfo} onExport={() => setExporting(true)} />
            </>
          ) : null
        }
      />
      <EffectsBrowserHost />
      {exporting && <ExportVideoDialog onClose={() => setExporting(false)} />}
    </>
  );
}
