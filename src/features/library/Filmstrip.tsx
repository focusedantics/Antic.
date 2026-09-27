import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { useStore } from "@/app/hooks";
import { selectAsset, ui } from "@/app/state";
import { catalog } from "@/core/catalog/store";
import { Thumb } from "./Cell";
import { assetMenu } from "./commands";
import { useResults } from "./results";

export function Filmstrip() {
  const { ids } = useResults();
  const activeId = useStore(ui, (s) => s.activeId);
  const selection = useStore(ui, (s) => s.selection);
  const source = useStore(ui, (s) => s.query.source);
  const collections = useStore(catalog, (s) => s.collections);
  const ref = useRef<HTMLDivElement>(null);
  const width = 88;
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: ids.length,
    getScrollElement: () => ref.current,
    estimateSize: () => width + 4,
    overscan: 8,
  });
  useEffect(() => {
    const index = activeId ? ids.indexOf(activeId) : -1;
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [activeId, ids, virtualizer]);

  const sourceName =
    source.kind === "all"
      ? "All Photographs"
      : source.kind === "recent"
        ? "Previous Import"
        : source.kind === "folder"
          ? source.path
          : (collections.get(source.id)?.name ?? "Collection");
  const index = activeId ? ids.indexOf(activeId) : -1;

  return (
    <div className="filmstrip" aria-label="Filmstrip">
      <div className="filmstrip-bar">
        <span>{sourceName}</span>
        <span className="num">
          {ids.length} photo{ids.length === 1 ? "" : "s"}
          {selection.size > 1 ? ` · ${selection.size} selected` : ""}
          {index >= 0 ? ` · #${index + 1}` : ""}
        </span>
        <span className="spacer" />
        <span className="faint">← → to move · 0–5 rate · P/X/U flag</span>
      </div>
      <div
        ref={ref}
        className="filmstrip-scroll"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) ref.current!.scrollLeft += e.deltaY;
        }}
      >
        <div style={{ width: virtualizer.getTotalSize(), height: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const id = ids[item.index];
            const flag = catalog.getState().assets.get(id)?.flag;
            return (
              <div
                key={id}
                className="film-cell"
                role="option"
                aria-selected={selection.has(id)}
                data-active={id === activeId}
                data-flag={flag ?? undefined}
                style={{ left: item.start + 4, width }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  selectAsset(id, e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace", ids);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!ui.getState().selection.has(id)) selectAsset(id, "replace", ids);
                  assetMenu(e.clientX, e.clientY);
                }}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-focused-assets", id)}
              >
                <Thumb id={id} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
