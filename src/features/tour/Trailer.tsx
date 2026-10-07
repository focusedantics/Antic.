import { useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { layout } from "@/app/layout";
import { Dialog } from "@/components/Menu";
import { prefersReducedMotion } from "@/lib/pacing";

/**
 * The 60-second trailer (made in trailer/, see its README), played from the ? menu and,
 * on phones, the ⋯ menu. Computers get the 16:9 cut, phones the 9:16 one. The files are
 * static (public/trailer*.mp4) and load only when the player opens.
 */
export const trailer = createStore<{ open: boolean }>(() => ({ open: false }));
export const watchTrailer = () => trailer.setState({ open: true });
const close = () => trailer.setState({ open: false });

export function TrailerHost() {
  const open = useStore(trailer, (s) => s.open);
  return open ? <TrailerPlayer /> : null;
}

function TrailerPlayer() {
  const compact = useStore(layout, (s) => s.compact);
  const video = useRef<HTMLVideoElement>(null);
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = `${import.meta.env.BASE_URL}${compact ? "trailer-vertical.mp4" : "trailer.mp4"}`;
  const replay = () => {
    const v = video.current;
    if (!v) return;
    v.currentTime = 0;
    void v.play();
    setEnded(false);
  };
  return (
    <Dialog
      wide
      title="Focused in 60 seconds"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" disabled={failed} onClick={replay}>
            {ended ? "Watch again" : "Replay"}
          </button>
          <button type="button" className="btn primary" onClick={close}>
            Close
          </button>
        </>
      }
    >
      {failed ? (
        <p className="dim">The trailer couldn't be loaded. Check your connection and try again.</p>
      ) : (
        <video
          ref={video}
          className="trailer-video"
          data-vertical={compact || undefined}
          src={src}
          // It is silent; muted lets it start on its own, except with reduced motion asked for.
          muted
          playsInline
          controls
          autoPlay={!prefersReducedMotion()}
          preload="metadata"
          onPlay={() => setEnded(false)}
          onEnded={() => setEnded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </Dialog>
  );
}
