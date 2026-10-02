/** Small line icons for the phone dock and the panel toggles (inherit the text colour). */
export type IconName = "presets" | "edit" | "crop" | "masks" | "heal" | "folders" | "info" | "layers" | "documents" | "clips" | "panel-left" | "panel-right" | "panel-bottom" | "more" | "undo" | "redo" | "export" | "chevron" | "effects" | "split" | "duplicate" | "trash" | "play" | "pause" | "step-back" | "step-forward" | "move" | "brush" | "align" | "magnet" | "guides" | "fit" | "plus" | "animate" | "light" | "color" | "curve" | "mixer" | "grade" | "detail" | "optics" | "histogram";

const paths: Record<IconName, React.ReactNode> = {
  presets: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="2" />
      <path d="M6 6h12M8 3h8" />
    </>
  ),
  edit: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="currentColor" />
      <circle cx="15" cy="12" r="2" fill="currentColor" />
      <circle cx="7" cy="18" r="2" fill="currentColor" />
    </>
  ),
  crop: <path d="M7 2v15h15M2 7h15v15" />,
  masks: (
    <>
      <circle cx="12" cy="12" r="8" strokeDasharray="3 2.4" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  heal: (
    <>
      <rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-45 12 12)" />
      <path d="M10.5 12h.01M13.5 12h.01M12 10.5h.01M12 13.5h.01" strokeWidth="2.2" />
    </>
  ),
  folders: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  layers: <path d="M12 3 3 8l9 5 9-5zM3 13l9 5 9-5" />,
  documents: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  clips: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
    </>
  ),
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <rect x="3" y="4" width="6" height="16" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <rect x="15" y="4" width="6" height="16" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    </>
  ),
  "panel-bottom": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15h18" />
      <rect x="3" y="15" width="18" height="5" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    </>
  ),
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  export: (
    <>
      <path d="M12 15V3M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  effects: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  split: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.1 8.1 20 20M8.1 15.9 20 4" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </>
  ),
  "step-back": <path d="M6 5v14M18 5 9 12l9 7z" />,
  "step-forward": <path d="M18 5v14M6 5l9 7-9 7z" />,
  move: <path d="M12 3v18M3 12h18M12 3 9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
  brush: (
    <>
      <path d="M14.5 4.5 19.5 9.5 11 18l-5-5z" />
      <path d="M6 13c-2 1-2.5 3-2.5 5.5 2.5 0 4.5-.5 5.5-2.5" />
    </>
  ),
  align: (
    <>
      <path d="M4 3v18" />
      <rect x="7" y="6" width="12" height="4" rx="1" />
      <rect x="7" y="14" width="7" height="4" rx="1" />
    </>
  ),
  magnet: <path d="M6 3v8a6 6 0 0 0 12 0V3M6 7h4M14 7h4M10 3v8a2 2 0 0 0 4 0V3" />,
  guides: <path d="M3 8h18M3 16h18M8 3v18M16 3v18" />,
  fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  animate: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l6-3.5z" fill="currentColor" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
    </>
  ),
  color: <path d="M12 3.5s6.5 7 6.5 11a6.5 6.5 0 0 1-13 0c0-4 6.5-11 6.5-11z" />,
  curve: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M6 18c5 0 4-12 12-12" />
    </>
  ),
  mixer: (
    <>
      <circle cx="9" cy="9" r="5" />
      <circle cx="15" cy="9" r="5" />
      <circle cx="12" cy="14.5" r="5" />
    </>
  ),
  grade: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="15" cy="9.5" r="2" fill="currentColor" />
      <path d="M12 12l3-2.5" />
    </>
  ),
  detail: <path d="M12 4 21 19H3z" />,
  optics: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5 15 12M20.5 12 12 15M12 20.5 9 12M3.5 12 12 9" />
    </>
  ),
  histogram: <path d="M3 20h18M4 20c2-9 3-13 5-13s2 7 4 7 2-9 4-9 2.5 9 3 15" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
