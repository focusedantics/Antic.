import { useStore } from "@/app/hooks";
import { ui } from "@/app/state";
import { catalog, setFlag, setRating } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { formatExposure } from "./format";
import { Stars, Thumb } from "./Cell";

function Caption({ id }: { id: AssetId }) {
  const a = useStore(catalog, (s) => s.assets.get(id));
  if (!a) return null;
  const e = a.exif;
  return (
    <div className="loupe-info">
      <strong>{a.fileName}</strong>
      {a.width && a.height ? <span className="num"> · {a.width} × {a.height}</span> : null}
      <br />
      <span className="num">
        {[e.exposureTime && formatExposure(e.exposureTime), e.fNumber && `ƒ/${e.fNumber}`, e.iso && `ISO ${e.iso}`, e.focalLength && `${Math.round(e.focalLength)} mm`]
          .filter(Boolean)
          .join("  ")}
      </span>
    </div>
  );
}

export function LoupeView({ id }: { id: AssetId | null }) {
  if (!id) return <div className="empty-state">Select a photo.</div>;
  return (
    <div className="loupe" onDoubleClick={() => ui.setState({ libraryView: "grid" })}>
      <Thumb id={id} variant="preview" />
      <Caption id={id} />
    </div>
  );
}

export function CompareView({ selectId, candidateId }: { selectId: AssetId | null; candidateId: AssetId | null }) {
  if (!selectId || !candidateId || selectId === candidateId)
    return (
      <div className="empty-state">
        <h2>Compare</h2>
        <p>Select two photos (Ctrl/⌘-click) and press Shift+C, or pick “Compare these two” from the context menu.</p>
      </div>
    );
  const side = (id: AssetId, role: "select" | "candidate") => (
    <div className="loupe" data-role={role} onClick={() => ui.setState({ activeId: id })}>
      <Thumb id={id} variant="preview" />
      <Caption id={id} />
      <span className="compare-label">{role === "select" ? "Select" : "Candidate"}</span>
    </div>
  );
  return (
    <div className="compare">
      {side(selectId, "select")}
      {side(candidateId, "candidate")}
    </div>
  );
}

export function SurveyView({ ids }: { ids: AssetId[] }) {
  const activeId = useStore(ui, (s) => s.activeId);
  if (ids.length < 2)
    return (
      <div className="empty-state">
        <h2>Survey</h2>
        <p>Select several photos to review them side by side. Rate, flag and drop candidates until one remains.</p>
      </div>
    );
  const columns = Math.ceil(Math.sqrt(ids.length * 1.5));
  return (
    <div className="survey" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {ids.map((id) => (
        <SurveyItem key={id} id={id} active={id === activeId} />
      ))}
    </div>
  );
}

function SurveyItem({ id, active }: { id: AssetId; active: boolean }) {
  const a = useStore(catalog, (s) => s.assets.get(id));
  if (!a) return null;
  return (
    <div className="survey-item" data-active={active} onMouseDown={() => ui.setState({ activeId: id })}>
      <Thumb id={id} variant="preview" />
      <div className="survey-actions">
        <Stars rating={a.rating} />
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => setFlag([id], a.flag === "pick" ? null : "pick")}>
          {a.flag === "pick" ? "Picked" : "Pick"}
        </button>
        <button type="button" className="btn small" onClick={() => setRating([id], (a.rating % 5) + 1)}>
          ★
        </button>
        <button
          type="button"
          className="btn small"
          title="Remove from survey"
          onClick={() => {
            const selection = new Set(ui.getState().selection);
            selection.delete(id);
            ui.setState({ selection });
            if (active) ui.setState({ activeId: [...selection][0] ?? null });
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
