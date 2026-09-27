import { type ReactNode, useState } from "react";

const remembered = new Map<string, boolean>();
function initial(id: string, fallback: boolean) {
  if (remembered.has(id)) return remembered.get(id)!;
  try {
    const stored = localStorage.getItem(`panel:${id}`);
    if (stored !== null) return stored === "1";
  } catch {
    // Storage may be unavailable; fall back to the default.
  }
  return fallback;
}

/** Collapsible side-panel section. Open state is remembered per panel id. */
export function Panel({
  id,
  title,
  children,
  actions,
  defaultOpen = true,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(() => initial(id, defaultOpen));
  const toggle = () => {
    const next = !open;
    remembered.set(id, next);
    try {
      localStorage.setItem(`panel:${id}`, next ? "1" : "0");
    } catch {
      // Ignore: the panel still toggles for this session.
    }
    setOpen(next);
  };
  return (
    <section className="panel" data-open={open}>
      <div className="row">
        <button type="button" className="panel-head" aria-expanded={open} onClick={toggle}>
          <span className="chev" aria-hidden>
            ▾
          </span>
          {title}
        </button>
        {actions && open && <div className="panel-actions row" style={{ paddingRight: 8 }}>{actions}</div>}
      </div>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}
