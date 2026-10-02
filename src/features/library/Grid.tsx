import { useVirtualizer } from "@tanstack/react-virtual";
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@/app/hooks";
import { domHits, useSweepSelect } from "@/components/sweep";
import { selectAsset, setQuery, ui } from "@/app/state";
import { catalog } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { Cell } from "./Cell";
import { assetMenu, sweepAssets } from "./commands";

export function Grid({ ids, stacks }: { ids: string[]; stacks: Map<string, { count: number; expanded: boolean }> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const thumbSize = useStore(ui, (s) => s.thumbSize);
  const selection = useStore(ui, (s) => s.selection);
  const activeId = useStore(ui, (s) => s.activeId);
  const gap = 6;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width - 16 + gap) / (thumbSize + gap)));
  const cellWidth = Math.floor((width - 16 - gap * (columns - 1)) / columns);
  const cellHeight = Math.round(cellWidth * 0.86) + 20;
  const rows = Math.ceil(ids.length / columns);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => cellHeight + gap,
    overscan: 4,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [cellHeight, virtualizer]);

  // Keep the active photo in view when it changes by keyboard or filmstrip.
  useEffect(() => {
    if (!activeId) return;
    const index = ids.indexOf(activeId);
    if (index >= 0) virtualizer.scrollToIndex(Math.floor(index / columns), { align: "auto" });
  }, [activeId, ids, columns, virtualizer]);

  const onPick = useCallback(
    (id: AssetId, e: MouseEvent) => {
      const mode = e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace";
      if (mode === "replace" && ui.getState().selection.has(id) && ui.getState().selection.size > 1) {
        // Keep a multi-selection when clicking inside it, so it can be dragged.
        ui.setState({ activeId: id });
        return;
      }
      selectAsset(id, mode, ids);
    },
    [ids],
  );
  const onOpen = useCallback((id: AssetId) => {
    selectAsset(id);
    ui.setState({ libraryView: "loupe" });
  }, []);
  const onMenu = useCallback(
    (id: AssetId, e: MouseEvent) => {
      if (!ui.getState().selection.has(id)) selectAsset(id, "replace", ids);
      assetMenu(e.clientX, e.clientY);
    },
    [ids],
  );
  // Right-click and hold, then drag: sweep a box over photos for batch actions.
  useSweepSelect(scrollRef, { ...sweepAssets, hits: (box) => domHits(scrollRef.current, box) });
  const onToggleStack = useCallback((stackId: string) => {
    const { expandedStacks } = ui.getState().query;
    setQuery({
      expandedStacks: expandedStacks.includes(stackId)
        ? expandedStacks.filter((s) => s !== stackId)
        : [...expandedStacks, stackId],
    });
  }, []);

  return (
    <div
      ref={scrollRef}
      className="grid-scroll"
      role="listbox"
      aria-label="Photos"
      aria-multiselectable
      tabIndex={-1}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) ui.setState({ selection: new Set() });
      }}
    >
      <div style={{ height: virtualizer.getTotalSize() + 8, position: "relative", marginTop: 8 }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div key={row.key} className="grid-row" style={{ top: row.start, height: cellHeight }}>
            {ids.slice(row.index * columns, row.index * columns + columns).map((id, i) => {
              const index = row.index * columns + i;
              return (
                <Cell
                  key={id}
                  id={id}
                  index={index}
                  width={cellWidth}
                  height={cellHeight}
                  selected={selection.has(id)}
                  active={activeId === id}
                  stackCount={stackCountFor(id, stacks)}
                  onPick={onPick}
                  onOpen={onOpen}
                  onMenu={onMenu}
                  onToggleStack={onToggleStack}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function stackCountFor(id: string, stacks: Map<string, { count: number }>) {
  const stackId = catalog.getState().assets.get(id)?.stackId;
  return stackId ? stacks.get(stackId)?.count : undefined;
}
