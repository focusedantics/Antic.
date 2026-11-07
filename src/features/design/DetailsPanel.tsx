import { useMemo } from "react";
import { useStore } from "@/app/hooks";
import { Panel } from "@/components/Panel";
import { composite, editDocument } from "@/core/document/session";
import { detailFields, fillDetail } from "./details";
import { textWidth } from "./insert";

/**
 * Fill in the details: every labelled text of the design (a template's title, date, place…)
 * as one form, so a poster is done without hunting for each layer. Words shrink to fit
 * their box when they run long. Hidden when the design has no labelled text.
 */
export function DetailsPanel() {
  // A signature of the fields, so the panel re-renders when they change and not on every edit.
  const signature = useStore(composite, (s) => JSON.stringify(detailFields(s.doc)));
  const fields = useMemo(() => JSON.parse(signature) as ReturnType<typeof detailFields>, [signature]);
  if (!fields.length) return null;
  return (
    <Panel id="design-details" title="Details">
      <p className="faint" style={{ margin: "0 0 8px" }}>
        Fill these in and the poster is done. Long words shrink to fit.
      </p>
      <div className="details-form">
        {fields.map((f) => (
          <label key={f.label} className="field">
            <span>{f.label}</span>
            <textarea
              className="input"
              rows={f.value.split("\n").length}
              value={f.value}
              // Shows which words these are on the canvas.
              onFocus={() => composite.setState({ selection: f.ids.slice(-1), tool: "move" })}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => editDocument(`Fill in ${f.label}`, (d) => fillDetail(d, f.label, e.target.value, textWidth))}
            />
          </label>
        ))}
      </div>
    </Panel>
  );
}
