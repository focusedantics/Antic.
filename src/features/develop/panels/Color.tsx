import { type PointerEvent, useState } from "react";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { mixerColors } from "@/core/develop/params";
import type { ColorGrading, ColorMixer, GradeWheel } from "@/core/develop/recipe";
import { beginGesture, editRecipe, endGesture } from "@/core/develop/session";
import { clamp } from "@/lib/math";
import { useRecipe } from "../edit";

type MixerChannel = keyof ColorMixer;

function hueTrack(i: number, channel: MixerChannel) {
  const c = mixerColors[i].swatch;
  if (channel === "hue") {
    const prev = mixerColors[(i + 7) % 8].swatch;
    const next = mixerColors[(i + 1) % 8].swatch;
    return `linear-gradient(90deg, ${prev}, ${c} 50%, ${next})`;
  }
  if (channel === "saturation") return `linear-gradient(90deg, #7a7a7a, ${c})`;
  return `linear-gradient(90deg, #111, ${c} 50%, #eee)`;
}

export function ColorMixerControls() {
  const recipe = useRecipe();
  const [channel, setChannel] = useState<MixerChannel>("hue");
  if (!recipe) return null;
  const mixer = recipe.colorMixer;
  const set = (i: number, value: number) =>
    editRecipe(`${mixerColors[i].label} ${channel}`, (r) => ({
      ...r,
      colorMixer: { ...r.colorMixer, [channel]: r.colorMixer[channel].map((v, j) => (j === i ? value : v)) },
    }));
  return (
    <>
      <div className="segmented" style={{ marginBottom: 8 }} role="group" aria-label="Mixer channel">
        {(["hue", "saturation", "luminance"] as const).map((c) => (
          <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>
            {c[0].toUpperCase() + c.slice(1)}
          </button>
        ))}
      </div>
      {mixerColors.map((color, i) => (
        <Slider
          key={color.id}
          label={color.label}
          value={mixer[channel][i]}
          min={-100}
          max={100}
          defaultValue={0}
          track={hueTrack(i, channel)}
          onGestureStart={() => beginGesture(`${color.label} ${channel}`)}
          onGestureEnd={endGesture}
          onChange={(v) => set(i, v)}
        />
      ))}
    </>
  );
}

export const ColorMixerPanel = () => (
  <Panel id="dev-mixer" title="Color Mixer">
    <ColorMixerControls />
  </Panel>
);

function Wheel({ label, wheel, onChange }: { label: string; wheel: GradeWheel; onChange: (w: GradeWheel, label: string) => void }) {
  const size = 104;
  const r = size / 2 - 4;
  const angle = (wheel.hue * Math.PI) / 180;
  const puck = { x: size / 2 + Math.cos(angle) * r * (wheel.saturation / 100), y: size / 2 - Math.sin(angle) * r * (wheel.saturation / 100) };
  const update = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * size - size / 2;
    const y = size / 2 - ((e.clientY - rect.top) / rect.height) * size;
    const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    const saturation = clamp(Math.hypot(x, y) / r, 0, 1) * 100;
    onChange({ ...wheel, hue: Math.round(hue), saturation: Math.round(saturation) }, `${label} color`);
  };
  return (
    <div style={{ textAlign: "center" }}>
      <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>
        {label}
      </div>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        style={{ touchAction: "none", cursor: "crosshair" }}
        role="slider"
        aria-label={`${label} hue and saturation`}
        aria-valuetext={`hue ${wheel.hue}, saturation ${wheel.saturation}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          beginGesture(`${label} color`);
          update(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) update(e);
        }}
        onPointerUp={endGesture}
        onDoubleClick={() => onChange({ ...wheel, hue: 0, saturation: 0 }, `Reset ${label}`)}
      >
        <defs>
          <radialGradient id={`fade-${label}`}>
            <stop offset="0%" stopColor="#8a8a8a" />
            <stop offset="100%" stopColor="#8a8a8a" stopOpacity="0" />
          </radialGradient>
        </defs>
        <foreignObject x={4} y={4} width={size - 8} height={size - 8}>
          <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: "conic-gradient(from 90deg, #e04040, #d040d0, #4050e0, #40d0d0, #40d040, #d0d040, #e04040)" }} />
        </foreignObject>
        <circle cx={size / 2} cy={size / 2} r={r} fill={`url(#fade-${label})`} />
        <circle cx={puck.x} cy={puck.y} r={5} fill="none" stroke="#fff" strokeWidth={2} />
      </svg>
      <Slider
        label="Lum"
        value={wheel.luminance}
        min={-100}
        max={100}
        defaultValue={0}
        onGestureStart={() => beginGesture(`${label} luminance`)}
        onGestureEnd={endGesture}
        onChange={(v) => onChange({ ...wheel, luminance: v }, `${label} luminance`)}
      />
    </div>
  );
}

export function ColorGradingControls() {
  const recipe = useRecipe();
  if (!recipe) return null;
  const g = recipe.colorGrading;
  const set = (key: keyof ColorGrading, value: ColorGrading[keyof ColorGrading], label: string) =>
    editRecipe(label, (r) => ({ ...r, colorGrading: { ...r.colorGrading, [key]: value } }));
  return (
    <>
      <div className="grade-wheels" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Wheel label="Shadows" wheel={g.shadows} onChange={(w, l) => set("shadows", w, l)} />
        <Wheel label="Highlights" wheel={g.highlights} onChange={(w, l) => set("highlights", w, l)} />
        <Wheel label="Midtones" wheel={g.midtones} onChange={(w, l) => set("midtones", w, l)} />
        <Wheel label="Global" wheel={g.global} onChange={(w, l) => set("global", w, l)} />
      </div>
      <Slider label="Blending" value={g.blending} min={0} max={100} defaultValue={50} onGestureStart={() => beginGesture("Blending")} onGestureEnd={endGesture} onChange={(v) => set("blending", v, "Blending")} />
      <Slider label="Balance" value={g.balance} min={-100} max={100} defaultValue={0} onGestureStart={() => beginGesture("Balance")} onGestureEnd={endGesture} onChange={(v) => set("balance", v, "Balance")} />
    </>
  );
}

export const ColorGradingPanel = () => (
  <Panel id="dev-grading" title="Color Grading" defaultOpen={false}>
    <ColorGradingControls />
  </Panel>
);
