import { type DragEvent, useState } from "react";
import { useStore } from "@/app/hooks";
import { openMenu } from "@/components/Menu";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { BLEND_MODES, type BlendMode, type Layer } from "@/core/document/model";
import {
  adjustmentLayer,
  duplicateLayer,
  emptyMask,
  fillLayer,
  gradientLayer,
  groupLayers,
  insertLayer,
  locate,
  moveLayer,
  removeLayers,
  shapeLayer,
  textLayer,
  ungroup,
  updateLayer,
  updateLayers,
} from "@/core/document/operations";
import { beginDocGesture, composite, editDocument, endDocGesture } from "@/core/document/session";
import { ui } from "@/app/state";
import { addAssetsToComposite } from "./actions";

const kindIcon: Record<Layer["kind"], string> = { image: "▣", fill: "■", gradient: "◐", text: "T", shape: "◆", adjustment: "◑", group: "▤" };

export function addLayer(kind: "fill" | "gradient" | "text" | "rectangle" | "ellipse" | "adjustment" | "group") {
  const { doc, selection } = composite.getState();
  if (!doc) return;
  const layer =
    kind === "fill"
      ? fillLayer(doc)
      : kind === "gradient"
        ? gradientLayer(doc)
        : kind === "text"
          ? textLayer(doc)
          : kind === "adjustment"
            ? adjustmentLayer(doc)
            : kind === "group"
              ? null
              : shapeLayer(doc, kind);
  if (kind === "group") {
    if (!selection.length) return;
    let id: string | null = null;
    editDocument("Group layers", (d) => {
      const r = groupLayers(d, selection);
      id = r.id;
      return r.doc;
    });
    if (id) composite.setState({ selection: [id] });
    return;
  }
  editDocument(`New ${layer!.name} layer`, (d) => insertLayer(d, layer!, selection.at(-1)));
  composite.setState({ selection: [layer!.id] });
}

export function addLayerMenu(x: number, y: number) {
  openMenu(x, y, [
    {
      label: "Photos from Library (selected)",
      disabled: ui.getState().selection.size === 0,
      onSelect: () => void addAssetsToComposite([...ui.getState().selection]),
    },
    "separator",
    { label: "Gradient", onSelect: () => addLayer("gradient") },
    { label: "Solid Color", onSelect: () => addLayer("fill") },
    { label: "Text", onSelect: () => addLayer("text") },
    { label: "Rectangle", onSelect: () => addLayer("rectangle") },
    { label: "Ellipse", onSelect: () => addLayer("ellipse") },
    { label: "Adjustment", onSelect: () => addLayer("adjustment") },
    "separator",
    { label: "Group selected layers", shortcut: "Ctrl+G", onSelect: () => addLayer("group") },
  ]);
}

export function deleteSelected() {
  const { selection } = composite.getState();
  if (!selection.length) return;
  editDocument(selection.length > 1 ? `Delete ${selection.length} layers` : "Delete layer", (d) => removeLayers(d, selection));
  composite.setState({ selection: [] });
}

export function duplicateSelected() {
  const { selection } = composite.getState();
  const ids: string[] = [];
  editDocument("Duplicate layer", (d) => {
    let next = d;
    for (const id of selection) {
      const r = duplicateLayer(next, id);
      next = r.doc;
      if (r.id) ids.push(r.id);
    }
    return next;
  });
  if (ids.length) composite.setState({ selection: ids });
}

function layerMenu(layer: Layer, x: number, y: number) {
  openMenu(x, y, [
    { label: "Duplicate", shortcut: "Ctrl+J", onSelect: duplicateSelected },
    { label: layer.clip ? "Release Clipping Mask" : "Create Clipping Mask", shortcut: "Ctrl+Alt+G", onSelect: () => editDocument("Clipping mask", (d) => updateLayer(d, layer.id, (l) => ({ ...l, clip: !l.clip }))) },
    { label: layer.mask ? "Delete Layer Mask" : "Add Layer Mask", onSelect: () => editDocument(layer.mask ? "Delete mask" : "Add mask", (d) => updateLayer(d, layer.id, (l) => ({ ...l, mask: l.mask ? null : emptyMask() }))) },
    ...(layer.kind === "group" ? [{ label: "Ungroup", shortcut: "Ctrl+Shift+G", onSelect: () => editDocument("Ungroup", (d) => ungroup(d, layer.id)) }] : []),
    "separator",
    { label: "Delete", shortcut: "Del", danger: true, onSelect: deleteSelected },
  ]);
}

function LayerRow({ layer, depth }: { layer: Layer; depth: number }) {
  const selected = useStore(composite, (s) => s.selection.includes(layer.id));
  const [over, setOver] = useState<"above" | "below" | "into" | null>(null);
  const select = (e: React.MouseEvent) => {
    const { selection } = composite.getState();
    if (e.metaKey || e.ctrlKey) composite.setState({ selection: selection.includes(layer.id) ? selection.filter((id) => id !== layer.id) : [...selection, layer.id] });
    else composite.setState({ selection: [layer.id] });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const dragged = e.dataTransfer.getData("application/x-focused-layer");
    const assets = e.dataTransfer.getData("application/x-focused-assets");
    if (assets) {
      composite.setState({ selection: [layer.id] });
      void addAssetsToComposite(ui.getState().selection.size ? [...ui.getState().selection] : [assets]);
      return;
    }
    if (!dragged || dragged === layer.id) return;
    editDocument("Move layer", (d) => {
      const target = locate(d.layers, layer.id);
      if (!target) return d;
      if (over === "into" && layer.kind === "group") return moveLayer(d, dragged, layer.id, layer.children.length);
      const parentId = target.parent?.id ?? null;
      // The list is shown top-first; "above" in the list means a higher index.
      const draggedLoc = locate(d.layers, dragged);
      const sameParentBelow = draggedLoc && (draggedLoc.parent?.id ?? null) === parentId && draggedLoc.index < target.index;
      const index = over === "above" ? target.index + 1 : target.index;
      return moveLayer(d, dragged, parentId, sameParentBelow ? index - 1 : index);
    });
  };
  return (
    <>
      <div
        className="layer-row"
        role="option"
        aria-selected={selected}
        data-drop={over ?? undefined}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-focused-layer", layer.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("application/x-focused-layer") && !e.dataTransfer.types.includes("application/x-focused-assets")) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - r.top) / r.height;
          setOver(layer.kind === "group" && y > 0.3 && y < 0.7 ? "into" : y < 0.5 ? "above" : "below");
        }}
        onDragLeave={() => setOver(null)}
        onDrop={onDrop}
        onMouseDown={select}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!composite.getState().selection.includes(layer.id)) composite.setState({ selection: [layer.id] });
          layerMenu(layer, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          className="btn ghost small icon"
          aria-label={layer.visible ? "Hide layer" : "Show layer"}
          aria-pressed={!layer.visible}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => editDocument(layer.visible ? "Hide layer" : "Show layer", (d) => updateLayer(d, layer.id, (l) => ({ ...l, visible: !l.visible })))}
        >
          {layer.visible ? "◉" : "○"}
        </button>
        {layer.kind === "group" && (
          <button type="button" className="btn ghost small icon" aria-label={layer.expanded ? "Collapse group" : "Expand group"} onMouseDown={(e) => e.stopPropagation()} onClick={() => editDocument("Toggle group", (d) => updateLayer(d, layer.id, (l) => ({ ...l, expanded: !(l as typeof layer).expanded })))}>
            {layer.expanded ? "▾" : "▸"}
          </button>
        )}
        {layer.clip && <span className="faint" title="Clipped to the layer below">↳</span>}
        <span className="layer-kind" aria-hidden>
          {kindIcon[layer.kind]}
        </span>
        <span
          className="name"
          onDoubleClick={() => {
            const name = prompt("Layer name", layer.name);
            if (name?.trim()) editDocument("Rename layer", (d) => updateLayer(d, layer.id, (l) => ({ ...l, name: name.trim() })));
          }}
        >
          {layer.name}
        </span>
        {layer.mask && <span className="badge" title="Has a layer mask">mask</span>}
        {layer.blend !== "normal" && <span className="faint" style={{ fontSize: 10 }}>{BLEND_MODES.find((b) => b.id === layer.blend)?.label}</span>}
        <button
          type="button"
          className="btn ghost small icon"
          aria-label={layer.locked ? "Unlock layer" : "Lock layer"}
          aria-pressed={layer.locked}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => editDocument(layer.locked ? "Unlock layer" : "Lock layer", (d) => updateLayer(d, layer.id, (l) => ({ ...l, locked: !l.locked })))}
          style={{ opacity: layer.locked ? 1 : 0.35 }}
        >
          {layer.locked ? "🔒" : "🔓"}
        </button>
      </div>
      {layer.kind === "group" && layer.expanded && [...layer.children].reverse().map((c) => <LayerRow key={c.id} layer={c} depth={depth + 1} />)}
    </>
  );
}

export function LayersPanel() {
  const doc = useStore(composite, (s) => s.doc);
  const selection = useStore(composite, (s) => s.selection);
  if (!doc) return null;
  const primary = selection.length ? locate(doc.layers, selection[selection.length - 1])?.layer : null;
  const setAll = (label: string, change: (l: Layer) => Layer) => editDocument(label, (d) => updateLayers(d, selection, change));
  return (
    <Panel
      id="cmp-layers"
      title="Layers"
      actions={
        <button type="button" className="btn small" onClick={(e) => addLayerMenu(e.clientX, e.clientY)}>
          + Add
        </button>
      }
    >
      {primary && (
        <div style={{ marginBottom: 8 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <select
              className="input"
              style={{ flex: 1 }}
              aria-label="Blend mode"
              value={primary.blend}
              onChange={(e) => setAll("Blend mode", (l) => ({ ...l, blend: e.target.value as BlendMode }))}
            >
              {BLEND_MODES.map((b, i) => (
                <option key={b.id} value={b.id} data-group={b.group} style={i && BLEND_MODES[i - 1].group !== b.group ? { borderTop: "1px solid #444" } : undefined}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <Slider
            label="Opacity"
            value={Math.round(primary.opacity * 100)}
            min={0}
            max={100}
            defaultValue={100}
            format={(v) => `${v}%`}
            onGestureStart={() => beginDocGesture("Opacity")}
            onGestureEnd={endDocGesture}
            onChange={(v) => setAll("Opacity", (l) => ({ ...l, opacity: v / 100 }))}
          />
          {primary.kind !== "adjustment" && primary.kind !== "group" && (
            <Slider
              label="Fill"
              value={Math.round(primary.fillOpacity * 100)}
              min={0}
              max={100}
              defaultValue={100}
              format={(v) => `${v}%`}
              onGestureStart={() => beginDocGesture("Fill opacity")}
              onGestureEnd={endDocGesture}
              onChange={(v) => setAll("Fill opacity", (l) => ({ ...l, fillOpacity: v / 100 }))}
            />
          )}
        </div>
      )}
      <div className="layer-list" role="listbox" aria-label="Layers" aria-multiselectable>
        {doc.layers.length === 0 && <p className="faint">Drag photos from the filmstrip onto the canvas, or add a layer.</p>}
        {[...doc.layers].reverse().map((l) => (
          <LayerRow key={l.id} layer={l} depth={0} />
        ))}
      </div>
      <p className="faint" style={{ fontSize: 10, marginTop: 6 }}>
        Right-click a layer for clipping masks, layer masks and grouping. Drag to reorder.
      </p>
    </Panel>
  );
}
