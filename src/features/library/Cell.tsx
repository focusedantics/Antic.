import { memo, type MouseEvent } from "react";
import { useStore } from "@/app/hooks";
import { useImageUrl } from "@/app/thumbs";
import { catalog } from "@/core/catalog/store";
import type { AssetId } from "@/core/catalog/types";
import { isEdited } from "@/core/catalog/query";

export const Stars = ({ rating }: { rating: number }) =>
  rating > 0 ? <span className="stars" aria-label={`${rating} stars`}>{"★".repeat(rating)}</span> : null;

export const Thumb = memo(function Thumb({ id, variant = "thumb" }: { id: AssetId; variant?: "thumb" | "preview" }) {
  const asset = useStore(catalog, (s) => s.assets.get(id));
  const url = useImageUrl(asset, variant);
  if (!asset) return null;
  if (asset.thumbState === "error")
    return (
      <span className="faint" title={asset.error} style={{ textAlign: "center", padding: 6 }}>
        No preview
      </span>
    );
  if (!url) return <div className="skeleton" />;
  return <img src={url} alt={asset.fileName} draggable={false} decoding="async" />;
});

type CellProps = {
  id: AssetId;
  index: number;
  width: number;
  height: number;
  selected: boolean;
  active: boolean;
  stackCount?: number;
  onPick: (id: AssetId, event: MouseEvent) => void;
  onOpen: (id: AssetId) => void;
  onMenu: (id: AssetId, event: MouseEvent) => void;
  onToggleStack?: (stackId: string) => void;
};

export const Cell = memo(function Cell({ id, index, width, height, selected, active, stackCount, onPick, onOpen, onMenu, onToggleStack }: CellProps) {
  const asset = useStore(catalog, (s) => s.assets.get(id));
  if (!asset) return null;
  return (
    <div
      className="cell"
      role="option"
      aria-selected={selected}
      data-active={active}
      data-flag={asset.flag ?? undefined}
      style={{ width, height }}
      onMouseDown={(e) => {
        if (e.button === 0) onPick(id, e);
      }}
      onDoubleClick={() => onOpen(id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(id, e);
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-focused-assets", id);
        e.dataTransfer.effectAllowed = "copyLink";
      }}
    >
      <span className="cell-index num" aria-hidden>
        {index + 1}
      </span>
      {stackCount && stackCount > 1 && asset.stackId && (
        <button
          type="button"
          className="badge stack-count"
          title="Expand or collapse stack"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onToggleStack?.(asset.stackId!)}
        >
          {stackCount}
        </button>
      )}
      <div className="cell-img">
        <Thumb id={id} />
      </div>
      <div className="cell-meta">
        {asset.flag && <span className={`flag-dot ${asset.flag}`} title={asset.flag === "pick" ? "Picked" : "Rejected"} />}
        <span className="name" title={asset.fileName}>
          {asset.fileName}
        </span>
        {isEdited(asset) && <span className="badge" title="Has develop settings">±</span>}
        <Stars rating={asset.rating} />
        {asset.label && <span className={`label-chip ${asset.label}`} />}
        <span className={`badge ${asset.kind === "raw" ? "raw" : ""}`}>{asset.kind === "raw" ? "RAW" : asset.kind.toUpperCase()}</span>
      </div>
    </div>
  );
});
