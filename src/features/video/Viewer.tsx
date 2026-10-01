import { useEffect, useRef } from "react";
import { useStore } from "@/app/hooks";
import { engine, player } from "./engine";
import { formatClock } from "./format";

/** The program monitor: the timeline frame at the playhead, rendered with its treatments. */
export function Viewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const error = useStore(player, (s) => s.error);
  const audio = useStore(player, (s) => s.audio);
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
        <canvas ref={canvasRef} className="vv-canvas" onClick={() => engine.toggle()} data-testid="viewer" />
        {error && <div className="develop-status error">{error}</div>}
        {!error && audio === "rendering" && <div className="vv-status">Rendering sound…</div>}
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
