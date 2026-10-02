import type { Workspace } from "@/app/state";

/**
 * Where a step points. The first candidate that is on screen wins; when none
 * is (an empty library, a closed panel) the card sits in the middle instead.
 */
export type TourTarget = { readonly selector: string; readonly text?: string };

export type TourStep = {
  readonly chapter: number;
  readonly title: string;
  /** Plain text; `[[K]]` renders as a key cap. */
  readonly body: string;
  readonly workspace?: Workspace;
  readonly targets?: readonly TourTarget[];
};

export const CHAPTERS = ["Welcome", "Library", "Develop", "Masks & AI", "Composite", "Effects & animation", "Looks", "Video", "Export"] as const;

const sel = (...selectors: string[]): TourTarget[] => selectors.map((selector) => ({ selector }));
const button = (text: string, within = ".app"): TourTarget => ({ selector: `${within} button`, text });

/** The guided tour: the "Making the Focused Tutorial" chapters, condensed to cards. */
export const STEPS: readonly TourStep[] = [
  {
    chapter: 0,
    title: "Welcome to Focused",
    body: "A photo workstation that runs entirely in your browser. This tour takes about two minutes. Skip it now, or skip any chapter; replay it any time from the ? button in the top bar.",
  },
  {
    chapter: 1,
    workspace: "library",
    title: "Four workspaces",
    body: "One photo moves through Library → Develop → Composite. Clips go to Video. Jump with [[G]] [[D]] [[C]]. The glow behind the photo changes with each workspace.",
    targets: sel(".modules"),
  },
  {
    chapter: 1,
    workspace: "library",
    title: "Bring photos in",
    body: "Import… or Import Folder…, or drop files and folders on the window. Your photos stay on this computer and originals are never changed.",
    targets: sel(".topbar-right"),
  },
  {
    chapter: 1,
    workspace: "library",
    title: "Find the keepers",
    body: "Walk the grid with [[←]] [[→]]. [[E]] opens one big photo, [[G]] goes back. Rate [[1]]–[[5]], pick [[P]], reject [[X]], colour label [[6]]–[[9]]. [[Shift+C]] compares two, [[N]] surveys many. Right-click a photo for more; right-click and hold, then drag, to sweep-select many for batch delete or add.",
    targets: sel(".workspace .center"),
  },
  {
    chapter: 1,
    workspace: "library",
    title: "Collections and details",
    body: "Sources and collections on the left; metadata, keywords, captions and EXIF on the right. Search and filter by rating, flag, file type or camera from the bar above the grid.",
    targets: sel(".workspace .side.right", ".workspace .side.left"),
  },
  {
    chapter: 2,
    workspace: "develop",
    title: "Develop",
    body: "Edit panels on the right, top to bottom: white balance ([[W]] picks a neutral spot), then exposure, contrast, highlights and shadows. [[J]] shows clipping, [[\\]] flashes the before view, [[Y]] shows before and after side by side.",
    targets: sel(".workspace .side.right"),
  },
  {
    chapter: 2,
    workspace: "develop",
    title: "Crop, heal, undo",
    body: "[[R]] crops and straightens, [[Q]] removes spots. Every change lands in History on the left with snapshots and presets. [[Ctrl+Z]] undoes, [[Ctrl+Shift+V]] pastes settings onto another photo.",
    targets: sel(".workspace .side.left", ".workspace .center"),
  },
  {
    chapter: 3,
    workspace: "develop",
    title: "Masks",
    body: "A mask says where an edit applies. [[M]] opens Masks: Select Sky or Subject (the AI runs in your browser), [[B]] for a brush with Size and Feather ([[[]] [[]]]), gradients, and [[O]] for the red overlay. Remove Background cuts the subject out.",
    targets: sel(".workspace .side.right"),
  },
  {
    chapter: 4,
    workspace: "composite",
    title: "Composite",
    body: "Start from a selected photo, then drag more from the filmstrip onto the canvas. [[V]] moves, scales and rotates; hold [[Ctrl]] on a corner for perspective. Develop edits and cutouts come along.",
    targets: sel(".workspace .center"),
  },
  {
    chapter: 4,
    workspace: "composite",
    title: "Layers",
    body: "+ Layer adds gradients, adjustments and text (with animation). Each layer has opacity, a blend mode and an optional mask with its own brush Size and Feather. [[Ctrl+G]] groups, [[Ctrl+Alt+G]] clips.",
    targets: sel(".workspace .side.right"),
  },
  {
    chapter: 5,
    workspace: "composite",
    title: "Effects and animation",
    body: "[[Shift+E]] opens the effects browser with live previews of your own image. Effects arrive as layers you can blend. The Animated ones loop seamlessly and export as GIF or MP4.",
    targets: [button("✦ Effects", ".center"), ...sel(".workspace .center")],
  },
  {
    chapter: 6,
    workspace: "composite",
    title: "Looks",
    body: "Looks… saves the whole style (develop settings, masks, crop, layers) as a recipe. Apply it to many photos at once, or share it as a .focused file.",
    targets: [button("Looks…", ".center"), ...sel(".workspace .center")],
  },
  {
    chapter: 7,
    workspace: "video",
    title: "Video: the YTP editor",
    body: "Drop a clip to open it here. Scrub the ruler or waveform and hear the sound follow. [[Space]] plays, [[←]] [[→]] step a frame, [[J]] jumps back a second, [[+]] [[−]] [[0]] zoom the timeline.",
    targets: sel(".workspace .center"),
  },
  {
    chapter: 7,
    workspace: "video",
    title: "Cut and treat",
    body: "[[S]] splits at the playhead. Stack treatments on a piece: [[T]] stutter, [[R]] reverse, chipmunk, echo, deep fry… or let 🎲 Random poop do it. Export keeps every frame, lossless by default.",
    targets: sel(".workspace .side.right", ".workspace .center"),
  },
  {
    chapter: 8,
    workspace: "library",
    title: "Export",
    body: "[[Ctrl+Shift+E]] exports the selection: JPEG, PNG or WebP, with size, watermark and destination. Compositions also export as animated GIF or MP4.",
    targets: [button("Export…", ".center"), ...sel(".topbar-right")],
  },
  {
    chapter: 8,
    title: "You're set",
    body: "Replay this tour or jump to a chapter from the ? button. The ◐ button beside it turns the glow background off or on.",
    targets: sel(".topbar-tools"),
  },
];

/** First step of the chapter after the one `index` is in (or the end). */
export function nextChapterStart(index: number): number {
  const chapter = STEPS[index]?.chapter ?? Infinity;
  const next = STEPS.findIndex((s) => s.chapter > chapter);
  return next < 0 ? STEPS.length : next;
}

export const chapterStart = (chapter: number) => Math.max(0, STEPS.findIndex((s) => s.chapter === chapter));

/** Splits `[[key]]` markup into text and key-cap parts. */
export function parseBody(body: string): { text: string; key: boolean }[] {
  const out: { text: string; key: boolean }[] = [];
  const re = /\[\[(.+?)\]\](?!\])/g;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > last) out.push({ text: body.slice(last, m.index), key: false });
    out.push({ text: m[1], key: true });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), key: false });
  return out;
}
