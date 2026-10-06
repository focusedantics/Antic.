import { useId } from "react";
import type { Gradient, Layer } from "@/core/document/model";
import { layerPaths } from "@/core/document/operations";
import { pathData, shapePaths } from "@/core/document/shapes";
import { shownText } from "@/core/text/draw";

/**
 * A quick SVG sketch of layers (templates, elements, text combos): shapes, paths, text,
 * frames and fills drawn by the browser, no GPU and no photos. Effects, adjustments,
 * masks and photos are left out or shown as placeholders; the real render is the
 * compositor's once the design is open.
 */
export function LayerSketch({ width, height, background, layers, className }: { width: number; height: number; background?: string | null; layers: readonly Layer[]; className?: string }) {
  const uid = useId().replace(/:/g, "");
  let gradients = 0;
  const defs: React.ReactNode[] = [];
  const paint = (g: Gradient | undefined, color: string | null | undefined): string | undefined => {
    if (!g) return color ?? undefined;
    const id = `${uid}g${gradients++}`;
    const rad = (g.angle * Math.PI) / 180;
    const stops = g.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />);
    defs.push(
      g.type === "radial" ? (
        <radialGradient key={id} id={id}>
          {stops}
        </radialGradient>
      ) : (
        <linearGradient key={id} id={id} x1={0.5 - Math.cos(rad) / 2} y1={0.5 - Math.sin(rad) / 2} x2={0.5 + Math.cos(rad) / 2} y2={0.5 + Math.sin(rad) / 2}>
          {stops}
        </linearGradient>
      ),
    );
    return `url(#${id})`;
  };
  let clips = 0;
  /** A clip path from a layer's outline (shapes, paths, frames, boxes). */
  const clipFrom = (l: Layer): string | null => {
    const t = l.transform;
    const box = `translate(${t.x} ${t.y}) rotate(${t.rotation}) scale(${t.flipX ? -1 : 1} ${t.flipY ? -1 : 1}) translate(${-t.width / 2} ${-t.height / 2})`;
    let shape: React.ReactNode = null;
    if (l.kind === "path") shape = <path transform={box} d={pathData(layerPaths(l), t.width, t.height, l.style.stroke !== null && l.style.strokeWidth > 0 ? l.style.strokeWidth / 2 : 0)} />;
    else if (l.kind === "slot") shape = <path transform={box} d={pathData(shapePaths(l.frame, t.width / Math.max(1e-6, t.height)), t.width, t.height)} />;
    else if (l.kind === "shape" && l.style.shape === "ellipse") shape = <ellipse transform={box} cx={t.width / 2} cy={t.height / 2} rx={t.width / 2} ry={t.height / 2} />;
    else if (l.kind !== "group") shape = <rect transform={box} width={t.width} height={t.height} />;
    if (!shape) return null;
    const id = `${uid}c${clips++}`;
    defs.push(
      <clipPath key={id} id={id}>
        {shape}
      </clipPath>,
    );
    return `url(#${id})`;
  };
  /** A list of layers, clipped layers drawn inside their base's outline. */
  const drawList = (list: readonly Layer[]): React.ReactNode[] => {
    let base: string | null = null;
    return list.map((l) => {
      if (!l.clip) {
        base = null;
        const node = draw(l);
        if (list.some((x) => x.clip)) base = clipFrom(l);
        return node;
      }
      return base ? (
        <g key={l.id} clipPath={base}>
          {draw(l)}
        </g>
      ) : (
        draw(l)
      );
    });
  };
  const draw = (l: Layer): React.ReactNode => {
    if (!l.visible) return null;
    const t = l.transform;
    const box = `translate(${t.x} ${t.y}) rotate(${t.rotation}) scale(${t.flipX ? -1 : 1} ${t.flipY ? -1 : 1}) translate(${-t.width / 2} ${-t.height / 2})`;
    const opacity = l.opacity;
    switch (l.kind) {
      case "group":
        return (
          <g key={l.id} opacity={opacity}>
            {drawList(l.children)}
          </g>
        );
      case "fill":
        return <rect key={l.id} x={0} y={0} width={width} height={height} fill={l.color} opacity={opacity * l.fillOpacity} />;
      case "gradient":
        return <rect key={l.id} transform={box} width={t.width} height={t.height} fill={paint(l.gradient, null)} opacity={opacity * l.fillOpacity} />;
      case "shape":
        return l.style.shape === "ellipse" ? (
          <ellipse key={l.id} transform={box} cx={t.width / 2} cy={t.height / 2} rx={t.width / 2} ry={t.height / 2} fill={l.style.fill} fillOpacity={l.style.fillOpacity} opacity={opacity} />
        ) : (
          <rect key={l.id} transform={box} width={t.width} height={t.height} rx={l.style.radius} fill={l.style.fill} fillOpacity={l.style.fillOpacity} opacity={opacity} />
        );
      case "path": {
        const s = l.style;
        const stroked = s.stroke !== null && s.strokeWidth > 0;
        return (
          <path
            key={l.id}
            transform={box}
            d={pathData(layerPaths(l), t.width, t.height, stroked ? s.strokeWidth / 2 : 0)}
            fill={s.fill === null ? "none" : paint(s.fillGradient, s.fill)}
            fillOpacity={s.fillOpacity * l.fillOpacity}
            fillRule={s.fillRule}
            stroke={stroked ? paint(s.strokeGradient, s.stroke) : "none"}
            strokeWidth={s.strokeWidth}
            strokeOpacity={s.strokeOpacity}
            strokeLinecap={s.cap}
            strokeLinejoin={s.join}
            strokeDasharray={s.dash.length ? s.dash.map((d) => d * s.strokeWidth).join(" ") : undefined}
            opacity={opacity}
          />
        );
      }
      case "slot":
        return <path key={l.id} transform={box} d={pathData(shapePaths(l.frame, t.width / Math.max(1e-6, t.height)), t.width, t.height)} fill={l.assetId ? "#8a8f98" : l.placeholder} opacity={opacity} />;
      case "image":
        return <rect key={l.id} transform={box} width={t.width} height={t.height} fill="#8a8f98" opacity={opacity} />;
      case "paint":
        return (
          <g key={l.id} transform={box} opacity={opacity}>
            {l.ops.map((op, i) =>
              op.type === "stroke" && op.brush !== "eraser" ? (
                <polyline
                  key={i}
                  points={Array.from({ length: Math.floor(op.points.length / 3) }, (_, k) => `${op.points[k * 3] * t.width},${op.points[k * 3 + 1] * t.height}`).join(" ")}
                  fill="none"
                  stroke={op.color}
                  strokeOpacity={op.opacity}
                  strokeWidth={op.size * t.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null,
            )}
          </g>
        );
      case "text": {
        const s = l.style;
        const lines = shownText(s).split("\n");
        const lh = s.size * s.lineHeight;
        const x = s.align === "left" ? 0 : s.align === "right" ? t.width : t.width / 2;
        const top = t.height / 2 - ((lines.length - 1) * lh) / 2;
        return (
          <g key={l.id} transform={box} opacity={opacity}>
            {s.highlight &&
              lines.map((_, i) => <rect key={`h${i}`} x={t.width * 0.05} y={top + i * lh - s.size * 0.6} width={t.width * 0.9} height={s.size * 1.2} rx={s.highlight!.radius * s.size} fill={s.highlight!.color} fillOpacity={s.highlight!.opacity} />)}
            {lines.map((line, i) => (
              <text
                key={i}
                x={x}
                y={top + i * lh}
                dominantBaseline="central"
                textAnchor={s.align === "left" ? "start" : s.align === "right" ? "end" : "middle"}
                fontFamily={s.font}
                fontWeight={s.weight}
                fontStyle={s.italic ? "italic" : undefined}
                fontSize={s.size}
                letterSpacing={s.letterSpacing * s.size}
                textDecoration={[s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || undefined}
                fill={paint(s.gradient, s.color)}
              >
                {line}
              </text>
            ))}
          </g>
        );
      }
      default:
        return null;
    }
  };
  const content = drawList(layers);
  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>{defs}</defs>
      {background && <rect width={width} height={height} fill={background} />}
      {content}
    </svg>
  );
}
