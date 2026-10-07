# The trailer

A 60-second cold open for the tutorial series, made from the app itself. It opens the
series before Chapter 1. Two cuts come out of one timeline: 16:9 (1920 × 1080) for
YouTube and the site, and 9:16 (1080 × 1920) for Reels, Shorts and TikTok.

| Time | Shot | Words |
| --- | --- | --- |
| 0–3 s | The flat photo wiped to the finished one | One photo. |
| 3–10 s | The sky's mask (red overlay), then only the sky changes | Edit only the sky. |
| 10–18 s | Remove Background, then the cutout moves between photos | Cut it out. Put it anywhere. |
| 18–24 s | The carousel swiped like a post, then seen whole | Ready to post. |
| 24–34 s | A grid of effects turns over, halftone fills the frame, snow falls | Make it move. |
| 34–44 s | The Video workspace's stutter and stare-down | W-W-W-WHAT |
| 44–52 s | A photo, a carousel and a video land one by one | Photos. Carousels. Video. |
| 52–60 s | The mark, the name and the call to action | In your browser. Nothing is uploaded. Start with Chapter 1. |

## Making it

```sh
npm run trailer:capture   # films the shots from the real app → trailer/shots/
npm run trailer:render    # renders trailer/out/trailer-16x9.mp4 and trailer-9x16.mp4
```

1. **Capture** (`capture.trailer.ts`) drives the app the way a person would. It imports
   the photos through Library, edits in Develop, draws the sky mask, runs Remove
   Background in Composite, applies effects, fills a carousel in Design, and cuts,
   stutters and stares down in Video. Each step is saved as a screenshot of the app, plus
   clean renders (the photo, the composition, every frame of the snow and of the video
   edit) for the close-ups.
2. **Compose** (`scenes.ts`) is the film as a pure function of time. `index.html` plays
   it live. Run `npm run dev` and open `/trailer/index.html` (`?v=vertical` for 9:16,
   `?t=24` to start at 24 s). Space plays and pauses, and the slider seeks.
3. **Render** (`render.trailer.ts`) steps the timeline 1/30 s at a time and encodes every
   frame. It uses H.264 when the browser can encode it (Chrome, Edge and Safari can). If it
   can't, and `TRAILER_H264_WASM` points to `h264-mp4-encoder.web.js` (from the MIT npm
   package `h264-mp4-encoder`, which is not a project dependency), it uses that encoder.
   Otherwise it writes VP9 in MP4. The log says which codec was used.

Other switches:

- `TRAILER_MOTION=reduced` renders the reduced-motion cut.
- `TRAILER_STILLS=1.5,12,40` writes PNG frames at those times instead of a video.
- `TRAILER_CUTS=9x16` renders one cut only.

The video is silent: add music in your editor. Cuts land on whole seconds, every two beats
at 120 BPM, so a 120 BPM track lines up with them.

## Your own media

Put your photos and clip in `trailer/kit/` (see its README) and run both steps again.
Without them, the capture draws stand-ins: a sunset lake, a striped balloon, dunes, and
a clip of the balloon rising. These keep the pipeline working, but they are placeholders,
not footage to publish.

## Motion design

The timing primitives come from [Motion](https://motion.dev) (MIT): cubic-bézier easing,
physical springs, stagger, and `animate` for live playback. The rules, which `scenes.ts`
spells out at the top:

- **Motion explains.** Every move shows what the app did. The wipe is the before/after.
  The sky's edit sweeps down like the gradient that made it. The cutout moves to show
  "anywhere". The swipe is a swipe. Each stutter repeat punches in its own syllable.
- **One set of physics.** Arrivals decelerate (expo-out). Departures are quicker and
  accelerate (expo-in). Everything that lands uses the same spring.
- **Hierarchy.** The picture moves first, the words follow, and the small workspace label
  comes last. One thing moves at a time.
- **Cheap to draw.** Only position, scale, rotation and opacity animate.
- **On the beat.** Cuts and landings fall on whole seconds.
- **Reduced motion.** Every move becomes a cross-fade at the same moment. The story is
  unchanged.
