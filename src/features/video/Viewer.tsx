import { useEffect, useRef } from "react";
import { useStore } from "@/app/hooks";
import { layout } from "@/app/layout";
import { Icon } from "@/components/icons";
import { openMenu } from "@/components/Menu";
import { openLooks } from "@/features/looks/LooksDialog";
import { video } from "@/core/video/session";
import { deleteSelected, duplicateSelected, splitAtPlayhead } from "./actions";
import { zoomTimeline } from "./Timeline";
import { engine, player } from "./engine";
import { formatClock } from "./format";

/** The program monitor: the timeline frame at the playhead, rendered with its treatments. */
export function Viewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const error = useStore(player, (s) => s.error);
  const audio = useStore(player, (s) => s.audio);
  const decoder = useStore(player, (s) => s.decoder);
  useEffect(() => {
    const canvas = canvasRef.current!;
    engine.attach(canvas);
    const ro = new ResizeObserver(() => {
      const stage = stageRef.current;
      if (!stage) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(stage.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(stage.clientHeight * dpr));
      engine.draw();
    });
    ro.observe(stageRef.current!);
    return () => {
      ro.disconnect();
      engine.detach();
    };
  }, []);
  return (
    <div className="vv">
      <div className="vv-stage" ref={stageRef}>
        <canvas ref={canvasRef} className="vv-canvas" onClick={() => engine.toggle()} data-testid="viewer" data-decoder={decoder ?? undefined} />
        {error && <div className="develop-status error">{error}</div>}
        {!error && audio === "rendering" && <div className="vv-status">Rendering sound…</div>}
        {!error && audio !== "rendering" && decoder === "element" && (
          <div className="vv-status" title="This browser's WebCodecs can't decode this clip, so frames come from its video player. Everything works; stepping and effects are slower.">
            Compatibility playback
          </div>
        )}
      </div>
      <Transport />
    </div>
  );
}

function Transport() {
  const frame = useStore(player, (s) => s.frame);
  const frames = useStore(player, (s) => s.frames);
  const fps = useStore(player, (s) => s.fps);
  const playing = useStore(player, (s) => s.playing);
  const loop = useStore(player, (s) => s.loop);
  const compact = useStore(layout, (s) => s.compact);
  const edit = useStore(video, (s) => s.edit);
  if (compact)
    // Phones: one row in thumb reach. The edit actions from the toolbar live here, the rest in ⋯.
    return (
      <div className="vv-transport compact">
        <button type="button" className="tbtn play" aria-label={playing ? "Pause" : "Play"} onClick={() => engine.toggle()}>
          <Icon name={playing ? "pause" : "play"} size={22} />
        </button>
        <button type="button" className="tbtn" aria-label="Previous frame" onClick={() => engine.step(-1)}>
          <Icon name="step-back" size={20} />
        </button>
        <button type="button" className="tbtn" aria-label="Next frame" onClick={() => engine.step(1)}>
          <Icon name="step-forward" size={20} />
        </button>
        <span className="num vv-time" data-testid="timecode">
          {formatClock(frame / fps)}
          <span className="vv-total"> / {formatClock(frames / fps)}</span>
        </span>
        <span className="spacer" />
        <button type="button" className="tbtn" aria-label="Split at the playhead" disabled={!edit} onClick={splitAtPlayhead}>
          <Icon name="split" size={20} />
        </button>
        <button type="button" className="tbtn" aria-label="Duplicate" disabled={!edit} onClick={duplicateSelected}>
          <Icon name="duplicate" size={20} />
        </button>
        <button type="button" className="tbtn" aria-label="Delete" disabled={!edit} onClick={deleteSelected}>
          <Icon name="trash" size={20} />
        </button>
        <button
          type="button"
          className="tbtn"
          aria-label="More playback options"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.right, r.top - 4, [
              { label: "Go to start", onSelect: () => engine.seek(0) },
              { label: "Go to end", onSelect: () => engine.seek(frames - 1) },
              { label: "Loop playback", checked: loop, onSelect: () => player.setState({ loop: !loop }) },
              { label: "Fit the timeline", onSelect: () => zoomTimeline("fit") },
              "separator",
              { label: "Looks…", disabled: !edit, onSelect: () => openLooks({ kind: "video" }) },
            ]);
          }}
        >
          <Icon name="more" size={20} />
        </button>
      </div>
    );
  return (
    <div className="vv-transport">
      <button type="button" className="btn small ghost icon" title="Start (Home)" aria-label="Go to start" onClick={() => engine.seek(0)}>
        ⏮
      </button>
      <button type="button" className="btn small ghost icon" title="Previous frame (←)" aria-label="Previous frame" onClick={() => engine.step(-1)}>
        ◀︎|
      </button>
      <button type="button" className="btn small primary icon" title="Play / pause (Space)" aria-label={playing ? "Pause" : "Play"} onClick={() => engine.toggle()}>
        {playing ? "❚❚" : "▶"}
      </button>
      <button type="button" className="btn small ghost icon" title="Next frame (→)" aria-label="Next frame" onClick={() => engine.step(1)}>
        |▶︎
      </button>
      <button type="button" className="btn small ghost icon" title="End (End)" aria-label="Go to end" onClick={() => engine.seek(frames - 1)}>
        ⏭
      </button>
      <span className="num vv-time" data-testid="timecode">
        {formatClock(frame / fps)} / {formatClock(frames / fps)}
      </span>
      <span className="faint num">
        frame {frames ? frame + 1 : 0} of {frames}
      </span>
      <span className="spacer" />
      <button type="button" className="btn small" aria-pressed={loop} onClick={() => player.setState({ loop: !loop })}>
        Loop
      </button>
    </div>
  );
}
