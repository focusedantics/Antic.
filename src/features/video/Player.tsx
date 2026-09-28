import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { toast } from "@/app/state";
import { outputSize, type VideoEdit } from "@/core/video/model";
import { demux } from "@/core/video/demux";
import { PreviewDecoder } from "@/core/video/preview";
import { VideoRenderer } from "@/core/video/renderer";
import { beginVideoGesture, editVideo, endVideoGesture } from "@/core/video/session";
import { formatTime, playback, seek, setPlaybackElement, togglePlay } from "./playback";

type VideoWithFrames = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/** Frames along the timeline, captured by seeking a second, hidden video. */
function useStrip(url: string, duration: number, count: number) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    const el = document.createElement("video");
    el.muted = true;
    el.preload = "auto";
    el.src = url;
    const grab = (i: number) => {
      if (cancelled || i >= count || !duration) return;
      el.currentTime = ((i + 0.5) / count) * duration;
      el.onseeked = async () => {
        try {
          const h = 72;
          const w = Math.max(1, Math.round((el.videoWidth / el.videoHeight) * h));
          const canvas = new OffscreenCanvas(w, h);
          canvas.getContext("2d")!.drawImage(el, 0, 0, w, h);
          const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
          if (cancelled) return;
          const u = URL.createObjectURL(blob);
          made.push(u);
          setFrames((f) => [...f, u]);
        } catch {
          // Missing strip frames only leave gaps.
        }
        grab(i + 1);
      };
    };
    setFrames([]);
    el.onloadeddata = () => grab(0);
    return () => {
      cancelled = true;
      el.removeAttribute("src");
      el.load();
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [url, duration, count]);
  return frames;
}

export function Player({ url, edit, duration }: { url: string; edit: VideoEdit; duration: number }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<VideoWithFrames>(null);
  const rendererRef = useRef<VideoRenderer | null>(null);
  const frameCanvas = useRef<OffscreenCanvas | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  // With nothing to render, the browser's own <video> is shown: playback is exactly the original file's.
  const native = !edit.effect || edit.effectMix <= 0;
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const [error, setError] = useState<string | null>(null);
  const time = useStore(playback, (s) => s.time);
  const playing = useStore(playback, (s) => s.playing);
  const strip = useStrip(url, duration, 12);

  /** Where the frame goes: letterboxed in the canvas, at the export resolution (or the screen size, whichever is smaller) so it shows what you'll get. */
  const layout = (v: HTMLVideoElement, canvas: HTMLCanvasElement) => {
    const e = editRef.current;
    const dw = v.videoWidth;
    const dh = v.videoHeight;
    const s = Math.min(canvas.width / dw, canvas.height / dh);
    const fw = Math.max(1, Math.round(dw * s));
    const fh = Math.max(1, Math.round(dh * s));
    const out = outputSize(dw, dh, e.output.resolution);
    const scale = Math.min(1, out.width / fw);
    const ww = Math.max(2, Math.round(fw * scale));
    const wh = Math.max(2, Math.round(fh * scale));
    const viewport = [Math.floor((canvas.width - fw) / 2), Math.floor((canvas.height - fh) / 2), fw, fh] as const;
    return { e, ww, wh, viewport };
  };

  /** Draws a WebCodecs-decoded frame (playback). */
  const drawDecoded = (frame: VideoFrame, rotation: number) => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!v || !canvas || !renderer || !v.videoWidth) return;
    const { e, ww, wh, viewport } = layout(v, canvas);
    try {
      renderer.draw(frame, frame.displayWidth, frame.displayHeight, rotation, ww, wh, e, viewport, Math.max(0, v.currentTime - e.trimStart));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Draws the <video> element's current frame (paused, seeking, or without WebCodecs). */
  const draw = () => {
    if (nativeRef.current) return;
    const v = videoRef.current;
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!v || !canvas || !renderer || v.readyState < 2 || !v.videoWidth) return;
    const { e, ww, wh, viewport } = layout(v, canvas);
    try {
      // Draw through a 2D canvas: it applies the clip's rotation the same way in every browser.
      let frame = frameCanvas.current;
      if (!frame || frame.width !== ww || frame.height !== wh) frame = frameCanvas.current = new OffscreenCanvas(ww, wh);
      frame.getContext("2d")!.drawImage(v, 0, 0, ww, wh);
      renderer.draw(frame, ww, wh, 0, ww, wh, e, viewport, Math.max(0, v.currentTime - e.trimStart));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    try {
      rendererRef.current = new VideoRenderer(canvasRef.current!);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    const observer = new ResizeObserver(() => {
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      if (!stage || !canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(stage.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(stage.clientHeight * dpr));
      draw();
    });
    observer.observe(stageRef.current!);
    return () => {
      observer.disconnect();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Redraw the paused frame whenever the edit changes.
  useEffect(() => {
    if (videoRef.current?.paused) draw();
  });

  useEffect(() => {
    const v = videoRef.current!;
    setPlaybackElement(v);
    playback.setState({ time: 0, playing: false });
    // With an effect to render, the canvas shows each frame. While playing,
    // frames come from our own WebCodecs decoder, driven by the
    // <video> clock (which also plays the audio): reading frames back from a
    // playing <video> returns a stale frame on some browsers and GPUs. Without
    // WebCodecs, the <video> is drawn on each presented frame, or on every
    // animation frame when frame callbacks stall.
    let decoder: PreviewDecoder | null = null;
    let live = true;
    void (async () => {
      try {
        const blob = await (await fetch(url)).blob();
        const media = await demux(blob);
        const made = await PreviewDecoder.create(media.video);
        if (!live) made?.dispose();
        else {
          decoder = made;
        }
      } catch {
        // No decoder: the <video> fallback below draws playback.
      }
    })();
    const decoding = () => !!decoder && !decoder.broken;
    let videoCallback = 0;
    let animationFrame = 0;
    let lastCallback = 0;
    let lastDrawn = -1;
    let lastFrame: VideoFrame | null = null;
    const drawCurrent = () => {
      draw();
      lastDrawn = v.currentTime;
    };
    const wrapTrim = () => {
      const e = editRef.current;
      if (v.currentTime >= e.trimEnd - 0.01) v.currentTime = e.trimStart;
    };
    let resync = true;
    const onVideoFrame = () => {
      lastCallback = performance.now();
      if (!nativeRef.current && !decoding()) {
        wrapTrim();
        drawCurrent();
      }
      if (!v.paused && v.requestVideoFrameCallback) videoCallback = v.requestVideoFrameCallback(onVideoFrame);
    };
    const onAnimationFrame = () => {
      if (v.paused) return;
      wrapTrim();
      if (nativeRef.current) {
        // The <video> is on screen; the decoder resyncs when an effect is added.
        resync = true;
      } else if (decoding()) {
        if (resync) {
          decoder!.seek(v.currentTime);
          lastFrame = null;
          resync = false;
        }
        const frame = decoder!.frameAt(v.currentTime);
        if (frame && frame !== lastFrame) {
          lastFrame = frame;
          drawDecoded(frame, decoder!.rotation);
        }
      } else if (performance.now() - lastCallback > 100 && v.currentTime !== lastDrawn) drawCurrent();
      if (Math.abs(playback.getState().time - v.currentTime) > 1 / 60) playback.setState({ time: v.currentTime });
      animationFrame = requestAnimationFrame(onAnimationFrame);
    };
    const onPlay = () => {
      const e = editRef.current;
      if (v.currentTime < e.trimStart || v.currentTime >= e.trimEnd - 0.01) v.currentTime = e.trimStart;
      playback.setState({ playing: true });
      cancelAnimationFrame(animationFrame);
      lastFrame = null;
      resync = true;
      if (v.requestVideoFrameCallback) {
        v.cancelVideoFrameCallback?.(videoCallback);
        videoCallback = v.requestVideoFrameCallback(onVideoFrame);
      }
      animationFrame = requestAnimationFrame(onAnimationFrame);
    };
    const onPause = () => {
      playback.setState({ playing: false, time: v.currentTime });
      drawCurrent();
    };
    const onSeeked = () => {
      playback.setState({ time: v.currentTime });
      draw();
    };
    const onLoaded = () => {
      v.currentTime = editRef.current.trimStart;
      draw();
    };
    const onError = () => toast("This browser can't play this video. You can still try exporting it.", "error");
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadeddata", onLoaded);
    v.addEventListener("error", onError);
    return () => {
      live = false;
      v.pause();
      v.cancelVideoFrameCallback?.(videoCallback);
      cancelAnimationFrame(animationFrame);
      decoder?.dispose();
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("error", onError);
      setPlaybackElement(null);
    };
  }, [url]);

  const trackRef = useRef<HTMLDivElement>(null);
  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };
  const scrub = (e: PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    videoRef.current?.pause();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
    const move = (ev: globalThis.PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dragHandle = (which: "start" | "end") => (e: PointerEvent) => {
    e.stopPropagation();
    videoRef.current?.pause();
    beginVideoGesture(which === "start" ? "Trim start" : "Trim end");
    const move = (ev: globalThis.PointerEvent | PointerEvent) => {
      const t = timeAt(ev.clientX);
      editVideo(which === "start" ? "Trim start" : "Trim end", (ed) =>
        which === "start" ? { ...ed, trimStart: Math.min(t, ed.trimEnd - 0.1) } : { ...ed, trimEnd: Math.max(t, ed.trimStart + 0.1) },
      );
      seek(t);
    };
    const up = () => {
      endVideoGesture();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e);
  };
  const nudge = (which: "start" | "end", delta: number) =>
    editVideo(which === "start" ? "Trim start" : "Trim end", (ed) =>
      which === "start" ? { ...ed, trimStart: Math.max(0, Math.min(ed.trimStart + delta, ed.trimEnd - 0.1)) } : { ...ed, trimEnd: Math.min(duration, Math.max(ed.trimEnd + delta, ed.trimStart + 0.1)) },
    );
  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;

  return (
    <div className="vid-player">
      <div className={native ? "vid-stage native" : "vid-stage"} ref={stageRef}>
        <video ref={videoRef} className="vid-source" src={url} muted={false} playsInline preload="auto" aria-hidden="true" tabIndex={-1} />
        <canvas ref={canvasRef} className="vid-canvas" onClick={togglePlay} />
        {error && <div className="develop-status error">{error}</div>}
      </div>
      <div className="vid-transport">
        <button type="button" className="btn small" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="num dim vid-time">
          {formatTime(time)} / {formatTime(duration)}
        </span>
        <span className="num faint">
          Selection {formatTime(edit.trimStart)}–{formatTime(edit.trimEnd)} · {(edit.trimEnd - edit.trimStart).toFixed(1)} s
        </span>
      </div>
      <div className="vid-timeline" ref={trackRef} onPointerDown={scrub} aria-label="Timeline">
        <div className="vid-strip" aria-hidden="true">
          {strip.map((u) => (
            <img key={u} src={u} alt="" draggable={false} />
          ))}
        </div>
        <div className="vid-dim" style={{ left: 0, width: pct(edit.trimStart) }} />
        <div className="vid-dim" style={{ left: pct(edit.trimEnd), right: 0 }} />
        <div className="vid-range" style={{ left: pct(edit.trimStart), width: pct(edit.trimEnd - edit.trimStart) }}>
          {(["start", "end"] as const).map((w) => (
            <span
              key={w}
              data-handle={w}
              className={`vid-handle ${w}`}
              role="slider"
              tabIndex={0}
              aria-label={w === "start" ? "Trim start" : "Trim end"}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration * 10) / 10}
              aria-valuenow={Math.round((w === "start" ? edit.trimStart : edit.trimEnd) * 10) / 10}
              onPointerDown={dragHandle(w)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                e.stopPropagation();
                nudge(w, (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
              }}
            />
          ))}
        </div>
        <div className="vid-playhead" style={{ left: pct(time) }} />
      </div>
    </div>
  );
}
