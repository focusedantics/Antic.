/** Small line icons for the phone dock and the panel toggles (inherit the text colour). */
export type IconName = "presets" | "edit" | "crop" | "masks" | "heal" | "folders" | "info" | "layers" | "documents" | "clips" | "panel-left" | "panel-right" | "panel-bottom" | "more" | "undo" | "redo" | "export" | "chevron" | "effects";

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
