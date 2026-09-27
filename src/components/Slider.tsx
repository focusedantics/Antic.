import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from "react";

export type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Double-click (label or track) resets to this value. */
  defaultValue: number;
  onChange: (value: number) => void;
  /** Called when a continuous gesture starts / ends, so it becomes one history step. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  format?: (value: number) => string;
  /** CSS background for the track, e.g. the temperature gradient. */
  track?: string;
  /** Where the fill starts from; defaults to the default value. */
  origin?: number;
  disabled?: boolean;
};

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));

export function formatSigned(value: number, step = 1) {
  const text = value.toFixed(decimals(step));
  return value > 0 ? `+${text}` : text === "-0" || Number(text) === 0 ? text.replace("-", "") : text;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  defaultValue,
  onChange,
  onGestureStart,
  onGestureEnd,
  format,
  track,
  origin,
  disabled,
}: SliderProps) {
  const id = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const quantize = (v: number) => {
    const q = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(q.toFixed(decimals(step) + 2))));
  };
  const fraction = (v: number) => (max === min ? 0 : (v - min) / (max - min));
  const display = format ? format(value) : formatSigned(value, step);
  const from = fraction(Math.min(max, Math.max(min, origin ?? defaultValue)));
  const at = fraction(value);

  const valueAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return quantize(min + ((clientX - rect.left) / rect.width) * (max - min));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    if (e.detail === 2) return; // double-click is handled below
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    onGestureStart?.();
    // Shift gives fine control: the drag moves at a tenth of the speed.
    const startX = e.clientX;
    const startValue = value;
    const fine = e.shiftKey;
    if (!fine) onChange(valueAt(e.clientX));
    const move = (ev: globalThis.PointerEvent) => {
      if (fine || ev.shiftKey) {
        const rect = trackRef.current!.getBoundingClientRect();
        onChange(quantize(startValue + ((ev.clientX - startX) / rect.width) * (max - min) * 0.1));
      } else onChange(valueAt(ev.clientX));
    };
    const target = e.currentTarget;
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      onGestureEnd?.();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const reset = () => {
    if (disabled) return;
    onGestureStart?.();
    onChange(defaultValue);
    onGestureEnd?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const big = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step * big;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step * big;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "Delete" || e.key === "Backspace") next = defaultValue;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onGestureStart?.();
    onChange(quantize(next));
    onGestureEnd?.();
  };

  const commitText = () => {
    if (editing === null) return;
    const parsed = Number.parseFloat(editing.replace(",", "."));
    setEditing(null);
    if (Number.isFinite(parsed)) {
      onGestureStart?.();
      onChange(quantize(parsed));
      onGestureEnd?.();
    }
  };

  return (
    <div className="slider" data-changed={value !== defaultValue}>
      <label htmlFor={id} onDoubleClick={reset} title="Double-click to reset">
        {label}
      </label>
      <div
        ref={trackRef}
        id={id}
        className="slider-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        aria-disabled={disabled}
        style={track ? ({ "--track": track } as React.CSSProperties) : undefined}
        onPointerDown={onPointerDown}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      >
        {!track && (
          <div
            className="slider-fill"
            style={{ left: `${Math.min(from, at) * 100}%`, width: `${Math.abs(at - from) * 100}%` }}
          />
        )}
        <div className="slider-thumb" style={{ left: `${at * 100}%` }} />
      </div>
      <input
        className="slider-value"
        aria-label={`${label} value`}
        value={editing ?? display}
        disabled={disabled}
        onFocus={(e) => {
          setEditing(String(value));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setEditing(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
