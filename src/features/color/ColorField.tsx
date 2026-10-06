import { type PointerEvent as ReactPointerEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "@/app/hooks";
import { layout } from "@/app/layout";
import { assetData, designAssets, loadDesignAssets, type PaletteData, saveDesignAsset } from "@/core/design/assets";
import { composite } from "@/core/document/session";
import { type HSV, hexToHsv, hsvToHex, hsvToRgb, normalizeHex, rgbToHex } from "@/lib/hsv";
import { pickColor } from "./eyedropper";
import { BUILT_IN_PALETTES, colorPrefs, documentColors, pushRecent } from "./palettes";

type Props = {
  /** Accessible name of the hex field (the swatch is "… picker"). */
  label: string;
  value: string;
  onChange: (hex: string) => void;
  /** Called around drags in the picker, so a drag is one undoable step. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  /** Only the swatch (no hex field), for tight rows. */
  swatchOnly?: boolean;
};

/**
 * A colour: a swatch that opens the picker (wheel, square or values, eyedropper and
 * palettes) and the hex code to type or paste.
 */
export function ColorField({ label, value, onChange, onGestureStart, onGestureEnd, swatchOnly }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => setText(value), [value]);
  return (
    <span className="color-field">
      <button ref={anchor} type="button" className="color-swatch" aria-label={`${label} picker`} aria-expanded={open} title={`${label}: ${value}`} style={{ background: value }} onClick={() => setOpen((o) => !o)} />
      {!swatchOnly && (
        <input
          className="input color-hex"
          aria-label={label}
          value={text}
          spellCheck={false}
          maxLength={7}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex && e.target.value.replace("#", "").length === 6) onChange(hex);
          }}
          onBlur={() => {
            const hex = normalizeHex(text);
            if (hex) {
              if (hex !== value) onChange(hex);
              pushRecent(hex);
            }
            setText(hex ?? value);
          }}
        />
      )}
      {open && <ColorPopover anchor={anchor} value={value} onChange={onChange} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} onClose={() => setOpen(false)} />}
    </span>
  );
}

type Mode = "wheel" | "square" | "values";
const MODE_KEY = "focused:color-mode";

function ColorPopover({ anchor, value, onChange, onGestureStart, onGestureEnd, onClose }: Omit<Props, "label" | "swatchOnly"> & { anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const compact = useStore(layout, (s) => s.compact);
  const [mode, setModeState] = useState<Mode>(() => {
    try {
      const m = localStorage.getItem(MODE_KEY);
      return m === "square" || m === "values" ? m : "wheel";
    } catch {
      return "wheel";
    }
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // A preference only.
    }
  };
  // HSV kept here so hue survives greys and black.
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setHsv(hexToHsv(value));
    }
  }, [value]);
  const emit = (next: HSV) => {
    setHsv(next);
    const hex = hsvToHex(next);
    last.current = hex;
    onChange(hex);
  };
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (compact || !anchor.current || !ref.current) return;
    const a = anchor.current.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    const below = a.bottom + 6 + p.height <= window.innerHeight - 8;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - p.width - 8, a.left)), top: below ? a.bottom + 6 : Math.max(8, a.top - 6 - p.height) });
  }, [compact, anchor, mode]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      pushRecent(last.current);
    };
  }, [anchor, onClose]);

  /** A drag on an area: one undoable step, `at` maps the pointer to a colour. */
  const drag = (e: ReactPointerEvent<HTMLElement>, at: (x: number, y: number, r: DOMRect) => HSV) => {
    e.preventDefault();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    onGestureStart?.();
    emit(at(e.clientX, e.clientY, r));
    const move = (ev: PointerEvent) => emit(at(ev.clientX, ev.clientY, r));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onGestureEnd?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const hueHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const rgb = hsvToRgb(hsv);

  const body = (
    <div
      ref={ref}
      className="color-popover"
      data-compact={compact || undefined}
      role="dialog"
      aria-label="Colour picker"
      style={compact ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
    >
      <div className="color-pop-head">
        <div className="segmented" role="group" aria-label="Picker">
          {(["wheel", "square", "values"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "wheel" ? "Wheel" : m === "square" ? "Square" : "Values"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn small"
          title="Pick a colour from the design"
          onClick={() => {
            onClose();
            void pickColor((hex) => {
              onChange(hex);
              pushRecent(hex);
            });
          }}
        >
          Eyedropper
        </button>
        <span className="color-now" style={{ background: hsvToHex(hsv) }} aria-hidden="true" />
      </div>
      {mode === "wheel" && (
        <div className="color-wheel-row">
          <div
            className="color-wheel"
            role="slider"
            aria-label="Hue and saturation"
            aria-valuetext={`hue ${Math.round(hsv.h)}°, saturation ${Math.round(hsv.s * 100)}%`}
            tabIndex={0}
            style={{ filter: `brightness(${0.25 + 0.75 * hsv.v})` }}
            onPointerDown={(e) =>
              drag(e, (x, y, r) => {
                const dx = x - (r.left + r.width / 2);
                const dy = y - (r.top + r.height / 2);
                const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
                return { ...hsv, h, s: clamp01(Math.hypot(dx, dy) / (r.width / 2)), v: hsv.v || 1 };
              })
            }
          >
            <span className="color-knob" style={{ left: `${50 + Math.sin((hsv.h * Math.PI) / 180) * hsv.s * 50}%`, top: `${50 - Math.cos((hsv.h * Math.PI) / 180) * hsv.s * 50}%`, background: hsvToHex(hsv) }} />
          </div>
          <div
            className="color-bar vertical"
            role="slider"
            aria-label="Brightness"
            aria-valuenow={Math.round(hsv.v * 100)}
            tabIndex={0}
            style={{ background: `linear-gradient(to bottom, ${hsvToHex({ ...hsv, v: 1 })}, #000)` }}
            onPointerDown={(e) => drag(e, (_x, y, r) => ({ ...hsv, v: clamp01(1 - (y - r.top) / r.height) }))}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") emit({ ...hsv, v: clamp01(hsv.v + (e.key === "ArrowUp" ? 0.02 : -0.02)) });
            }}
          >
            <span className="color-bar-knob" style={{ top: `${(1 - hsv.v) * 100}%` }} />
          </div>
        </div>
      )}
      {mode === "square" && (
        <>
          <div
            className="color-square"
            role="slider"
            aria-label="Saturation and brightness"
            aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
            tabIndex={0}
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})` }}
            onPointerDown={(e) => drag(e, (x, y, r) => ({ ...hsv, s: clamp01((x - r.left) / r.width), v: clamp01(1 - (y - r.top) / r.height) }))}
          >
            <span className="color-knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
          </div>
          <div
            className="color-bar hue"
            role="slider"
            aria-label="Hue"
            aria-valuenow={Math.round(hsv.h)}
            tabIndex={0}
            onPointerDown={(e) => drag(e, (x, _y, r) => ({ ...hsv, h: clamp01((x - r.left) / r.width) * 359.9 }))}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") emit({ ...hsv, h: (hsv.h + (e.key === "ArrowRight" ? 2 : -2) + 360) % 360 });
            }}
          >
            <span className="color-bar-knob horizontal" style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>
        </>
      )}
      {mode === "values" && (
        <div className="color-values">
          {(
            [
              ["R", Math.round(rgb.r), 255, (v: number) => emit(hexToHsv(rgbToHex({ ...rgb, r: v })))],
              ["G", Math.round(rgb.g), 255, (v: number) => emit(hexToHsv(rgbToHex({ ...rgb, g: v })))],
              ["B", Math.round(rgb.b), 255, (v: number) => emit(hexToHsv(rgbToHex({ ...rgb, b: v })))],
              ["H", Math.round(hsv.h), 359, (v: number) => emit({ ...hsv, h: v })],
              ["S", Math.round(hsv.s * 100), 100, (v: number) => emit({ ...hsv, s: v / 100 })],
              ["Br", Math.round(hsv.v * 100), 100, (v: number) => emit({ ...hsv, v: v / 100 })],
            ] as const
          ).map(([name, v, max, set]) => (
            <label key={name} className="field">
              <span>{name}</span>
              <input
                className="input num"
                type="number"
                min={0}
                max={max}
                value={v}
                aria-label={{ R: "Red", G: "Green", B: "Blue", H: "Hue", S: "Saturation", Br: "Brightness" }[name]}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) set(Math.max(0, Math.min(max, n)));
                }}
              />
            </label>
          ))}
        </div>
      )}
      <Swatches
        value={hsvToHex(hsv)}
        onPick={(hex) => {
          last.current = hex;
          setHsv(hexToHsv(hex));
          onChange(hex);
          pushRecent(hex);
        }}
      />
    </div>
  );
  return createPortal(body, document.body);
}

/** Recent colours, the design's colours and palettes (built in and mine). */
function Swatches({ value, onPick }: { value: string; onPick: (hex: string) => void }) {
  const recent = useStore(colorPrefs, (s) => s.recent);
  const chosen = useStore(colorPrefs, (s) => s.palette);
  const doc = useStore(composite, (s) => s.doc);
  const items = useStore(designAssets, (s) => s.items);
  useEffect(() => {
    void loadDesignAssets();
  }, []);
  const mine = useMemo(() => items.filter((a) => a.kind === "palette").map((a) => ({ id: a.id, name: a.name, colors: (assetData(a) as PaletteData | null)?.colors ?? [], mine: true })), [items]);
  const docColors = useMemo(() => documentColors(doc), [doc]);
  const palettes = [{ id: "doc", name: "This design", colors: docColors, mine: false }, { id: "recent", name: "Recent", colors: [...recent], mine: false }, ...mine, ...BUILT_IN_PALETTES.map((p) => ({ ...p, colors: [...p.colors], mine: false }))];
  const current = palettes.find((p) => p.id === chosen) ?? palettes[0];
  const select = useId();
  return (
    <div className="color-swatches">
      <div className="row">
        <label htmlFor={select} className="faint">
          Palette
        </label>
        <select id={select} className="input" value={current.id} onChange={(e) => colorPrefs.setState({ palette: e.target.value })}>
          {palettes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.mine ? " (mine)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn small"
          title={current.mine ? "Add this colour to the palette" : "Start a palette of your own with this colour"}
          onClick={async () => {
            if (current.mine) {
              const a = items.find((x) => x.id === current.id);
              if (a && !current.colors.includes(value)) await saveDesignAsset("palette", a.name, { colors: [...current.colors, value] }, { id: a.id });
            } else {
              const saved = await saveDesignAsset("palette", "My palette", { colors: [value] });
              colorPrefs.setState({ palette: saved.id });
            }
          }}
        >
          + Add
        </button>
      </div>
      <div className="swatch-grid" role="listbox" aria-label={`${current.name} colours`}>
        {current.colors.length ? (
          current.colors.map((c) => <button key={c} type="button" role="option" aria-selected={c === value} className="swatch" style={{ background: c }} title={c} aria-label={c} onClick={() => onPick(c)} />)
        ) : (
          <span className="faint">{current.id === "recent" ? "Colours you use appear here." : "No colours yet."}</span>
        )}
      </div>
    </div>
  );
}
